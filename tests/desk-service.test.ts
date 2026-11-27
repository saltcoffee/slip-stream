import { describe, expect, it, vi } from "vitest";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DeskService } from "../src/domain/DeskService";
import type { EvidenceEntry } from "../src/domain/outlineTypes";

function fixture() {
  const save = vi.fn(async (_data: unknown) => {});
  const store = new PluginDataStore({ load: async () => null, save, backup: async () => {} });
  return { service: new DeskService(store), store, save };
}

function sampleEntry(id: string, sourcePath: string, targetPath?: string): EvidenceEntry {
  return {
    id,
    groupId: null,
    snapshot: {
      content: "Paragraph",
      mode: "block",
      source: {
        path: sourcePath,
        capturedPath: sourcePath,
        title: "Note",
        capturedAt: 100,
        sourceLength: 9,
        identity: "path-reference",
      },
      origins: [{ range: { from: 0, to: 9 }, rawText: "Paragraph", kind: "paragraph", before: "", after: "" }],
      selectedRanges: [{ from: 0, to: 9 }],
    },
    note: "My note",
    contentRevision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...(targetPath ? {
      lastInsertion: {
        batchId: "b1",
        operationId: "b1:i1",
        targetPath,
        at: 150,
        contentRevision: 1,
        commitSequence: 1,
      },
    } : {}),
  };
}

describe("DeskService", () => {
  it("creates a desk with an empty outline and reports duplicate and invalid names", async () => {
    const f = fixture();
    const created = await f.service.create({ name: "Alpha", targetPath: "Drafts/A.md" });
    expect(created.saved).toBe(true);
    expect(created.desk?.outline).toEqual({ groups: [], entries: [] });
    expect(f.service.list()).toHaveLength(1);
    expect(await f.service.create({ name: "Alpha", targetPath: "Drafts/B.md" })).toMatchObject({ result: "duplicateName", saved: false });
    expect(await f.service.create({ name: "   ", targetPath: "Drafts/B.md" })).toMatchObject({ result: "invalidName", saved: false });
    expect(f.service.list()).toHaveLength(1);
  });

  it("reuses the same desk when retrying after a failed first save", async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new Error("disk"));
    const first = await f.service.create({ id: "create-1", name: "Alpha", targetPath: "Drafts/A.md" });
    expect(first.saved).toBe(false);
    expect(f.service.list()).toHaveLength(1);
    expect(f.service.isDirty(first.desk!.id)).toBe(true);
    const retry = await f.service.create({ id: "create-1", name: "Alpha", targetPath: "Drafts/A.md" });
    expect(retry.saved).toBe(true);
    expect(f.service.list()).toHaveLength(1);
    expect(f.service.isDirty(first.desk!.id)).toBe(false);
  });

  it("does not reuse an unrelated same-name desk when the operation id differs", async () => {
    const f = fixture();
    const a = await f.service.create({ id: "op-1", name: "Alpha", targetPath: "A.md" });
    const b = await f.service.create({ id: "op-2", name: "Alpha", targetPath: "B.md" });
    expect(a.saved).toBe(true);
    expect(b.result).toBe("duplicateName");
    expect(f.service.list()).toHaveLength(1);
    expect(f.service.list()[0].targetPath).toBe("A.md");
  });

  it("retries the same operation id even after another root save persisted the candidate", async () => {
    const f = fixture();
    f.save.mockRejectedValueOnce(new Error("disk"));
    const first = await f.service.create({ id: "op-1", name: "Alpha", targetPath: "A.md" });
    expect(first.saved).toBe(false);
    await f.store.save();
    expect(f.service.isDirty(first.desk!.id)).toBe(false);
    const retry = await f.service.create({ id: "op-1", name: "Alpha", targetPath: "A.md" });
    expect(retry.saved).toBe(true);
    expect(f.service.list()).toHaveLength(1);
  });

  it("renames, rejects duplicates and deletes by id along with its private outline without reviving or clearing global records", async () => {
    const f = fixture();
    const a = (await f.service.create({ name: "Alpha", targetPath: "A.md" })).desk!;
    const b = (await f.service.create({ name: "Beta", targetPath: "B.md" })).desk!;
    await f.service.mutateOutline(b.id, 0, (outline) => {
      outline.entries.push(sampleEntry("e1", "Sources/One.md"));
    });
    f.store.data.history.push({ id: "h1", operationId: "op1", at: 1, action: "insert", sourcePath: "Sources/One.md", targetPath: "B.md", template: "A", snippet: "Paragraph" });
    expect(await f.service.rename(b.id, "Alpha")).toBe("duplicateName");
    expect(await f.service.rename(b.id, "Gamma")).toBe("ok");
    expect(f.service.get(b.id)!.name).toBe("Gamma");
    const generation = f.service.generation(b.id);
    await f.service.delete(b.id);
    expect(f.service.exists(b.id)).toBe(false);
    expect(f.service.generation(b.id)).toBe(generation + 1);
    expect(f.service.outlineRevision(b.id)).toBe(0);
    expect(f.service.get(a.id)).toBeTruthy();
    expect(f.store.data.history).toHaveLength(1);
  });

  it("preserves private outline when changing desk target", async () => {
    const f = fixture();
    const desk = (await f.service.create({ name: "Alpha", targetPath: "Drafts/Old.md" })).desk!;
    await f.service.mutateOutline(desk.id, 0, (outline) => {
      outline.groups.push({ id: "g1", name: "Claims" });
      outline.entries.push(sampleEntry("e1", "Sources/One.md", "Drafts/Old.md"));
    });
    await f.service.setTarget(desk.id, "Drafts/New.md");
    const updated = f.service.get(desk.id)!;
    expect(updated.targetPath).toBe("Drafts/New.md");
    expect(updated.outline.groups).toEqual([{ id: "g1", name: "Claims" }]);
    expect(updated.outline.entries[0].lastInsertion?.targetPath).toBe("Drafts/Old.md");
  });

  it("keeps per-desk reading state independent", async () => {
    const f = fixture();
    const a = (await f.service.create({ name: "Alpha", targetPath: "A.md" })).desk!;
    const b = (await f.service.create({ name: "Beta", targetPath: "B.md" })).desk!;
    f.service.markDirty(a.id, (desk) => { desk.reading.density = "full"; desk.reading.filter = "one"; });
    f.service.markDirty(b.id, (desk) => { desk.reading.density = "compact"; });
    expect(f.service.get(a.id)!.reading.density).toBe("full");
    expect(f.service.get(b.id)!.reading.density).toBe("compact");
    expect(f.service.get(a.id)!.reading.filter).toBe("one");
  });

  it("updates target, rules, and outline source/lastInsertion paths on real rename using folder boundaries while preserving capturedPath and snapshot content", async () => {
    const f = fixture();
    const desk = (await f.service.create({ name: "Alpha", targetPath: "Research/A2/Note.md" })).desk!;
    f.service.addRule(desk.id, { kind: "folder", value: "Research/A2", options: { includeSubfolders: true } });
    await f.service.mutateOutline(desk.id, 0, (outline) => {
      outline.entries.push(sampleEntry("e1", "Research/A2/Src.md", "Research/A2/Note.md"));
      outline.entries.push(sampleEntry("e2", "Research/A20/Other.md", "Research/A20/OtherTarget.md"));
    });
    const revBefore = f.service.outlineRevision(desk.id);
    await f.service.renamePaths("Research/A2", "Research/B2", true);
    const current = f.service.get(desk.id)!;
    expect(current.targetPath).toBe("Research/B2/Note.md");
    expect(current.rules[0].spec.value).toBe("Research/B2");
    expect(current.outline.entries[0].snapshot.source.path).toBe("Research/B2/Src.md");
    expect(current.outline.entries[0].snapshot.source.capturedPath).toBe("Research/A2/Src.md");
    expect(current.outline.entries[0].snapshot.content).toBe("Paragraph");
    expect(current.outline.entries[0].snapshot.origins[0].rawText).toBe("Paragraph");
    expect(current.outline.entries[0].lastInsertion?.targetPath).toBe("Research/B2/Note.md");
    expect(current.outline.entries[0].lastInsertion?.at).toBe(150);
    // Similar folder prefix Research/A20 must not be touched
    expect(current.outline.entries[1].snapshot.source.path).toBe("Research/A20/Other.md");
    expect(current.outline.entries[1].lastInsertion?.targetPath).toBe("Research/A20/OtherTarget.md");
    expect(f.service.outlineRevision(desk.id)).toBe(revBefore + 1);
  });

  it("marks matching outline entries unconfirmed-after-loss on source deletion without deleting entries", async () => {
    const f = fixture();
    const desk = (await f.service.create({ name: "Alpha", targetPath: "Drafts/A.md" })).desk!;
    await f.service.mutateOutline(desk.id, 0, (outline) => {
      outline.entries.push(sampleEntry("e1", "Sources/Gone.md"));
      outline.entries.push(sampleEntry("e2", "Sources/Keep.md"));
    });
    await f.service.markSourceDeleted("Sources/Gone.md");
    const entries = f.service.get(desk.id)!.outline.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].snapshot.source.identity).toBe("unconfirmed-after-loss");
    expect(entries[1].snapshot.source.identity).toBe("path-reference");
  });
});
