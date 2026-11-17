import { describe, expect, it, vi } from "vitest";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DeskService } from "../src/domain/DeskService";

function fixture() {
  const save = vi.fn(async (_data: unknown) => {});
  const store = new PluginDataStore({ load: async () => null, save, backup: async () => {} });
  return { service: new DeskService(store), store, save };
}

describe("DeskService", () => {
  it("creates a desk and reports duplicate and invalid names without adding it", async () => {
    const f = fixture();
    const created = await f.service.create({ name: "Alpha", targetPath: "Drafts/A.md" });
    expect(created.saved).toBe(true);
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

  it("renames, rejects duplicates and deletes by id without reviving", async () => {
    const f = fixture();
    const a = (await f.service.create({ name: "Alpha", targetPath: "A.md" })).desk!;
    const b = (await f.service.create({ name: "Beta", targetPath: "B.md" })).desk!;
    expect(await f.service.rename(b.id, "Alpha")).toBe("duplicateName");
    expect(await f.service.rename(b.id, "Gamma")).toBe("ok");
    expect(f.service.get(b.id)!.name).toBe("Gamma");
    const generation = f.service.generation(b.id);
    await f.service.delete(b.id);
    expect(f.service.exists(b.id)).toBe(false);
    expect(f.service.generation(b.id)).toBe(generation + 1);
    expect(f.service.get(a.id)).toBeTruthy();
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

  it("updates target and link paths on a real rename using folder boundaries", async () => {
    const f = fixture();
    const desk = (await f.service.create({ name: "Alpha", targetPath: "Research/A2/Note.md" })).desk!;
    f.service.addRule(desk.id, { kind: "folder", value: "Research/A2", options: { includeSubfolders: true } });
    await f.service.renamePaths("Research/A2", "Research/B2", true);
    expect(f.service.get(desk.id)!.targetPath).toBe("Research/B2/Note.md");
    expect(f.service.get(desk.id)!.rules[0].spec.value).toBe("Research/B2");
  });
});
