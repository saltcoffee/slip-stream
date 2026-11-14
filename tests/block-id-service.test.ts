import { describe, expect, it } from "vitest";
import { citationFixture } from "./support/citations";

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

});
