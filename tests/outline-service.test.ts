import { describe, expect, it, vi } from "vitest";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DeskService } from "../src/domain/DeskService";
import { OutlineService } from "../src/domain/OutlineService";
import { CitationRecordsService } from "../src/domain/CitationRecords";
import { sliceContextAfter, sliceContextBefore } from "../src/domain/outlineTypes";
import type { EvidenceSnapshot } from "../src/domain/outlineTypes";

function fixture() {
  let persisted: unknown = null;
  const save = vi.fn(async (data: unknown) => {
    persisted = data;
  });
  const backup = vi.fn(async (_raw: unknown) => {});
  const store = new PluginDataStore({ load: async () => persisted, save, backup });
  const desks = new DeskService(store);
  const outlines = new OutlineService(desks, store);
  const records = new CitationRecordsService(store);
  return { store, desks, outlines, records, save, backup, persisted: () => persisted };
}

function snapshotOf(text: string, from: number, to: number, path = "Sources/Note.md", blockId?: string): EvidenceSnapshot {
  const rawText = text.slice(from, to);
  return {
    content: rawText,
    mode: "block",
    source: {
      path,
      capturedPath: path,
      title: path.split("/").pop()!.replace(/\.md$/, ""),
      capturedAt: 100,
      sourceLength: text.length,
      identity: "path-reference",
    },
    origins: [
      {
        range: { from, to },
        rawText,
        kind: "paragraph",
        ...(blockId ? { blockId } : {}),
        before: sliceContextBefore(text, from),
        after: sliceContextAfter(text, to),
      },
    ],
    selectedRanges: [{ from, to }],
  };
}

describe("OutlineService", () => {
  it("detects confirmable duplicates, allows explicit second collection, and separates identical sentences at different positions (AC-06)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    const source = "Same sentence.\n\nSame sentence.";
    const firstSnap = snapshotOf(source, 0, 14);
    const secondPosSnap = snapshotOf(source, 16, 30);

    const first = await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: firstSnap });
    expect(first.ok).toBe(true);
    expect(first.saved).toBe(true);
    expect(first.outlineRevision).toBe(1);

    const dup = await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e2", snapshot: firstSnap });
    expect(dup).toMatchObject({ ok: false, code: "DUPLICATE_ENTRY", duplicateEntryId: "e1" });

    const explicitDup = await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e2", snapshot: firstSnap, allowDuplicate: true });
    expect(explicitDup.ok).toBe(true);
    expect(explicitDup.outlineRevision).toBe(2);

    const distinctPos = await f.outlines.collect({ deskId: desk.id, expectedRevision: 2, entryId: "e3", snapshot: secondPosSnap });
    expect(distinctPos.ok).toBe(true);
    expect(f.outlines.getOutline(desk.id)?.outline.entries).toHaveLength(3);
  });

  it("retries failed collect with the same entryId without duplicating, and clears dirty via later root save (AC-06, AC-33)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    const snap = snapshotOf("First paragraph", 0, 15);
    f.save.mockRejectedValueOnce(new Error("disk error"));

    const failed = await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snap });
    expect(failed).toMatchObject({ ok: true, saved: false, code: "OUTLINE_SAVE_FAILED", outlineRevision: 1 });
    expect(f.outlines.isDirty(desk.id)).toBe(true);

    // Retry with same entryId only saves without adding a second entry
    const retry = await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snap });
    expect(retry).toMatchObject({ ok: true, saved: true, outlineRevision: 1 });
    expect(f.outlines.getOutline(desk.id)?.outline.entries).toHaveLength(1);
    expect(f.outlines.isDirty(desk.id)).toBe(false);

    // Another collect fails save, then a note edit triggers a shared root save that succeeds
    f.save.mockRejectedValueOnce(new Error("disk error"));
    const snap2 = snapshotOf("Second paragraph", 0, 16, "Sources/Two.md");
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e2", snapshot: snap2 });
    expect(f.outlines.isDirty(desk.id)).toBe(true);

    const noted = await f.outlines.setNote({ deskId: desk.id, expectedRevision: 2, entryId: "e2", expectedContentRevision: 1, note: "Key point" });
    expect(noted).toMatchObject({ ok: true, saved: true });
    expect(f.outlines.isDirty(desk.id)).toBe(false);
    expect(await f.outlines.collect({ deskId: desk.id, expectedRevision: 2, entryId: "e2", snapshot: snap2 })).toMatchObject({ ok: true, saved: true });
    expect(f.outlines.getOutline(desk.id)?.outline.entries).toHaveLength(2);
  });

  it("blocks writes on readOnly store and rejects stale desk revisions or deleted desks (AC-33)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    const gen = f.desks.generation(desk.id);
    f.store.readOnly = true;
    expect(await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snapshotOf("A", 0, 1) })).toMatchObject({
      ok: false,
      code: "OUTLINE_READONLY",
    });
    expect(f.outlines.getOutline(desk.id)?.outline.entries).toHaveLength(0);

    f.store.readOnly = false;
    await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "Group A", groupId: "g1" });
    expect(await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snapshotOf("A", 0, 1) })).toMatchObject({
      ok: false,
      code: "DESK_STALE",
      outlineRevision: 1,
    });

    await f.desks.delete(desk.id);
    expect(await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e1", snapshot: snapshotOf("A", 0, 1), deskGeneration: gen })).toMatchObject({
      ok: false,
      code: "DESK_DELETED",
    });
  });

  it("saves plain-text notes with contentRevision check, keeps history/relations intact on entry removal, and preserves outline when history/relations are cleared (AC-07, AC-30)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snapshotOf("Quote", 0, 5) });

    const noteRes = await f.outlines.setNote({ deskId: desk.id, expectedRevision: 1, entryId: "e1", expectedContentRevision: 1, note: "Line 1\n<b>raw</b>" });
    expect(noteRes.ok).toBe(true);
    expect(noteRes.entry?.contentRevision).toBe(2);

    // Late stale note input with old expectedContentRevision=1 is rejected
    expect(await f.outlines.setNote({ deskId: desk.id, expectedRevision: 2, entryId: "e1", expectedContentRevision: 1, note: "Stale overwrite" })).toMatchObject({
      ok: false,
      code: "ENTRY_STALE",
    });
    expect(f.outlines.getEntry(desk.id, "e1")?.note).toBe("Line 1\n<b>raw</b>");

    // Record citation, then verify clearing history/relations does not delete outline
    const frozen = f.records.freezeBatchCommit(true);
    await f.records.recordBatch({
      batchId: "b1",
      deskId: desk.id,
      targetPath: "Drafts/Main.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: true,
      items: [{
        operationId: "b1:i1",
        entryId: "e1",
        contentRevision: 2,
        history: { id: "h1", operationId: "b1:i1", at: frozen.at, action: "insert", sourcePath: "Sources/Note.md", targetPath: "Drafts/Main.md", template: "A", snippet: "Quote" },
        relation: {
          id: "r1",
          operationId: "b1:i1",
          at: frozen.at,
          sourcePath: "Sources/Note.md",
          targetPath: "Drafts/Main.md",
          sourceSpans: [{ range: { from: 0, to: 5 }, rawText: "Quote", kind: "paragraph" }],
          content: "Quote",
          insertedText: "> Quote",
          precision: "block",
          sourceState: "verified",
          template: "A",
          targetHint: { range: { from: 0, to: 7 }, before: "", after: "" },
        },
      }],
    });
    await f.records.clearHistory();
    await f.records.clearRelations();
    expect(f.outlines.getEntry(desk.id, "e1")).toBeDefined();
    expect(f.outlines.getEntry(desk.id, "e1")?.lastInsertion?.contentRevision).toBe(2);

    // Removing entry keeps global records intact
    await f.records.record({ id: "h2", operationId: "op2", at: 200, action: "insert", sourcePath: "Sources/Note.md", targetPath: "Drafts/Main.md", template: "A", snippet: "Quote" });
    await f.outlines.removeEntry({ deskId: desk.id, expectedRevision: 2, entryId: "e1" });
    expect(f.outlines.getOutline(desk.id)?.outline.entries).toEqual([]);
    expect(f.store.data.history).toHaveLength(1);
  });

  it("validates single-layer group names, reorders groups, moves entries across/within zones, and moves entries back on group delete (AC-08, AC-09, AC-10)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;

    expect(await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "   " })).toMatchObject({ ok: false, code: "GROUP_NAME_INVALID" });
    expect(await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "Line1\nLine2" })).toMatchObject({ ok: false, code: "GROUP_NAME_INVALID" });
    expect(await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "x".repeat(81) })).toMatchObject({ ok: false, code: "GROUP_NAME_INVALID" });

    await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "Efficiency", groupId: "g1" });
    expect(await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 1, name: "efficiency" })).toMatchObject({ ok: false, code: "GROUP_NAME_DUPLICATE" });
    await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 1, name: "Risks", groupId: "g2" });

    // Rename & reorder groups
    expect(await f.outlines.renameGroup({ deskId: desk.id, expectedRevision: 2, groupId: "g2", name: "Collaboration Costs" })).toMatchObject({ ok: true, group: { id: "g2", name: "Collaboration Costs" } });
    expect(await f.outlines.moveGroup({ deskId: desk.id, expectedRevision: 3, groupId: "g2", direction: "up" })).toMatchObject({ ok: true, moved: true });
    expect(f.outlines.getOutline(desk.id)?.outline.groups.map((g) => g.id)).toEqual(["g2", "g1"]);

    // Collect 3 entries and organize
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 4, entryId: "e1", snapshot: snapshotOf("One", 0, 3, "Sources/1.md") });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 5, entryId: "e2", snapshot: snapshotOf("Two", 0, 3, "Sources/2.md") });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 6, entryId: "e3", snapshot: snapshotOf("Three", 0, 5, "Sources/3.md") });

    // Move e1 and e2 into g1, swap e2 up inside g1 (contentRevision stays 1)
    await f.outlines.moveEntry({ deskId: desk.id, expectedRevision: 7, entryId: "e1", targetGroupId: "g1" });
    await f.outlines.moveEntry({ deskId: desk.id, expectedRevision: 8, entryId: "e2", targetGroupId: "g1" });
    await f.outlines.moveEntry({ deskId: desk.id, expectedRevision: 9, entryId: "e2", direction: "up" });

    const g1Entries = f.outlines.selectEntries(desk.id, { kind: "group", groupId: "g1" })!.entries;
    expect(g1Entries.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(g1Entries.every((e) => e.contentRevision === 1)).toBe(true);

    // Remove non-empty group g1: entries return to collection zone after existing e3, in g1 order [e2, e1], in ONE root save
    f.save.mockClear();
    const removed = await f.outlines.removeGroup({ deskId: desk.id, expectedRevision: 10, groupId: "g1" });
    expect(removed.ok).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
    const afterRemove = f.outlines.getOutline(desk.id)!.outline;
    expect(afterRemove.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(afterRemove.entries.map((e) => [e.id, e.groupId])).toEqual([["e3", null], ["e2", null], ["e1", null]]);
  });

  it("refreshes only the selected entry snapshot while preserving note, group, order, and marking previous insertion stale (AC-17, AC-30)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    await f.outlines.createGroup({ deskId: desk.id, expectedRevision: 0, name: "Claims", groupId: "g1" });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 1, entryId: "e1", snapshot: snapshotOf("Old text", 0, 8, "Sources/A.md") });
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 2, entryId: "e2", snapshot: snapshotOf("Old text", 0, 8, "Sources/A.md"), allowDuplicate: true });
    await f.outlines.moveEntry({ deskId: desk.id, expectedRevision: 3, entryId: "e1", targetGroupId: "g1" });
    await f.outlines.setNote({ deskId: desk.id, expectedRevision: 4, entryId: "e1", expectedContentRevision: 1, note: "Keep this note" });

    const frozen = f.records.freezeBatchCommit(true);
    await f.records.recordBatch({
      batchId: "b1",
      deskId: desk.id,
      targetPath: "Drafts/Main.md",
      at: frozen.at,
      commitSequence: frozen.commitSequence,
      recordingEligible: true,
      items: [{
        operationId: "b1:i1",
        entryId: "e1",
        contentRevision: 2,
        history: { id: "h1", operationId: "b1:i1", at: frozen.at, action: "insert", sourcePath: "Sources/A.md", targetPath: "Drafts/Main.md", template: "A", snippet: "Old text" },
      }],
    });

    const refreshed = await f.outlines.refreshEntry({
      deskId: desk.id,
      expectedRevision: 5,
      entryId: "e1",
      expectedContentRevision: 2,
      snapshot: snapshotOf("New source text", 0, 15, "Sources/A.md"),
    });
    expect(refreshed.ok).toBe(true);
    const e1 = f.outlines.getEntry(desk.id, "e1")!;
    const e2 = f.outlines.getEntry(desk.id, "e2")!;
    expect(e1.snapshot.content).toBe("New source text");
    expect(e1.note).toBe("Keep this note");
    expect(e1.groupId).toBe("g1");
    expect(e1.contentRevision).toBe(3);
    expect(e1.lastInsertion?.contentRevision).toBe(2);
    expect(e2.snapshot.content).toBe("Old text");
    expect(e2.contentRevision).toBe(1);
  });

  it("persists 10-source / 12-entry / 3-group workflow across restarts and keeps desks independent (AC-11, AC-12)", async () => {
    const f = fixture();
    const deskA = (await f.desks.create({ name: "Remote Work", targetPath: "Drafts/Remote.md" })).desk!;
    const deskB = (await f.desks.create({ name: "Other Desk", targetPath: "Drafts/Other.md" })).desk!;

    let rev = 0;
    await f.outlines.createGroup({ deskId: deskA.id, expectedRevision: rev++, name: "Efficiency", groupId: "g1" });
    await f.outlines.createGroup({ deskId: deskA.id, expectedRevision: rev++, name: "Collaboration", groupId: "g2" });
    await f.outlines.createGroup({ deskId: deskA.id, expectedRevision: rev++, name: "Conditions", groupId: "g3" }); // empty group

    for (let i = 1; i <= 12; i++) {
      const sourceIndex = ((i - 1) % 10) + 1;
      const text = `Excerpt ${i} from source ${sourceIndex}`;
      const snap = snapshotOf(text, 0, text.length, `Sources/Note-${sourceIndex}.md`);
      await f.outlines.collect({ deskId: deskA.id, expectedRevision: rev++, entryId: `e-${i}`, snapshot: snap, allowDuplicate: true });
      if (i > 2 && i <= 7) {
        await f.outlines.moveEntry({ deskId: deskA.id, expectedRevision: rev++, entryId: `e-${i}`, targetGroupId: "g1" });
      } else if (i > 7) {
        await f.outlines.moveEntry({ deskId: deskA.id, expectedRevision: rev++, entryId: `e-${i}`, targetGroupId: "g2" });
      }
      await f.outlines.setNote({ deskId: deskA.id, expectedRevision: rev++, entryId: `e-${i}`, expectedContentRevision: 1, note: `Note ${i}` });
    }

    // Same source collected independently in deskB
    await f.outlines.collect({ deskId: deskB.id, expectedRevision: 0, entryId: "b-1", snapshot: snapshotOf("Excerpt 1 from source 1", 0, 23, "Sources/Note-1.md") });
    expect(f.outlines.getOutline(deskB.id)?.outline.entries).toHaveLength(1);

    // Simulate restart
    const reloadedStore = new PluginDataStore({ load: async () => f.persisted(), save: async () => {}, backup: async () => {} });
    await reloadedStore.load();
    expect(reloadedStore.readOnly).toBe(false);
    const reloadedOutlines = new OutlineService(new DeskService(reloadedStore), reloadedStore);
    const reloadedA = reloadedOutlines.getOutline(deskA.id)!.outline;
    expect(reloadedA.groups.map((g) => g.name)).toEqual(["Efficiency", "Collaboration", "Conditions"]);
    expect(reloadedA.entries).toHaveLength(12);
    expect(reloadedA.entries.filter((e) => e.groupId === null)).toHaveLength(2);
    expect(reloadedA.entries.filter((e) => e.groupId === "g1")).toHaveLength(5);
    expect(reloadedA.entries.filter((e) => e.groupId === "g2")).toHaveLength(5);
    expect(reloadedA.entries.filter((e) => e.groupId === "g3")).toHaveLength(0);
    expect(reloadedA.entries[0].note).toBe("Note 1");
  });

  it("keeps newer debounced note edits dirty when an earlier save receipt resolves (AC-33)", async () => {
    const f = fixture();
    const desk = (await f.desks.create({ name: "Desk", targetPath: "Drafts/Main.md" })).desk!;
    await f.outlines.collect({ deskId: desk.id, expectedRevision: 0, entryId: "e1", snapshot: snapshotOf("Text", 0, 4) });

    let finishFirst!: () => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const firstSave = f.outlines.setNote({ deskId: desk.id, expectedRevision: 1, entryId: "e1", expectedContentRevision: 1, note: "V1" });
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(3));

    const secondEdit = await f.outlines.setNote({
      deskId: desk.id,
      expectedRevision: 2,
      entryId: "e1",
      expectedContentRevision: 2,
      note: "V2",
      persist: false,
    });
    expect(secondEdit).toMatchObject({ ok: true, saved: false, outlineRevision: 3 });

    finishFirst();
    await firstSave;
    // Older receipt for V1 must NOT clear dirty state of V2
    expect(f.outlines.isDirty(desk.id)).toBe(true);

    const flushed = await f.outlines.save(desk.id);
    expect(flushed).toEqual({ saved: true });
    expect(f.outlines.isDirty(desk.id)).toBe(false);
    expect(f.outlines.getEntry(desk.id, "e1")?.note).toBe("V2");
  });
});
