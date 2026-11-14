import { describe, expect, it } from "vitest";
import { citationFixture } from "./support/citations";
import { RELATION_LIMIT } from "../src/domain/CitationRecords";

describe("CitationRecords", () => {
  it("records actual target, content and minimal source and target hints", async () => {
    const f = citationFixture("Source"); await f.engine.execute(f.intent(), { ticket: f.ticket() });
    expect(f.store.data.history[0]).toMatchObject({ action: "insert", targetPath: "Drafts/A.md", sourcePath: "Sources/Note.md" });
    expect(f.store.data.relations[0]).toMatchObject({ content: "Source", sourceSpans: [{ rawText: "Source", range: { from: 0, to: 6 } }], targetHint: { before: "", after: "" } });
  });
  it("keeps snapshots when history is limited or cleared, and keeps history when snapshots are cleared", async () => {
    const f = citationFixture(); f.store.data.settings.historyLimit = 1;
    await f.engine.execute(f.intent(), { ticket: f.ticket() }); await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(f.store.data.history).toHaveLength(1); expect(f.store.data.relations).toHaveLength(2);
    await f.records.clearHistory(); expect(f.store.data.relations).toHaveLength(2);
    await f.engine.execute(f.intent({ action: "copy" })); await f.records.clearRelations();
    expect(f.store.data.history[0].action).toBe("copy"); expect(f.store.data.relations).toHaveLength(0);
  });
  it("does not resurrect cleared collections when a pending receipt is retried", async () => {
    const f = citationFixture(); f.save.mockRejectedValueOnce(new Error("write failed")); const intent = f.intent();
    await f.engine.execute(intent, { ticket: f.ticket() }); await f.records.clearHistory(); await f.records.clearRelations();
    expect(await f.records.retry(intent.operationId)).toBe("saved");
    expect(f.store.data.history).toEqual([]); expect(f.store.data.relations).toEqual([]);
  });
  it("honors disabling records while a save is pending and does not restore them on later retry", async () => {
    const f = citationFixture(); let fail!: (reason: Error) => void;
    f.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const intent = f.intent(); const pending = f.engine.execute(intent, { ticket: f.ticket() });
    await new Promise<void>((resolve) => { const poll = () => fail ? resolve() : queueMicrotask(poll); poll(); });
    f.store.data.settings.historyEnabled = false; f.records.settingsChanged(); fail(new Error("failed")); await pending;
    f.store.data.settings.historyEnabled = true; await f.records.retry(intent.operationId);
    expect(f.store.data.history).toHaveLength(0); expect(f.store.data.relations).toHaveLength(0);
  });
  it("does not evict old snapshots at the count limit and reports partial coverage", async () => {
    const f = citationFixture(); await f.engine.execute(f.intent(), { ticket: f.ticket() });
    const old = f.store.data.relations[0];
    f.store.data.relations = Array.from({ length: RELATION_LIMIT }, (_, i) => ({ ...old, id: `old-${i}` }));
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(result).toMatchObject({ effect: "inserted", recording: "capacity-exceeded", code: "RECORD_CAPACITY_EXCEEDED" });
    expect(f.store.data.relations).toHaveLength(RELATION_LIMIT); expect(f.store.data.relations[0].id).toBe("old-0");
    expect(f.store.data.history[0].relationId).toBeUndefined();
  });
  it("applies the UTF-8 byte limit and retains a complete history receipt", async () => {
    const f = citationFixture(); await f.engine.execute(f.intent(), { ticket: f.ticket() });
    f.store.data.relations[0].content = "中".repeat(4 * 1024 * 1024);
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket("b") });
    expect(result.recording).toBe("capacity-exceeded"); expect(f.store.data.relations).toHaveLength(1); expect(f.store.data.history).toHaveLength(2);
  });
});
