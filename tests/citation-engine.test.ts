import { describe, expect, it, vi } from "vitest";
import { citationFixture } from "./support/citations";
import { CitationError, localDate } from "../src/domain/citationTypes";
import type { PreparedEvidenceInput } from "../src/domain/citationTypes";
import { buildOutlineLayout } from "../src/domain/CitationDocument";
import { insertionPlan } from "../src/infra/EditorGateway";
import { emptyOutline } from "../src/domain/outlineTypes";
import type { DeskV3 } from "../src/domain/deskTypes";
import { TFile } from "./support/obsidian";

describe("CitationEngine", () => {
  it("isolates duplicate reminders by target and allows a single explicit authorization", async () => {
    const f = citationFixture();
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("a") })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("b") })).effect).toBe("inserted");
    const again = f.intent({ templateId: "B" }); const ticket = f.ticket("a");
    const duplicate = await f.engine.execute(again, { ticket });
    expect(duplicate.code).toBe("DUPLICATE"); expect(f.editors.commit).toHaveBeenCalledTimes(2);
    expect((await f.engine.execute(again, { ticket, duplicateAuthorization: duplicate.duplicateAuthorization })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("a") })).code).toBe("DUPLICATE");
  });
  it("does not reserve insertion dedupe for copies, including when history is disabled", async () => {
    const f = citationFixture(); f.store.data.settings.historyEnabled = false;
    expect((await f.engine.execute(f.intent({ action: "copy" }))).effect).toBe("copied");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).code).toBe("DUPLICATE");
    expect(f.store.data.history).toHaveLength(0); expect(f.store.data.relations).toHaveLength(0);
  });
  it("stops stale and deleted sources without any source or target write", async () => {
    const f = citationFixture(); const intent = f.intent(); f.write("New\n\nOriginal paragraph");
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).code).toBe("SOURCE_STALE");
    f.files.splice(f.files.indexOf(f.sourceFile), 1);
    expect((await f.engine.execute(intent, { ticket: f.ticket(), staleSnapshot: true, fallback: "file" })).code).toBe("SOURCE_MISSING");
    expect(f.process).not.toHaveBeenCalled(); expect(f.editors.commit).not.toHaveBeenCalled();
  });
  it("records an explicitly accepted stale fragment as a file-level snapshot", async () => {
    const f = citationFixture(); const intent = f.intent(); f.write("Updated source");
    const result = await f.engine.execute(intent, { ticket: f.ticket(), staleSnapshot: true, fallback: "file" });
    expect(result).toMatchObject({ effect: "inserted", precision: "file", sourceAnchor: "unchanged" });
    expect(f.store.data.relations[0]).toMatchObject({ content: "Original paragraph", sourceState: "stale-snapshot" });
    expect(f.process).not.toHaveBeenCalled();
  });
  it("does not write source IDs while waiting for first-use consent", async () => {
    const f = citationFixture(); f.store.data.consent.blockIdExplanationAccepted = false;
    const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).code).toBe("CONSENT_REQUIRED");
    expect(f.process).not.toHaveBeenCalled();
    await f.store.acceptBlockIds();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).effect).toBe("inserted");
  });
  it("rejects an incompatible C or invalid D before creating source IDs", async () => {
    const f = citationFixture();
    expect((await f.engine.execute(f.intent({ templateId: "C", mode: "selection", content: "Original" }), { ticket: f.ticket() })).code).toBe("TEMPLATE_REQUIRES_BLOCK");
    expect((await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{unknown}}" }), { ticket: f.ticket() })).code).toBe("TEMPLATE_INVALID");
    expect((await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{content}}" }), { ticket: f.ticket() })).code).toBe("LINK_INVALID");
    expect(f.process).not.toHaveBeenCalled();
  });
  it("requires an explicit self-target fallback and never generates an ID", async () => {
    const f = citationFixture(); const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket("src") })).code).toBe("ANCHOR_WRITE_FAILED");
    expect((await f.engine.execute(intent, { ticket: f.ticket("src"), fallback: "file" })).effect).toBe("inserted");
    expect(f.process).not.toHaveBeenCalled();
  });
  it("clipboard rejection creates neither successful history nor dedupe", async () => {
    const f = citationFixture(); f.editors.copy.mockRejectedValueOnce(new CitationError("CLIPBOARD_DENIED"));
    const failed = await f.engine.execute(f.intent({ action: "copy" }));
    expect(failed).toMatchObject({ effect: "none", status: "partial", sourceAnchor: "created", code: "CLIPBOARD_DENIED" });
    expect(f.store.data.history).toHaveLength(0);
    expect((await f.engine.execute(f.intent({ action: "copy" }))).effect).toBe("copied");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).effect).toBe("inserted");
    expect(f.store.data.history.map((h) => h.action)).toEqual(["insert", "copy"]);
    expect(f.store.data.history[1].targetPath).toBeUndefined();
  });
  it("retains inserted dedupe and retries only records after persistence failure", async () => {
    const f = citationFixture(); f.save.mockRejectedValueOnce(new Error("Disk full"));
    const intent = f.intent();
    const result = await f.engine.execute(intent, { ticket: f.ticket() });
    expect(result).toMatchObject({ effect: "inserted", status: "partial", recording: "pending", code: "RECORD_SAVE_FAILED" });
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).code).toBe("DUPLICATE");
    expect(await f.records.retry(intent.operationId)).toBe("saved");
    await f.engine.execute(intent, { ticket: f.ticket() });
    expect(f.editors.commit).toHaveBeenCalledTimes(1); expect(f.store.data.relations).toHaveLength(1);
  });
  it("rechecks the target after awaited source reads and reports retained source IDs", async () => {
    const f = citationFixture(); const intent = f.intent(); const ticket = f.ticket();
    f.process.mockImplementationOnce(async (_file, update) => { f.write(update(f.read())); f.bodies.a = "Changed during anchor write"; return f.read(); });
    const result = await f.engine.execute(intent, { ticket });
    expect(result).toMatchObject({ sourceAnchor: "created", effect: "none", code: "TARGET_STALE", status: "partial" });
    expect(f.editors.commit).not.toHaveBeenCalled();
  });
  it("does not commit after Escape even if an ID was already written", async () => {
    const f = citationFixture(); const abort = new AbortController();
    f.process.mockImplementationOnce(async (_file, update) => { f.write(update(f.read())); abort.abort(); return f.read(); });
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket(), signal: abort.signal });
    expect(result).toMatchObject({ effect: "none", sourceAnchor: "created", code: "OPERATION_CANCELLED" });
    expect(f.editors.commit).not.toHaveBeenCalled(); expect(f.store.data.history).toHaveLength(0);
  });
  it("coalesces double-click and same-fragment concurrent submissions", async () => {
    const f = citationFixture(); const intent = f.intent(); const options = { ticket: f.ticket() };
    const one = f.engine.execute(intent, options);
    expect(f.engine.execute(intent, options)).toBe(one);
    expect(f.engine.execute({ ...intent, operationId: crypto.randomUUID() }, options)).toBe(one);
    await one; expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });
  it("queues different fragments on one target and rejects the expired second ticket", async () => {
    const f = citationFixture("First\n\nSecond"); const one = f.intent(); const second = one.snapshot.spans[1];
    const results = await Promise.all([f.engine.execute(one, { ticket: f.ticket() }), f.engine.execute(f.intent({ spans: [second], content: "Second" }), { ticket: f.ticket() })]);
    expect(results[0].effect).toBe("inserted"); expect(results[1].code).toBe("TARGET_STALE");
    expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });
  it("continues success recording if a view closes after commit", async () => {
    const f = citationFixture(); const abort = new AbortController();
    f.editors.copy.mockImplementationOnce(async () => { abort.abort(); });
    const result = await f.engine.execute(f.intent({ action: "copy" }), { signal: abort.signal });
    expect(result).toMatchObject({ effect: "copied", recording: "saved", status: "success" });
  });
  it("never automatically repeats an uncertain host commit", async () => {
    const f = citationFixture(); f.editors.commit.mockImplementationOnce(() => { throw new CitationError("COMMIT_STATE_UNCERTAIN"); });
    const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).status).toBe("uncertain");
    await f.engine.execute(intent, { ticket: f.ticket() });
    expect(f.editors.commit).toHaveBeenCalledTimes(1); expect(f.store.data.history).toHaveLength(0);
  });
  it("preflights an explicit file-level custom citation without requiring an existing block subpath", async () => {
    const f = citationFixture("Source paragraph ^a");
    const result = await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{content}} ([[{{path}}]])" }), { ticket: f.ticket(), fallback: "file" });
    expect(result).toMatchObject({ effect: "inserted", precision: "file" });
    expect(f.editors.commit.mock.calls[0][1]).toBe("Source paragraph ([[Sources/Note.md]])");
    expect(f.process).not.toHaveBeenCalled();
  });

});

describe("CitationEngine batch", () => {
  function batchSetup(sourceText = "First paragraph\n\nSecond paragraph\n\nThird paragraph") {
    const f = citationFixture(sourceText);
    const desk: DeskV3 = {
      id: "desk-1",
      name: "Main",
      targetPath: "Drafts/A.md",
      rules: [],
      manualPaths: [],
      reading: {
        density: "snippet",
        filter: "",
        sort: "name",
        sortAsc: true,
        showHidden: false,
        pinned: [],
        collapsed: [],
        compactExpanded: [],
        dismissed: [],
        customOrder: [],
      },
      unresolvedRefs: [],
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      outline: emptyOutline(),
    };
    f.store.data.desks.push(desk);
    const snap = f.sources.capture(f.sourceFile as never, f.read());
    const makeLive = (itemId: string, spanIndex: number, overrides: Partial<Extract<PreparedEvidenceInput, { kind: "verified-live" }>> = {}): PreparedEvidenceInput => {
      const span = snap.spans[spanIndex];
      return {
        kind: "verified-live",
        itemId,
        entryId: itemId,
        contentRevision: 1,
        groupId: "g1",
        note: "",
        snapshot: snap,
        spans: [span],
        mode: "block",
        content: f.sources.content(span),
        templateId: "A",
        date: localDate(),
        ...overrides,
      };
    };
    return { ...f, desk, snap, makeLive };
  }

  it("preflights read-only, then writes source anchors once per source and commits target once with exact slice receipts (AC-22, AC-23, AC-29, AC-30)", async () => {
    const f = batchSetup();
    const items = [
      f.makeLive("i1", 0, { groupId: "g1", note: "My note" }),
      f.makeLive("i2", 1, { groupId: "g1" }),
      f.makeLive("i3", 2, { groupId: "g2" }),
    ];
    f.desk.outline = {
      groups: [{ id: "g1", name: "Group 1" }, { id: "g2", name: "Group 2" }, { id: "g3", name: "Empty Group" }],
      entries: items.map((item) => ({
        id: item.entryId,
        groupId: item.groupId,
        note: item.note,
        contentRevision: 1,
        createdAt: 1,
        updatedAt: 1,
        snapshot: {
          content: item.kind === "verified-live" ? item.content : "",
          mode: "block",
          source: { path: "Sources/Note.md", capturedPath: "Sources/Note.md", title: "Note", capturedAt: 1, sourceLength: f.read().length, identity: "path-reference" },
          origins: [],
          selectedRanges: [],
        },
      })),
    };

    const layout = buildOutlineLayout({
      scope: "all",
      groups: f.desk.outline.groups,
      items: items.map((item) => ({
        itemId: item.itemId,
        operationId: `batch-1:${item.itemId}`,
        groupId: item.groupId,
        citationText: "placeholder",
        note: item.note,
      })),
    });

    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({
      batchId: "batch-1",
      deskId: "desk-1",
      items,
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
    });

    // Preview phase must never mutate source, target, or records.
    expect(plan.canCommit).toBe(true);
    expect(f.process).not.toHaveBeenCalled();
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.status).toBe("success");
    expect(outcome.effect).toBe("inserted");
    expect(outcome.recording).toBe("saved");
    expect(outcome.commitSequence).toBe(1);
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.editors.commit).toHaveBeenCalledTimes(1);

    // Every relation's targetHint.range must slice the exact insertedText out of the final target body.
    expect(f.store.data.relations).toHaveLength(3);
    for (const rel of f.store.data.relations) {
      expect(f.bodies.a.slice(rel.targetHint.range.from, rel.targetHint.range.to)).toBe(rel.insertedText);
      expect(rel.batchId).toBe("batch-1");
      expect(rel.sourceState).toBe("verified");
    }
    expect(f.bodies.a).toContain("## Group 1");
    expect(f.bodies.a).toContain("个人备注：My note");
    expect(f.bodies.a).toContain("## Empty Group\n\n待补材料");
    expect(f.desk.outline.entries[0].lastInsertion).toMatchObject({ batchId: "batch-1", commitSequence: 1, targetPath: "Drafts/A.md" });

    // Double-click with same batchId returns the committed result without a second target commit.
    const replay = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(replay).toBe(outcome);
    expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });

  it("blocks empty output without writing source anchors, target, or records (AC-39)", async () => {
    const f = batchSetup();
    f.bodies.a = "Original target text";
    const item = f.makeLive("i1", 0, { groupId: null, skipped: true });
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "i1", operationId: "b-empty:i1", groupId: null, citationText: "x", skipped: true }],
    });
    const abort = new AbortController();
    const ticket = f.ticket("a");
    ticket.range = { from: 0, to: 8 }; // non-empty target selection

    const plan = await f.engine.prepareBatch({ batchId: "b-empty", items: [item], layout, ticket, signal: abort.signal });
    expect(plan.isEmpty).toBe(true);
    expect(plan.canCommit).toBe(false);
    expect(plan.issues.some((i) => i.code === "EMPTY_OUTPUT")).toBe(true);

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(outcome.code).toBe("EMPTY_OUTPUT");
    expect(f.bodies.a).toBe("Original target text");
    expect(f.process).not.toHaveBeenCalled();
    expect(f.editors.commit).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation for skeleton-only insertion when all group items are skipped (AC-21, AC-39)", async () => {
    const f = batchSetup();
    const item = f.makeLive("i1", 0, { groupId: "g1", skipped: true });
    const layout = buildOutlineLayout({
      scope: "group",
      groups: [{ id: "g1", name: "Argument" }],
      items: [{ itemId: "i1", operationId: "b-skel:i1", groupId: "g1", citationText: "x" }],
    });
    const abort = new AbortController();

    const blocked = await f.engine.prepareBatch({ batchId: "b-skel", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(blocked.canCommit).toBe(false);
    expect(blocked.issues.some((i) => i.code === "SKELETON_CONFIRMATION_REQUIRED")).toBe(true);

    const confirmed = await f.engine.prepareBatch({
      batchId: "b-skel",
      items: [item],
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
      skeletonConfirmed: true,
    });
    expect(confirmed.canCommit).toBe(true);
    expect(confirmed.hasSkeleton).toBe(true);
    expect(confirmed.includedItemCount).toBe(0);
    const outcome = await f.engine.commitBatch(confirmed.planId, { signal: abort.signal });
    expect(outcome.status).toBe("success");
    expect(f.bodies.a).toContain("## Argument\n\n本次未输出摘录");
    expect(f.store.data.history).toHaveLength(0);
    expect(f.store.data.relations).toHaveLength(0);
  });

  it("detects duplicates across single execute and batch, and allows explicitly authorized duplicates (AC-20)", async () => {
    const f = batchSetup();
    await f.engine.execute(f.intent(), { ticket: f.ticket("a") });

    const i1 = f.makeLive("i1", 0, { groupId: null });
    const i2 = f.makeLive("i2", 0, { groupId: null });
    const layout = buildOutlineLayout({
      scope: "all",
      groups: [],
      items: [
        { itemId: "i1", operationId: "b-dup:i1", groupId: null, citationText: "x" },
        { itemId: "i2", operationId: "b-dup:i2", groupId: null, citationText: "x" },
      ],
    });
    const abort = new AbortController();
    const blocked = await f.engine.prepareBatch({ batchId: "b-dup", items: [i1, i2], layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(blocked.issues.filter((i) => i.code === "BATCH_DUPLICATE")).toHaveLength(2);

    const authorized = await f.engine.prepareBatch({
      batchId: "b-dup-ok",
      items: [
        { ...i1, duplicateAuthorized: true },
        { ...i2, duplicateAuthorized: true },
      ],
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
    });
    expect(authorized.canCommit).toBe(true);
    const res = await f.engine.commitBatch(authorized.planId, { signal: abort.signal });
    expect(res.includedItemCount).toBe(2);
    expect(f.store.data.relations).toHaveLength(3); // 1 single + 2 batch
  });

  it("handles missing/unavailable saved snapshots cleanly and blocks C/D without verifiable links (AC-18)", async () => {
    const f = batchSetup();
    const missingItem: PreparedEvidenceInput = {
      kind: "saved-snapshot",
      itemId: "m1",
      entryId: "m1",
      contentRevision: 1,
      groupId: null,
      note: "My note",
      sourceState: "missing-snapshot",
      templateId: "A",
      date: localDate(),
      snapshot: {
        content: "Saved excerpt",
        mode: "block",
        source: { path: "Deleted/[Doc].md", capturedPath: "Deleted/[Doc].md", title: "Doc", capturedAt: 1, sourceLength: 13, identity: "unconfirmed-after-loss" },
        origins: [{ range: { from: 0, to: 13 }, rawText: "Saved excerpt", kind: "paragraph", before: "", after: "" }],
        selectedRanges: [{ from: 0, to: 13 }],
      },
    };
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "m1", operationId: "b-miss:m1", groupId: null, citationText: "x", note: "My note" }],
    });
    const abort = new AbortController();

    const blockedC = await f.engine.prepareBatch({
      batchId: "b-miss-c",
      items: [{ ...missingItem, templateId: "C" }],
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
    });
    expect(blockedC.issues.some((i) => i.code === "TEMPLATE_REQUIRES_BLOCK")).toBe(true);

    const okA = await f.engine.prepareBatch({
      batchId: "b-miss-a",
      items: [missingItem],
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
    });
    expect(okA.canCommit).toBe(true);
    expect(okA.markdown).toContain("来源已失效，原路径：Deleted/\\[Doc\\].md（保存时摘录，非当前原文）");
    expect(okA.markdown).not.toContain("[[Deleted");
    const outcome = await f.engine.commitBatch(okA.planId, { signal: abort.signal });
    expect(outcome.status).toBe("success");
    expect(f.store.data.relations[0].sourceState).toBe("missing-snapshot");
  });

  it("blocks self-target conflicts and preserves mapped sourceSpans on safe shifts (AC-40)", async () => {
    const f = batchSetup("Intro\n\nCited paragraph ^c1\n\nTail");
    const selfSnap = f.snap;
    const citedSpan = selfSnap.spans[1];
    const item: PreparedEvidenceInput = {
      kind: "verified-live",
      itemId: "s1",
      entryId: "s1",
      contentRevision: 1,
      groupId: null,
      note: "",
      snapshot: selfSnap,
      spans: [citedSpan],
      mode: "block",
      content: f.sources.content(citedSpan),
      templateId: "A",
      date: localDate(),
    };
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "s1", operationId: "b-self:s1", groupId: null, citationText: "x" }],
    });
    const abort = new AbortController();

    // Replacing over the cited block -> SELF_SOURCE_CONFLICT.
    const conflictTicket = { ...f.ticket("src"), range: { ...citedSpan.rawRange }, baselineText: f.read() };
    const conflictPlan = await f.engine.prepareBatch({ batchId: "b-self-bad", items: [item], layout, ticket: conflictTicket, signal: abort.signal });
    expect(conflictPlan.canCommit).toBe(false);
    expect(conflictPlan.issues.some((i) => i.code === "SELF_SOURCE_CONFLICT")).toBe(true);

    // Safe insertion at offset 0 shifts Cited paragraph cleanly and records mapped sourceSpans.
    f.editors.commit.mockImplementationOnce((ticket, text, block = true) => {
      f.editors.validate(ticket);
      const plan = insertionPlan(ticket.baselineText, ticket.range, text, block);
      f.bodies[ticket.fileRef] = ticket.baselineText.slice(0, plan.range.from) + plan.text + ticket.baselineText.slice(plan.range.to);
      return { targetPath: f.editors.path(ticket.fileRef), text: plan.text, range: { from: plan.range.from, to: plan.range.from + plan.text.length }, contentRange: plan.contentRange, before: "", after: "" };
    });
    const safeTicket = { ...f.ticket("src"), range: { from: 0, to: 0 }, baselineText: f.read() };
    const safePlan = await f.engine.prepareBatch({ batchId: "b-self-ok", items: [item], layout, ticket: safeTicket, signal: abort.signal });
    expect(safePlan.canCommit).toBe(true);
    const res = await f.engine.commitBatch(safePlan.planId, { signal: abort.signal });
    expect(res.status).toBe("success");
    expect(f.process).not.toHaveBeenCalled();
    const rel = f.store.data.relations[0];
    expect(rel.sourceSpans[0].range.from).toBeGreaterThan(citedSpan.rawRange.from);
    expect(f.bodies.src.slice(rel.sourceSpans[0].range.from, rel.sourceSpans[0].range.to)).toBe(citedSpan.rawText);
  });

  it("blocks unsafe Markdown boundaries in B/D and passes after explicit fallback to A (AC-41)", async () => {
    const f = batchSetup("```ts\nconst x = 1;");
    const item = f.makeLive("i1", 0, { templateId: "B", note: "Note after" });
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "i1", operationId: "b-md:i1", groupId: null, citationText: "x", note: "Note after" }],
    });
    const abort = new AbortController();

    const unsafe = await f.engine.prepareBatch({ batchId: "b-md-bad", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(unsafe.canCommit).toBe(false);
    expect(unsafe.issues.some((i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE")).toBe(true);

    const safe = await f.engine.prepareBatch({
      batchId: "b-md-ok",
      items: [{ ...item, templateId: "A" }],
      layout,
      ticket: f.ticket("a"),
      signal: abort.signal,
    });
    expect(safe.canCommit).toBe(true);
  });

  it("reports retained source IDs on second-source failure and handles uncertain commit, record retry, and disabled history (AC-24, AC-27, AC-28, AC-31)", async () => {
    const f = batchSetup("Source 1 paragraph");
    const file2 = new TFile("Sources/Second.md");
    f.files.push(file2);
    let source2Text = "Source 2 paragraph";
    const origPath = f.editors.path;
    const origFile = f.editors.file;
    const origRead = f.editors.readSource;
    f.editors.file = (ref: string) => (ref === "src2" ? file2 : origFile(ref));
    f.editors.path = (ref: string) => (ref === "src2" ? file2.path : origPath(ref));
    f.editors.readSource = vi.fn(async (ref: string) => (ref === "src2" ? source2Text : origRead(ref)));

    const snap1 = f.snap;
    f.editors.fileRef = () => "src2";
    const snap2 = f.sources.capture(file2 as never, source2Text);
    f.editors.fileRef = () => "src";

    const items: PreparedEvidenceInput[] = [
      { kind: "verified-live", itemId: "i1", entryId: "i1", contentRevision: 1, groupId: null, note: "", snapshot: snap1, spans: [snap1.spans[0]], mode: "block", content: "Source 1 paragraph", templateId: "A", date: localDate() },
      { kind: "verified-live", itemId: "i2", entryId: "i2", contentRevision: 1, groupId: null, note: "", snapshot: snap2, spans: [snap2.spans[0]], mode: "block", content: "Source 2 paragraph", templateId: "A", date: localDate() },
    ];
    const layout = buildOutlineLayout({
      scope: "all",
      groups: [],
      items: items.map((it) => ({ itemId: it.itemId, operationId: `b-fail:${it.itemId}`, groupId: null, citationText: "x" })),
    });
    const abort = new AbortController();

    const plan = await f.engine.prepareBatch({ batchId: "b-fail", items, layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(plan.canCommit).toBe(true);

    // Fail source 2 after source 1 writes its ID.
    source2Text = "Changed externally before ensurePlanned";
    const failOutcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(failOutcome.effect).toBe("none");
    expect(failOutcome.status).toBe("partial");
    expect(failOutcome.code).toBe("SOURCE_STALE");
    expect(failOutcome.sourceResults[0]).toMatchObject({ sourcePath: "Sources/Note.md", kind: "created" });
    expect(failOutcome.sourceResults[0].createdIds).toHaveLength(1);
    expect(failOutcome.sourceResults[1]).toMatchObject({ sourcePath: "Sources/Second.md", kind: "failed", code: "SOURCE_STALE" });
    expect(f.editors.commit).not.toHaveBeenCalled();

    // Retrying the failed planId without re-previewing is blocked as PLAN_STALE.
    const staleRetry = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(staleRetry).toMatchObject({ effect: "none", status: "blocked", code: "PLAN_STALE" });

    // Uncertain commit never auto-replays or saves records.
    source2Text = "Source 2 paragraph";
    const snap1Reload = f.sources.capture(f.sourceFile as never, f.read());
    const item1Only: PreparedEvidenceInput = {
      kind: "verified-live", itemId: "i1", entryId: "i1", contentRevision: 1, groupId: null, note: "",
      snapshot: snap1Reload, spans: [snap1Reload.spans[0]], mode: "block", content: "Source 1 paragraph", templateId: "A", date: localDate(),
    };
    const singleLayout = buildOutlineLayout({ scope: "single", groups: [], items: [{ itemId: "i1", operationId: "b-unc:i1", groupId: null, citationText: "x" }] });
    const uncPlan = await f.engine.prepareBatch({ batchId: "b-unc", items: [item1Only], layout: singleLayout, ticket: f.ticket("a"), signal: abort.signal });
    f.editors.commit.mockImplementationOnce(() => { throw new CitationError("COMMIT_STATE_UNCERTAIN"); });
    const unc = await f.engine.commitBatch(uncPlan.planId, { signal: abort.signal });
    expect(unc.status).toBe("uncertain");
    expect(unc.effect).toBe("unknown");
    expect(await f.engine.commitBatch(uncPlan.planId, { signal: abort.signal })).toBe(unc);
    expect(f.editors.commit).toHaveBeenCalledTimes(1);

    // Record save failure retries only records without re-committing body.
    f.save.mockRejectedValueOnce(new Error("Disk full"));
    const retryLayout = buildOutlineLayout({ scope: "single", groups: [], items: [{ itemId: "i1", operationId: "b-ret:i1", groupId: null, citationText: "x" }] });
    const retPlan = await f.engine.prepareBatch({
      batchId: "b-ret",
      items: [{ ...item1Only, duplicateAuthorized: true }],
      layout: retryLayout,
      ticket: f.ticket("b"),
      signal: abort.signal,
    });
    const retOutcome = await f.engine.commitBatch(retPlan.planId, { signal: abort.signal });
    expect(retOutcome).toMatchObject({ effect: "inserted", status: "partial", recording: "pending", code: "RECORD_SAVE_FAILED" });
    expect(await f.records.retryBatch("b-ret")).toBe("saved");
    expect(f.editors.commit).toHaveBeenCalledTimes(2);

    // historyEnabled=false allows batch insertion without creating records.
    f.store.data.settings.historyEnabled = false;
    const disabledLayout = buildOutlineLayout({ scope: "single", groups: [], items: [{ itemId: "i1", operationId: "b-dis:i1", groupId: null, citationText: "x" }] });
    const disPlan = await f.engine.prepareBatch({
      batchId: "b-dis",
      items: [{ ...item1Only, duplicateAuthorized: true }],
      layout: disabledLayout,
      ticket: f.ticket("b"),
      signal: abort.signal,
    });
    const disOutcome = await f.engine.commitBatch(disPlan.planId, { signal: abort.signal });
    expect(disOutcome).toMatchObject({ status: "success", effect: "inserted", recording: "disabled" });
    expect(f.store.data.relations).toHaveLength(1);
  });

  it("blocks target commit with SOURCE_STALE when source A is modified externally while writing source B, and succeeds when only planned IDs are written", async () => {
    const f = batchSetup("Source A paragraph");
    const file2 = new TFile("Sources/Second.md");
    f.files.push(file2);
    let source2Text = "Source B paragraph";
    const origPath = f.editors.path;
    const origFile = f.editors.file;
    const origRead = f.editors.readSource;
    f.editors.file = (ref: string) => (ref === "src2" ? file2 : origFile(ref));
    f.editors.path = (ref: string) => (ref === "src2" ? file2.path : origPath(ref));
    f.editors.readSource = vi.fn(async (ref: string) => (ref === "src2" ? source2Text : origRead(ref)));

    const snapA = f.snap;
    f.editors.fileRef = () => "src2";
    const snapB = f.sources.capture(file2 as never, source2Text);
    f.editors.fileRef = () => "src";

    const items: PreparedEvidenceInput[] = [
      { kind: "verified-live", itemId: "i1", entryId: "i1", contentRevision: 1, groupId: null, note: "", snapshot: snapA, spans: [snapA.spans[0]], mode: "block", content: "Source A paragraph", templateId: "A", date: localDate() },
      { kind: "verified-live", itemId: "i2", entryId: "i2", contentRevision: 1, groupId: null, note: "", snapshot: snapB, spans: [snapB.spans[0]], mode: "block", content: "Source B paragraph", templateId: "A", date: localDate() },
    ];
    const layout = buildOutlineLayout({
      scope: "all",
      groups: [],
      items: items.map((it) => ({ itemId: it.itemId, operationId: `b-race:${it.itemId}`, groupId: null, citationText: "x" })),
    });
    const abort = new AbortController();

    const plan = await f.engine.prepareBatch({ batchId: "b-race", items, layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(plan.canCommit).toBe(true);

    // During source B's anchor write, modify source A externally after A's own anchor write finished.
    f.process.mockImplementation(async (file, update) => {
      if (file === f.sourceFile) {
        f.write(update(f.read()));
        return f.read();
      }
      source2Text = update(source2Text);
      f.write(f.read() + "\nExternal tampering on A");
      return source2Text;
    });

    const staleOutcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(staleOutcome.effect).toBe("none");
    expect(staleOutcome.status).toBe("partial");
    expect(staleOutcome.code).toBe("SOURCE_STALE");
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);
    expect(f.store.data.history).toHaveLength(0);

    // Fresh clean run on A + B writes both planned IDs, passes final verification, and commits cleanly.
    f.process.mockImplementation(async (file, update) => {
      if (file === f.sourceFile) {
        f.write(update(f.read()));
        return f.read();
      }
      source2Text = update(source2Text);
      return source2Text;
    });
    f.write("Source A paragraph");
    source2Text = "Source B paragraph";
    const cleanSnapA = f.sources.capture(f.sourceFile as never, f.read());
    f.editors.fileRef = () => "src2";
    const cleanSnapB = f.sources.capture(file2 as never, source2Text);
    f.editors.fileRef = () => "src";
    const cleanItems: PreparedEvidenceInput[] = [
      { ...items[0], snapshot: cleanSnapA, spans: [cleanSnapA.spans[0]] },
      { ...items[1], snapshot: cleanSnapB, spans: [cleanSnapB.spans[0]] },
    ];
    const cleanPlan = await f.engine.prepareBatch({ batchId: "b-race-ok", items: cleanItems, layout, ticket: f.ticket("a"), signal: abort.signal });
    const okOutcome = await f.engine.commitBatch(cleanPlan.planId, { signal: abort.signal });
    expect(okOutcome.status).toBe("success");
    expect(okOutcome.effect).toBe("inserted");
    expect(okOutcome.recording).toBe("saved");
    expect(f.editors.commit).toHaveBeenCalledTimes(1);
    expect(f.store.data.relations).toHaveLength(2);
    expect(f.store.data.relations.every((r) => r.sourceState === "verified")).toBe(true);
  });

  it("blocks commit with SOURCE_STALE when a source is renamed between prepareBatch and commitBatch", async () => {
    const f = batchSetup();
    const item = f.makeLive("i1", 0, { groupId: null });
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "i1", operationId: "b-ren:i1", groupId: null, citationText: "x" }],
    });
    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({ batchId: "b-ren", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(plan.canCommit).toBe(true);

    const origPath = f.editors.path;
    f.editors.path = (ref: string) => (ref === "src" ? "Sources/Moved.md" : origPath(ref));

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(outcome.code).toBe("SOURCE_STALE");
    expect(f.process).not.toHaveBeenCalled();
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);
  });

  it("blocks saved-snapshot commit with SOURCE_STALE if its linked sourceRef is renamed before commitBatch", async () => {
    const f = batchSetup();
    const staleWithRef: PreparedEvidenceInput = {
      kind: "saved-snapshot",
      itemId: "s1",
      entryId: "s1",
      contentRevision: 1,
      groupId: null,
      note: "",
      sourceRef: "src",
      sourceState: "stale-snapshot",
      templateId: "A",
      date: localDate(),
      snapshot: {
        content: "Saved excerpt",
        mode: "block",
        source: { path: "Sources/Note.md", capturedPath: "Sources/Note.md", title: "Note", capturedAt: 1, sourceLength: 13, identity: "path-reference" },
        origins: [{ range: { from: 0, to: 13 }, rawText: "Saved excerpt", kind: "paragraph", before: "", after: "" }],
        selectedRanges: [{ from: 0, to: 13 }],
      },
    };
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "s1", operationId: "b-snap-ren:s1", groupId: null, citationText: "x" }],
    });
    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({ batchId: "b-snap-ren", items: [staleWithRef], layout, ticket: f.ticket("a"), signal: abort.signal });
    expect(plan.canCommit).toBe(true);

    const origPath = f.editors.path;
    f.editors.path = (ref: string) => (ref === "src" ? "Sources/Renamed.md" : origPath(ref));

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(outcome.code).toBe("SOURCE_STALE");
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);
  });

  it("releaseBatchPlan frees unconsumed plans so commitBatch returns PLAN_STALE, while preserving committed replay", async () => {
    const f = batchSetup();
    const item = f.makeLive("i1", 0, { groupId: null });
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "i1", operationId: "b-rel:i1", groupId: null, citationText: "x" }],
    });
    const abort = new AbortController();

    const releasedPlan = await f.engine.prepareBatch({ batchId: "b-rel-1", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    f.engine.releaseBatchPlan(releasedPlan.planId);
    const staleOutcome = await f.engine.commitBatch(releasedPlan.planId, { signal: abort.signal });
    expect(staleOutcome).toMatchObject({ effect: "none", status: "blocked", code: "PLAN_STALE" });
    expect(f.editors.commit).not.toHaveBeenCalled();

    // Releasing after a committed batch must still keep idempotent replay intact.
    const committedPlan = await f.engine.prepareBatch({ batchId: "b-rel-2", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    const committed = await f.engine.commitBatch(committedPlan.planId, { signal: abort.signal });
    expect(committed.effect).toBe("inserted");
    f.engine.releaseBatchPlan(committedPlan.planId);
    expect(await f.engine.commitBatch(committedPlan.planId, { signal: abort.signal })).toBe(committed);
    expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });

  it("blocks commit with SOURCE_STALE when source A is modified or loses its block ID while awaiting source B verification (Bug 1)", async () => {
    const f = batchSetup("Source A paragraph");
    const file2 = new TFile("Sources/Second.md");
    f.files.push(file2);
    let source2Text = "Source B paragraph";
    const origPath = f.editors.path;
    const origFile = f.editors.file;
    const origRead = f.editors.readSource;
    f.editors.file = (ref: string) => (ref === "src2" ? file2 : origFile(ref));
    f.editors.path = (ref: string) => (ref === "src2" ? file2.path : origPath(ref));
    f.editors.readSource = vi.fn(async (ref: string) => (ref === "src2" ? source2Text : origRead(ref)));

    const watchers: Array<(ref: string) => void> = [];
    const editorsWithWatch = f.editors as typeof f.editors & {
      watchSourceChanges?: (refs: ReadonlySet<string>, onChanged: (ref: string) => void) => () => void;
      readOpenSourceSync?: (ref: string) => string | undefined;
    };
    editorsWithWatch.watchSourceChanges = (_refs, cb) => {
      watchers.push(cb);
      return () => {};
    };

    const snapA = f.snap;
    f.editors.fileRef = () => "src2";
    const snapB = f.sources.capture(file2 as never, source2Text);
    f.editors.fileRef = () => "src";

    const items: PreparedEvidenceInput[] = [
      { kind: "verified-live", itemId: "i1", entryId: "i1", contentRevision: 1, groupId: null, note: "", snapshot: snapA, spans: [snapA.spans[0]], mode: "block", content: "Source A paragraph", templateId: "A", date: localDate() },
      { kind: "verified-live", itemId: "i2", entryId: "i2", contentRevision: 1, groupId: null, note: "", snapshot: snapB, spans: [snapB.spans[0]], mode: "block", content: "Source B paragraph", templateId: "A", date: localDate() },
    ];
    const layout = buildOutlineLayout({
      scope: "all",
      groups: [],
      items: items.map((it) => ({ itemId: it.itemId, operationId: `b-reverify:${it.itemId}`, groupId: null, citationText: "x" })),
    });
    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({ batchId: "b-reverify", items, layout, ticket: f.ticket("a"), signal: abort.signal });

    f.process.mockImplementation(async (file, update) => {
      if (file === f.sourceFile) {
        f.write(update(f.read()));
        return f.read();
      }
      source2Text = update(source2Text);
      return source2Text;
    });

    // While awaiting B's verifyPlanned, source A is modified (or loses its block ID) and fires watchSourceChanges.
    const origVerify = f.sources.verifyPlanned.bind(f.sources);
    vi.spyOn(f.sources, "verifyPlanned").mockImplementation(async (anchorPlan) => {
      await origVerify(anchorPlan);
      if (anchorPlan.sourceRef === "src2") {
        f.write("Source A modified without block id");
        for (const cb of watchers) cb("src");
      }
    });

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(outcome.status).toBe("partial");
    expect(outcome.code).toBe("SOURCE_STALE");
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);
    expect(f.store.data.history).toHaveLength(0);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("guards sources through target dispatch when an async writer completes after %i microtasks", async (depth) => {
    const f = batchSetup("Evidence paragraph");
    const watchers = new Set<(ref: string) => void>();
    const unsubscribe = vi.fn();
    Object.assign(f.editors, {
      watchSourceChanges: (_refs: ReadonlySet<string>, cb: (ref: string) => void) => {
        watchers.add(cb);
        return () => { watchers.delete(cb); unsubscribe(); };
      },
      readOpenSourceSync: () => f.read(),
    });
    const item = f.makeLive("i1", 0, { groupId: null });
    const layout = buildOutlineLayout({ scope: "single", groups: [], items: [{ itemId: "i1", operationId: "race:i1", groupId: null, citationText: "x" }] });
    const signal = new AbortController().signal;
    const plan = await f.engine.prepareBatch({ batchId: "race", items: [item], layout, ticket: f.ticket("a"), signal });
    let changed = false;
    let changedAtDispatch = false;
    let watchersAtDispatch: number | undefined;
    const commit = f.editors.commit.getMockImplementation()!;
    f.editors.commit.mockImplementation((...args) => {
      changedAtDispatch = changed;
      watchersAtDispatch = watchers.size;
      return commit(...args);
    });
    const verify = f.sources.verifyPlanned.bind(f.sources);
    vi.spyOn(f.sources, "verifyPlanned").mockImplementation(async (sourcePlan) => {
      await verify(sourcePlan);
      let update = () => {
        changed = true;
        f.write("Changed source; the cited block ID no longer exists.");
        for (const cb of watchers) cb("src");
      };
      for (let i = 0; i < depth; i++) { const next = update; update = () => queueMicrotask(next); }
      update();
    });
    const outcome = await f.engine.commitBatch(plan.planId, { signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toBe(true);
    expect(changedAtDispatch).toBe(false);
    if (watchersAtDispatch !== undefined) expect(watchersAtDispatch).toBe(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(watchers.size).toBe(0);
    if (outcome.effect === "none") {
      expect(outcome).toMatchObject({ status: "partial", code: "SOURCE_STALE" });
      expect(f.store.data.history).toHaveLength(0);
      expect(f.store.data.relations).toHaveLength(0);
    } else {
      expect(outcome.effect).toBe("inserted");
    }
  });

  it.each(["source", "target", "cancel"])("releases the source watcher after a %s failure", async (failure) => {
    const f = batchSetup("Evidence paragraph");
    const unsubscribe = vi.fn();
    Object.assign(f.editors, { watchSourceChanges: () => unsubscribe });
    const item = f.makeLive("i1", 0, { groupId: null });
    const layout = buildOutlineLayout({ scope: "single", groups: [], items: [{ itemId: "i1", operationId: "failure:i1", groupId: null, citationText: "x" }] });
    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({ batchId: "failure", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });
    if (failure === "target") f.editors.commit.mockImplementationOnce(() => { throw new CitationError("TARGET_COMMIT_FAILED"); });
    else vi.spyOn(f.sources, "verifyPlanned").mockImplementationOnce(async () => {
      if (failure === "cancel") abort.abort();
      else throw new CitationError("SOURCE_STALE");
    });
    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("aborts before target commit if cancelled while awaiting final source verification (Bug 2)", async () => {
    const f = batchSetup("Source A paragraph");
    const item = f.makeLive("i1", 0, { groupId: null });
    const layout = buildOutlineLayout({
      scope: "single",
      groups: [],
      items: [{ itemId: "i1", operationId: "b-cancel-reverify:i1", groupId: null, citationText: "x" }],
    });
    const abort = new AbortController();
    const plan = await f.engine.prepareBatch({ batchId: "b-cancel-reverify", items: [item], layout, ticket: f.ticket("a"), signal: abort.signal });

    const origVerify = f.sources.verifyPlanned.bind(f.sources);
    vi.spyOn(f.sources, "verifyPlanned").mockImplementationOnce(async (anchorPlan) => {
      await origVerify(anchorPlan);
      abort.abort();
    });

    const outcome = await f.engine.commitBatch(plan.planId, { signal: abort.signal });
    expect(outcome.effect).toBe("none");
    expect(outcome.status).toBe("partial");
    expect(outcome.code).toBe("OPERATION_CANCELLED");
    expect(f.editors.commit).not.toHaveBeenCalled();
    expect(f.store.data.relations).toHaveLength(0);
  });
});
