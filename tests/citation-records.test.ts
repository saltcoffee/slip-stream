import { describe, expect, it, vi } from "vitest";
import { citationFixture } from "./support/citations";
import { CitationRecordsService, RELATION_LIMIT } from "../src/domain/CitationRecords";
import { DeskService } from "../src/domain/DeskService";
import { OutlineService } from "../src/domain/OutlineService";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import type { CitationHistoryEntry, CitationRelation } from "../src/domain/citationTypes";
import type { EvidenceSnapshot } from "../src/domain/outlineTypes";

function makeSnapshot(path = "Sources/Note.md", content = "Paragraph one"): EvidenceSnapshot {
  return {
    content,
    mode: "block",
    source: {
      path,
      capturedPath: path,
      title: "Note",
      capturedAt: 100,
      sourceLength: content.length,
      identity: "path-reference",
    },
    origins: [{ range: { from: 0, to: content.length }, rawText: content, kind: "paragraph", before: "", after: "" }],
    selectedRanges: [{ from: 0, to: content.length }],
  };
}

function makeHistory(batchId: string, itemId: string, sourcePath = "Sources/Note.md", targetPath = "Drafts/A.md", at = 100): CitationHistoryEntry {
  const operationId = `${batchId}:${itemId}`;
  return {
    id: `history:${operationId}`,
    operationId,
    at,
    action: "insert",
    sourcePath,
    targetPath,
    precision: "block",
    template: "A",
    snippet: "Paragraph one",
    text: `> Paragraph one\n> — [[${sourcePath}]]`,
  };
}

function makeRelation(batchId: string, itemId: string, sourcePath = "Sources/Note.md", targetPath = "Drafts/A.md", at = 100): CitationRelation {
  const operationId = `${batchId}:${itemId}`;
  return {
    id: `relation:${operationId}`,
    operationId,
    at,
    sourcePath,
    targetPath,
    sourceSpans: [{ range: { from: 0, to: 13 }, rawText: "Paragraph one", kind: "paragraph" }],
    content: "Paragraph one",
    insertedText: `> Paragraph one\n> — [[${sourcePath}]]`,
    precision: "block",
    sourceState: "verified",
    template: "A",
    targetHint: { range: { from: 0, to: 30 }, before: "", after: "" },
  };
}

function batchFixture() {
  const save = vi.fn(async (_data: unknown) => {});
  const backup = vi.fn(async (_raw: unknown) => {});
  let persistedData: unknown = null;
  save.mockImplementation(async (data) => {
    persistedData = data;
  });
  const store = new PluginDataStore({ load: async () => persistedData, save, backup });
  const records = new CitationRecordsService(store);
  const desks = new DeskService(store);
  const outlines = new OutlineService(desks, store);
  return { store, records, desks, outlines, save, backup, persisted: () => persistedData };
}

describe("CitationRecords", () => {
  it("records actual target, content and minimal source and target hints", async () => {
    const f = citationFixture("Source");
    await f.engine.execute(f.intent(), { ticket: f.ticket() });
    expect(f.store.data.history[0]).toMatchObject({ action: "insert", targetPath: "Drafts/A.md", sourcePath: "Sources/Note.md" });
    expect(f.store.data.relations[0]).toMatchObject({ content: "Source", sourceSpans: [{ rawText: "Source", range: { from: 0, to: 6 } }], targetHint: { before: "", after: "" } });
  });

  it("keeps snapshots when history is limited or cleared, and keeps history when snapshots are cleared", async () => {
    const f = citationFixture();
    f.store.data.settings.historyLimit = 1;
    await f.engine.execute(f.intent(), { ticket: f.ticket() });
    await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.data.relations).toHaveLength(2);
    await f.records.clearHistory();
    expect(f.store.data.relations).toHaveLength(2);
    await f.engine.execute(f.intent({ action: "copy" }));
    await f.records.clearRelations();
    expect(f.store.data.history[0].action).toBe("copy");
    expect(f.store.data.relations).toHaveLength(0);
  });

  it("does not resurrect cleared collections when a pending receipt is retried", async () => {
    const f = citationFixture();
    f.save.mockRejectedValueOnce(new Error("write failed"));
    const intent = f.intent();
    await f.engine.execute(intent, { ticket: f.ticket() });
    await f.records.clearHistory();
    await f.records.clearRelations();
    expect(await f.records.retry(intent.operationId)).toBe("saved");
    expect(f.store.data.history).toEqual([]);
    expect(f.store.data.relations).toEqual([]);
  });

  it("honors disabling records while a save is pending and does not restore them on later retry", async () => {
    const f = citationFixture();
    let fail!: (reason: Error) => void;
    f.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const intent = f.intent();
    const pending = f.engine.execute(intent, { ticket: f.ticket() });
    await new Promise<void>((resolve) => { const poll = () => fail ? resolve() : queueMicrotask(poll); poll(); });
    f.store.data.settings.historyEnabled = false;
    f.records.settingsChanged();
    fail(new Error("failed"));
    await pending;
    f.store.data.settings.historyEnabled = true;
    await f.records.retry(intent.operationId);
    expect(f.store.data.history).toHaveLength(0);
    expect(f.store.data.relations).toHaveLength(0);
  });

  it("does not evict old snapshots at the count limit and reports partial coverage", async () => {
    const f = citationFixture();
    await f.engine.execute(f.intent(), { ticket: f.ticket() });
    const old = f.store.data.relations[0];
    f.store.data.relations = Array.from({ length: RELATION_LIMIT }, (_, i) => ({ ...old, id: `old-${i}` }));
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(result).toMatchObject({ effect: "inserted", recording: "capacity-exceeded", code: "RECORD_CAPACITY_EXCEEDED" });
    expect(f.store.data.relations).toHaveLength(RELATION_LIMIT);
    expect(f.store.data.relations[0].id).toBe("old-0");
    expect(f.store.data.history[0].relationId).toBeUndefined();
  });

  it("applies the UTF-8 byte limit and retains a complete history receipt", async () => {
    const f = citationFixture();
    await f.engine.execute(f.intent(), { ticket: f.ticket() });
    f.store.data.relations[0].content = "中".repeat(4 * 1024 * 1024);
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(result.recording).toBe("capacity-exceeded");
    expect(f.store.data.relations).toHaveLength(1);
    expect(f.store.data.history).toHaveLength(2);
  });
});

describe("CitationRecords batch recording, capacity, sequence ordering, and suppression", () => {
  it("records a multi-source batch in a single root save, advancing lastCommitSequence and entry lastInsertion", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot("Sources/A.md", "Paragraph one") });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e2", snapshot: makeSnapshot("Sources/B.md", "Paragraph two") });
    f.save.mockClear();

    const frozen = f.records.freezeBatchCommit(true);
    expect(frozen.recordingEligible).toBe(true);
    expect(frozen.commitSequence).toBe(1);

    const outcome = await f.records.recordBatch({
      batchId: "batch-1",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: frozen.recordingEligible,
      items: [
        { operationId: "batch-1:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-1", "i1", "Sources/A.md"), relation: makeRelation("batch-1", "i1", "Sources/A.md") },
        { operationId: "batch-1:i2", entryId: "e2", contentRevision: 1, history: makeHistory("batch-1", "i2", "Sources/B.md"), relation: makeRelation("batch-1", "i2", "Sources/B.md") },
      ],
    });

    expect(outcome).toBe("saved");
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.store.data.lastCommitSequence).toBe(1);
    expect(f.store.data.history).toHaveLength(2);
    expect(f.store.data.relations).toHaveLength(2);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion).toMatchObject({
      batchId: "batch-1",
      targetPath: "Drafts/A.md",
      contentRevision: 1,
      commitSequence: 1,
    });
    expect(f.outlines.getEntry(desk.id, "e2")?.lastInsertion?.operationId).toBe("batch-1:i2");
  });

  it("enforces all-or-nothing relation capacity on recheck while saving history and lastInsertion", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });
    const seed = makeRelation("seed", "0");
    f.store.data.relations = Array.from({ length: RELATION_LIMIT - 1 }, (_, idx) => ({ ...seed, id: `seed-${idx}` }));
    const incoming = [makeRelation("batch-1", "i1"), makeRelation("batch-1", "i2")];
    expect(f.records.canFitRelations(incoming)).toBe(false);

    const frozen = f.records.freezeBatchCommit(true);
    const result = await f.records.recordBatch({
      batchId: "batch-1",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: frozen.recordingEligible,
      items: [
        { operationId: "batch-1:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-1", "i1"), relation: incoming[0] },
        { operationId: "batch-1:i2", history: makeHistory("batch-1", "i2"), relation: incoming[1] },
      ],
    });

    expect(result).toBe("capacity-exceeded");
    expect(f.store.data.relations).toHaveLength(RELATION_LIMIT - 1);
    expect(f.store.data.history).toHaveLength(2);
    expect(f.store.data.history.every((h) => h.relationId === undefined)).toBe(true);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion?.commitSequence).toBe(1);
  });

  it("retries save-only without duplicating entries and confirms via subsequent root save", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });
    f.save.mockRejectedValueOnce(new Error("disk full"));

    const frozen = f.records.freezeBatchCommit(true);
    const first = await f.records.recordBatch({
      batchId: "batch-1",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: frozen.recordingEligible,
      items: [{ operationId: "batch-1:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-1", "i1"), relation: makeRelation("batch-1", "i1") }],
    });
    expect(first).toBe("pending");
    expect(f.records.pendingBatchIds()).toEqual(["batch-1"]);

    // Subsequent unrelated root save persists the pending batch
    await f.outlines.setNote({ deskId: desk.id, expectedRevision: 1, entryId: "e1", expectedContentRevision: 1, note: "Edited" });
    expect(f.records.pendingBatchIds()).toEqual([]);
    const retried = await f.records.retryBatch("batch-1");
    expect(retried).toBe("saved");
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.data.relations).toHaveLength(1);
  });

  it("suppresses unpersisted pending batches on disable without restoring intermediate unpersisted values (AC-31, AC-33)", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });

    // Persist batch 0 so entry has a confirmed persisted lastInsertion at seq=1
    const f0 = f.records.freezeBatchCommit(true);
    expect(await f.records.recordBatch({
      batchId: "batch-0",
      deskId: desk.id,
      targetPath: "Drafts/Old.md",
      at: f0.at,
      commitSequence: f0.commitSequence,
      recordingEligible: true,
      items: [{ operationId: "batch-0:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-0", "i1", "Sources/Note.md", "Drafts/Old.md"), relation: makeRelation("batch-0", "i1", "Sources/Note.md", "Drafts/Old.md") }],
    })).toBe("saved");

    // Both batch 1 (seq=2) and batch 2 (seq=3) fail to save
    f.save.mockRejectedValueOnce(new Error("fail-1"));
    const f1 = f.records.freezeBatchCommit(true);
    expect(await f.records.recordBatch({
      batchId: "batch-1",
      deskId: desk.id,
      targetPath: "Drafts/Mid.md",
      at: f1.at,
      commitSequence: f1.commitSequence,
      recordingEligible: true,
      items: [{ operationId: "batch-1:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-1", "i1", "Sources/Note.md", "Drafts/Mid.md"), relation: makeRelation("batch-1", "i1", "Sources/Note.md", "Drafts/Mid.md") }],
    })).toBe("pending");

    f.save.mockRejectedValueOnce(new Error("fail-2"));
    const f2 = f.records.freezeBatchCommit(true);
    expect(await f.records.recordBatch({
      batchId: "batch-2",
      deskId: desk.id,
      targetPath: "Drafts/New.md",
      at: f2.at,
      commitSequence: f2.commitSequence,
      recordingEligible: true,
      items: [{ operationId: "batch-2:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-2", "i1", "Sources/Note.md", "Drafts/New.md"), relation: makeRelation("batch-2", "i1", "Sources/Note.md", "Drafts/New.md") }],
    })).toBe("pending");

    // Disable recording before either batch 1 or batch 2 persists
    f.store.data.settings.historyEnabled = false;
    f.records.settingsChanged();

    // Must revert to confirmed batch-0 (seq=1), NOT intermediate unpersisted batch-1!
    expect(f.store.data.lastCommitSequence).toBe(1);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion).toMatchObject({
      batchId: "batch-0",
      targetPath: "Drafts/Old.md",
      commitSequence: 1,
    });
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.data.relations).toHaveLength(1);

    // Re-enabling and retrying suppressed batches must not restore them
    f.store.data.settings.historyEnabled = true;
    expect(await f.records.retryBatch("batch-1")).toBe("disabled");
    expect(await f.records.retryBatch("batch-2")).toBe("disabled");
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.data.relations).toHaveLength(1);

    // Next enabled commit gets seq=4 (gaps allowed, never reuses or regresses)
    const f3 = f.records.freezeBatchCommit(true);
    expect(f3.commitSequence).toBe(4);
  });

  it("does not record or advance high-water mark when recording is disabled or skeleton-only", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });

    const skeletonFreeze = f.records.freezeBatchCommit(false);
    expect(skeletonFreeze.recordingEligible).toBe(false);
    expect(skeletonFreeze.commitSequence).toBeUndefined();

    f.store.data.settings.historyEnabled = false;
    const disabledFreeze = f.records.freezeBatchCommit(true);
    expect(disabledFreeze.recordingEligible).toBe(false);
    expect(disabledFreeze.commitSequence).toBeUndefined();

    // Even if re-enabled before recordBatch callback runs, frozen recordingEligible=false blocks backfill
    f.store.data.settings.historyEnabled = true;
    const outcome = await f.records.recordBatch({
      batchId: "batch-disabled",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: disabledFreeze.at,
      recordingEligible: disabledFreeze.recordingEligible,
      items: [{ operationId: "batch-disabled:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-disabled", "i1") }],
    });
    expect(outcome).toBe("disabled");
    expect(f.store.data.lastCommitSequence).toBe(0);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion).toBeUndefined();
  });

  it("preserves actual inserted revision on late receipt after entry is updated, and ignores deleted entry/desk (AC-43)", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e2", snapshot: makeSnapshot("Sources/B.md", "Second") });

    const frozen = f.records.freezeBatchCommit(true);
    // Entry e1 is updated to contentRevision=2 and note changed, and e2 is removed BEFORE late recordBatch runs
    await f.outlines.setNote({ deskId: desk.id, expectedRevision: 2, entryId: "e1", expectedContentRevision: 1, note: "New interpretation" });
    await f.outlines.removeEntry({ deskId: desk.id, expectedRevision: 3, entryId: "e2" });

    const outcome = await f.records.recordBatch({
      batchId: "batch-1",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: true,
      items: [
        { operationId: "batch-1:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-1", "i1"), relation: makeRelation("batch-1", "i1") },
        { operationId: "batch-1:i2", entryId: "e2", contentRevision: 1, history: makeHistory("batch-1", "i2", "Sources/B.md"), relation: makeRelation("batch-1", "i2", "Sources/B.md") },
      ],
    });
    expect(outcome).toBe("saved");
    const e1 = f.outlines.getEntry(desk.id, "e1")!;
    expect(e1.contentRevision).toBe(2);
    expect(e1.note).toBe("New interpretation");
    expect(e1.lastInsertion?.contentRevision).toBe(1);
    // Deleted e2 is NOT resurrected, while global history & relations still record both
    expect(f.outlines.getEntry(desk.id, "e2")).toBeUndefined();
    expect(f.store.data.history).toHaveLength(2);
    expect(f.store.data.relations).toHaveLength(2);
  });

  it("merges out-of-order receipts by commitSequence rather than arrival order or clock, and continues monotonically across restarts (AC-44)", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot() });

    const freezeA = f.records.freezeBatchCommit(true); // seq=1
    const freezeB = f.records.freezeBatchCommit(true); // seq=2
    expect(freezeA.commitSequence).toBe(1);
    expect(freezeB.commitSequence).toBe(2);

    // Batch B arrives first with an earlier wall-clock timestamp (clock rollback simulation)
    expect(await f.records.recordBatch({
      batchId: "batch-B",
      deskId: desk.id,
      targetPath: "Drafts/B.md",
      at: 1000,
      commitSequence: freezeB.commitSequence,
      recordingEligible: true,
      items: [{ operationId: "batch-B:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-B", "i1", "Sources/Note.md", "Drafts/B.md", 1000), relation: makeRelation("batch-B", "i1", "Sources/Note.md", "Drafts/B.md", 1000) }],
    })).toBe("saved");

    // Batch A arrives late with a larger wall-clock timestamp (2000), but lower commitSequence (1)
    expect(await f.records.recordBatch({
      batchId: "batch-A",
      deskId: desk.id,
      targetPath: "Drafts/A.md",
      at: 2000,
      commitSequence: freezeA.commitSequence,
      recordingEligible: true,
      items: [{ operationId: "batch-A:i1", entryId: "e1", contentRevision: 1, history: makeHistory("batch-A", "i1", "Sources/Note.md", "Drafts/A.md", 2000), relation: makeRelation("batch-A", "i1", "Sources/Note.md", "Drafts/A.md", 2000) }],
    })).toBe("saved");

    expect(f.store.data.lastCommitSequence).toBe(2);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion).toMatchObject({
      batchId: "batch-B",
      targetPath: "Drafts/B.md",
      commitSequence: 2,
      at: 1000,
    });
    expect(f.store.data.history).toHaveLength(2);
    expect(f.store.data.relations).toHaveLength(2);

    // Simulate restart by loading persisted v3 snapshot into a fresh PluginDataStore + CitationRecordsService
    const restartedStore = new PluginDataStore({ load: async () => f.persisted(), save: async () => {}, backup: async () => {} });
    await restartedStore.load();
    const restartedRecords = new CitationRecordsService(restartedStore);
    const freezeC = restartedRecords.freezeBatchCommit(true);
    expect(freezeC.commitSequence).toBe(3);
  });

  it("supports skipRelations when capacity was pre-acknowledged and maps history/relation paths on rename", async () => {
    const f = batchFixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Sub/A.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot("Research/A/Note.md") });
    const frozen = f.records.freezeBatchCommit(true);
    expect(await f.records.recordBatch({
      batchId: "b-skip",
      deskId: desk.id,
      targetPath: "Drafts/Sub/A.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: true,
      skipRelations: true,
      items: [{
        operationId: "b-skip:i1",
        entryId: "e1",
        contentRevision: 1,
        history: makeHistory("b-skip", "i1", "Research/A/Note.md", "Drafts/Sub/A.md"),
        relation: makeRelation("b-skip", "i1", "Research/A/Note.md", "Drafts/Sub/A.md"),
      }],
    })).toBe("saved");
    expect(f.store.data.relations).toHaveLength(0);
    expect(f.store.data.history).toHaveLength(1);
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion?.targetPath).toBe("Drafts/Sub/A.md");

    const frozen2 = f.records.freezeBatchCommit(true);
    await f.records.recordBatch({
      batchId: "b-rel",
      deskId: desk.id,
      targetPath: "Drafts/Sub/A.md",
      at: frozen2.at,
      commitSequence: frozen2.commitSequence,
      recordingEligible: true,
      items: [{
        operationId: "b-rel:i1",
        entryId: "e1",
        contentRevision: 1,
        history: makeHistory("b-rel", "i1", "Research/A/Note.md", "Drafts/Sub/A.md"),
        relation: makeRelation("b-rel", "i1", "Research/A/Note.md", "Drafts/Sub/A.md"),
      }],
    });
    await f.records.renamePaths("Research/A", "Research/Renamed", true);
    expect(f.store.data.history[0].sourcePath).toBe("Research/Renamed/Note.md");
    expect(f.store.data.relations[0].sourcePath).toBe("Research/Renamed/Note.md");
    expect(f.store.data.relations[0].content).toBe("Paragraph one");
  });
});
