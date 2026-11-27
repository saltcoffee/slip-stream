import { describe, expect, it } from "vitest";
import { citationFixture } from "./support/citations";
import { canonicalSelectionKey } from "../src/domain/citationTypes";
import { TFile } from "./support/obsidian";

const run = (f: ReturnType<typeof citationFixture>, span = f.intent().spans[0], allow = true) => f.sources.ensure(f.sources.capture(f.sourceFile as never, f.read()), [span], allow, () => false);
describe("BlockIdService", () => {
  it.each(["> [!note] Text\n> ```js\n> value\n> ```", "> First\n> Second", "- First\n- Second"])("writes structured markers outside the full block: %s", async (source) => {
    const f = citationFixture(source + "\n\nFollowing");
    const snapshot = f.sources.capture(f.sourceFile as never, f.read());
    const span = snapshot.spans.find((s) => s.kind === (source[0] === "-" ? "list" : source.includes("[!") ? "callout" : "blockquote"))!;
    const result = await f.sources.ensure(snapshot, [span], true, () => false);
    expect(result.kind).toBe("created");
    expect(f.read()).toContain(`${source}\n\n^${result.id}\n\n`);
    const second = await f.sources.ensure(snapshot, [span], true, () => false);
    expect(second.id).toBe(result.id);
    expect(f.written).toHaveBeenCalledTimes(1);
  });
  it("reuses short and standalone IDs with automatic generation disabled", async () => {
    for (const source of ["Paragraph ^a", "> Quotation\n\n^b\n"]) {
      const f = citationFixture(source);
      const snapshot = f.sources.capture(f.sourceFile as never, source);
      const result = await f.sources.ensure(snapshot, [snapshot.spans[0]], false, () => false);
      expect(result.kind).toBe("reused"); expect(f.read()).toBe(source);
    }
  });
  it("does not write at stale line numbers, even for a matching old paragraph", async () => {
    const f = citationFixture("Paragraph A\n\nParagraph B");
    const original = f.intent(); f.write("New\n\n" + f.read());
    await expect(f.sources.ensure(original.snapshot, original.spans, true, () => false)).rejects.toThrow("SOURCE_STALE");
    expect(f.process).not.toHaveBeenCalled();
  });
  it("revalidates the complete file inside process", async () => {
    const f = citationFixture(); const intent = f.intent();
    f.process.mockImplementationOnce(async (_file, update) => { f.write("External\n\n" + f.read()); f.write(update(f.read())); return f.read(); });
    await expect(f.sources.ensure(intent.snapshot, intent.spans, true, () => false)).rejects.toThrow();
    expect(f.read()).not.toContain("^");
  });
  it.each(["- Parent\n  - Child", "- Parent\n\n  Continuation", "- ```js\n  value\n  ```"])("does not add a marker to a complex item %s", async (source) => {
    const f = citationFixture(source); const snapshot = f.sources.capture(f.sourceFile as never, source);
    const result = await f.sources.ensure(snapshot, [snapshot.spans[0]], true, () => false);
    expect(result.kind).toBe("unavailable"); expect(f.read()).toBe(source);
  });
  it("preserves CRLF and trailing whitespace", async () => {
    const source = "First  \r\nSecond  "; const f = citationFixture(source);
    const result = await run(f);
    expect(f.read()).toBe(`${source} ^${result.id}`);
  });
  it("recognizes a write that succeeded before the host threw", async () => {
    const f = citationFixture();
    f.process.mockImplementationOnce(async (_file, update) => { f.write(update(f.read())); throw new Error("after write"); });
    expect((await run(f)).kind).toBe("created");
  });
  it("uses an open editor rather than overwriting its unsaved buffer", async () => {
    const f = citationFixture();
    f.editors.writeSource.mockImplementationOnce((_ref, baseline, range, text) => { f.write(baseline.slice(0, range.from) + text + baseline.slice(range.to)); return true; });
    expect((await run(f)).kind).toBe("created"); expect(f.process).not.toHaveBeenCalled();
  });
  it("serializes writes and remaps only its own exact edits for different blocks", async () => {
    const f = citationFixture("First\n\nSecond"); const snap = f.intent().snapshot;
    const results = await Promise.all(snap.spans.map((span) => f.sources.ensure(snap, [span], true, () => false)));
    expect(results.map((r) => r.kind)).toEqual(["created", "created"]);
    expect(f.read().match(/\^[a-z0-9]{6}/g)).toHaveLength(2);
  });
  it("does not append a second marker when the existing identifier is ambiguous", async () => {
    const f = citationFixture("First ^a\n\nSecond ^a");
    const intent = f.intent(); const result = await f.sources.ensure(intent.snapshot, intent.spans, true, () => false);
    expect(result.kind).toBe("unavailable"); expect(f.process).not.toHaveBeenCalled();
  });
  it("reuses a metadata-verified list continuation ID and strips only that marker", async () => {
    const source = "- Parent\n\n  Continued ^old"; const f = citationFixture(source);
    f.app.metadataCache.getFileCache = () => ({ blocks: { old: { id: "old", position: { start: { line: 0, offset: 0 } } } } }) as never;
    const snapshot = f.sources.capture(f.sourceFile as never, source);
    const result = await f.sources.ensure(snapshot, [snapshot.spans[0]], true, () => false);
    expect(result).toMatchObject({ kind: "reused", id: "old" });
    expect(f.sources.content(snapshot.spans[0])).toBe("- Parent\n\n  Continued");
    expect(f.process).not.toHaveBeenCalled();
  });

  it("does not reuse the first list item's ID as the ID of the whole list", async () => {
    const source = "- First ^item\n- Second";
    const f = citationFixture(source);
    f.app.metadataCache.getFileCache = () => ({ blocks: { item: { id: "item", position: { start: { line: 0, offset: 0 } } } } }) as never;
    const snapshot = f.sources.capture(f.sourceFile as never, source);
    const list = snapshot.spans.find((span) => span.kind === "list")!;
    expect(list.existingBlockId).toBeUndefined();
    const result = await f.sources.ensure(snapshot, [list], true, () => false);
    expect(result.kind).toBe("created"); expect(result.id).not.toBe("item");
    expect(f.read()).toContain(`- First ^item\n- Second\n\n^${result.id}`);
  });

  it("plans multiple blocks read-only, reuses IDs for same block, and writes once per source in ensurePlanned", async () => {
    const source = "First paragraph\n\nSecond paragraph\n\nThird paragraph";
    const f = citationFixture(source);
    const snap = f.sources.capture(f.sourceFile as never, source);
    const [p1, p2, p3] = snap.spans;

    const plans = await f.sources.prepareMany([
      { itemId: "i1", snapshot: snap, spans: [p1], allowNew: true },
      { itemId: "i2", snapshot: snap, spans: [p1], allowNew: true },
      { itemId: "i3", snapshot: snap, spans: [p2], allowNew: true },
      { itemId: "i4", snapshot: snap, spans: [p3], allowNew: false },
    ]);

    // Preview phase must never mutate the source.
    expect(f.read()).toBe(source);
    expect(f.process).not.toHaveBeenCalled();
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.items[0].id).toBe(plan.items[1].id);
    expect(plan.items[0].kind).toBe("planned");
    expect(plan.items[2].kind).toBe("planned");
    expect(plan.items[2].id).not.toBe(plan.items[0].id);
    expect(plan.items[3].kind).toBe("unavailable");
    expect(plan.items[3].id).toBeUndefined();

    const applied = await f.sources.ensurePlanned(plan, () => false);
    expect(applied.editsApplied).toBe(2);
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.read()).toBe(plan.expectedAfter);
    expect(f.sources.matchesPlannedResult(plan, f.read())).toBe(true);
    // Live snapshot should have been remapped cleanly so inspect passes on the updated text.
    const reinspected = await f.sources.inspect(snap, [p2]);
    expect(reinspected.id).toBe(plan.items[2].id);
  });

  it("handles co-located list and last list_item anchor edits without corrupting IDs", async () => {
    const source = "- First\n- Second";
    const f = citationFixture(source);
    const snap = f.sources.capture(f.sourceFile as never, source);
    const listSpan = snap.spans.find((s) => s.kind === "list")!;
    const secondItem = snap.spans.filter((s) => s.kind === "list_item")[1];
    const [plan] = await f.sources.prepareMany([
      { itemId: "item", snapshot: snap, spans: [secondItem], allowNew: true },
      { itemId: "list", snapshot: snap, spans: [listSpan], allowNew: true },
    ]);
    const applied = await f.sources.ensurePlanned(plan, () => false);
    expect(applied.editsApplied).toBe(2);
    const itemId = plan.items.find((i) => i.itemId === "item")!.id!;
    const listId = plan.items.find((i) => i.itemId === "list")!.id!;
    expect(f.read()).toBe(`- First\n- Second ^${itemId}\n\n^${listId}\n\n`);
  });

  it("predicts self-target conflicts and safe offset shifts (AC-40)", () => {
    const source = "Intro\n\n> Quoted block\n\n^q1\n\nTail paragraph ^t1";
    const f = citationFixture(source);
    const snap = f.sources.capture(f.sourceFile as never, source);
    const quote = snap.spans.find((s) => s.kind === "blockquote")!;
    const tail = snap.spans.find((s) => s.kind === "paragraph" && s.existingBlockId === "t1")!;

    // Safe insertion at the very beginning shifts both blocks cleanly.
    const safe = f.sources.predictSelfTarget({
      baselineText: source,
      bodyStart: snap.bodyStart,
      ticketRange: { from: 0, to: 0 },
      compiledMarkdown: "> Inserted\n> — [[Sources/Note.md#^q1]]",
      items: [
        { itemId: "q", spans: [quote], expectedBlockId: "q1", precision: "block" },
        { itemId: "t", spans: [tail], expectedBlockId: "t1", precision: "block" },
      ],
    });
    expect(safe.conflicts).toEqual([]);
    const mappedTail = safe.mappings.get("t")!.mappedSpans[0];
    expect(safe.predictedText.slice(mappedTail.range.from, mappedTail.range.to)).toBe(tail.rawText);

    // Replacing over the tail block conflicts.
    const overwrite = f.sources.predictSelfTarget({
      baselineText: source,
      bodyStart: snap.bodyStart,
      ticketRange: tail.rawRange,
      compiledMarkdown: "Replaced",
      items: [{ itemId: "t", spans: [tail], expectedBlockId: "t1", precision: "block" }],
    });
    expect(overwrite.conflicts).toEqual([expect.objectContaining({ code: "SELF_SOURCE_CONFLICT", itemId: "t" })]);

    // Inserting right between the blockquote and its standalone ^q1 detaches the anchor.
    const splitAnchor = f.sources.predictSelfTarget({
      baselineText: source,
      bodyStart: snap.bodyStart,
      ticketRange: { from: quote.rawRange.to + 1, to: quote.rawRange.to + 1 },
      compiledMarkdown: "Inserted between block and ID",
      items: [{ itemId: "q", spans: [quote], expectedBlockId: "q1", precision: "block" }],
    });
    expect(splitAnchor.conflicts).toEqual([expect.objectContaining({ code: "SELF_SOURCE_CONFLICT", itemId: "q" })]);
  });

  it("ensurePlanned and verifyPlanned detect external modification, rename, and missing source as SOURCE_STALE", async () => {
    const f = citationFixture("First paragraph\n\nSecond paragraph");
    const snap = f.sources.capture(f.sourceFile as never, f.read());
    const [plan] = await f.sources.prepareMany([
      { itemId: "i1", snapshot: snap, spans: [snap.spans[0]], allowNew: true },
    ]);

    // Rename before ensurePlanned -> SOURCE_STALE without writing.
    const origPath = f.editors.path;
    f.editors.path = () => "Sources/Renamed.md";
    await expect(f.sources.ensurePlanned(plan, () => false)).rejects.toThrow("SOURCE_STALE");
    expect(f.process).not.toHaveBeenCalled();

    // Restore path, apply planned IDs, verifyPlanned passes.
    f.editors.path = origPath;
    await f.sources.ensurePlanned(plan, () => false);
    await expect(f.sources.verifyPlanned(plan)).resolves.toBeUndefined();

    // External modification after ensurePlanned -> verifyPlanned throws SOURCE_STALE.
    const afterPlanned = f.read();
    f.write(afterPlanned + "\nExternal edit");
    await expect(f.sources.verifyPlanned(plan)).rejects.toThrow("SOURCE_STALE");

    // Rename after ensurePlanned -> verifyPlanned throws SOURCE_STALE.
    f.write(afterPlanned);
    f.editors.path = () => "Sources/Renamed.md";
    await expect(f.sources.verifyPlanned(plan)).rejects.toThrow("SOURCE_STALE");

    // Missing source -> verifyPlanned throws SOURCE_STALE.
    f.editors.path = origPath;
    f.files.splice(f.files.indexOf(f.sourceFile), 1);
    await expect(f.sources.verifyPlanned(plan)).rejects.toThrow("SOURCE_STALE");
  });

  it("canonicalSelectionKey normalizes and merges ranges relative to spans[0].rawRange.from", () => {
    const f = citationFixture("Intro\n\nFirst paragraph here");
    const snap = f.sources.capture(f.sourceFile as never, f.read());
    const second = snap.spans[1];
    expect(second.rawRange.from).toBe(7);
    expect(
      canonicalSelectionKey([second], [
        { from: 37, to: 52 },
        { from: 12, to: 20 },
        { from: 18, to: 27 },
      ]),
    ).toBe("5-20,30-45");
    expect(canonicalSelectionKey([], [{ from: 0, to: 5 }])).toBeUndefined();
    expect(canonicalSelectionKey([second], undefined)).toBeUndefined();
    expect(canonicalSelectionKey([second], [])).toBeUndefined();
    expect(canonicalSelectionKey([second], [{ from: 10, to: 10 }])).toBeUndefined();
  });

});
