import { describe, expect, it, vi } from "vitest";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DEFAULT_SETTINGS } from "../src/settings/settings";

const legacyRecord = { id: "old", at: 1, sourcePath: "Sources/A.md", snippet: "Saved", text: "> Saved", template: "A" };
function fixture(raw: unknown) {
  const save = vi.fn(async (_data: unknown) => {}); const backup = vi.fn(async (_raw: unknown) => {});
  return { store: new PluginDataStore({ load: async () => raw, save, backup }), save, backup };
}
describe("PluginDataStore", () => {
  it("backs up before migration, preserves valid preferences and unknown root fields", async () => {
    const raw = { settings: { ...DEFAULT_SETTINGS, defaultTemplate: "D", customTemplate: "my template", language: "zh", historyLimit: 1 }, history: [legacyRecord], futureAddon: { keep: true } };
    const f = fixture(raw); await f.store.load();
    expect(f.backup).toHaveBeenCalledWith(raw);
    expect(f.backup.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0]);
    expect(f.store.data).toMatchObject({ schemaVersion: 1, settings: raw.settings, futureAddon: { keep: true }, history: [{ action: "legacy-unknown" }], relations: [], consent: { blockIdExplanationAccepted: false } });
    expect(f.store.data.history[0].targetPath).toBeUndefined();
    const reload = fixture(f.store.data); await reload.store.load();
    expect(reload.backup).not.toHaveBeenCalled(); expect(reload.store.data).toEqual(f.store.data);
  });
  it("never overwrites legacy data when backup fails", async () => {
    const f = fixture({ history: [legacyRecord] }); f.backup.mockRejectedValueOnce(new Error("No permission"));
    await f.store.load(); expect(f.store.readOnly).toBe(true); expect(f.save).not.toHaveBeenCalled();
    await expect(f.store.save()).rejects.toThrow("DATA_READONLY");
  });
  it.each(["broken", [], { schemaVersion: 7, history: [legacyRecord] }])("does not downgrade malformed or future data %o", async (raw) => {
    const f = fixture(raw); await f.store.load(); expect(f.store.readOnly).toBe(true); expect(f.save).not.toHaveBeenCalled();
  });
  it("preserves valid records and backs up malformed individual entries", async () => {
    const f = fixture({ settings: { historyLimit: -1, blockPrecision: "yes", fontScale: NaN, language: "fr", customTemplate: "unchanged" }, history: [legacyRecord, null, { id: "broken" }] });
    await f.store.load(); expect(f.store.data.history).toHaveLength(1); expect(f.store.warning).toBe("data.invalidEntries");
    expect(f.store.data.settings).toMatchObject({ historyLimit: 200, blockPrecision: true, fontScale: 1, language: "auto", customTemplate: "unchanged" });
  });
  it("retains one migration result and backup when first v1 save fails", async () => {
    const f = fixture({ history: [legacyRecord] }); f.save.mockRejectedValueOnce(new Error("Disk full")); await f.store.load();
    expect(f.store.warning).toBe("data.migrationFailed"); await f.store.save();
    expect(f.backup).toHaveBeenCalledTimes(1); expect(f.store.data.history).toHaveLength(1);
  });
  it("serializes saves and reads latest root state rather than queued old snapshots", async () => {
    const f = fixture(null); let finish!: () => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = f.store.save(); await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1));
    f.store.data.history.push({ ...legacyRecord, operationId: "op", action: "copy" });
    const second = f.store.save(); f.store.data.settings.language = "zh";
    const third = f.store.save(); finish(); await Promise.all([first, second, third]);
    expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { language: "zh" }, history: [{ operationId: "op" }] });
  });
  it("does not accept source-ID consent until its save succeeds", async () => {
    const f = fixture(null); f.save.mockRejectedValueOnce(new Error("failure"));
    await expect(f.store.acceptBlockIds()).rejects.toThrow(); expect(f.store.data.consent.blockIdExplanationAccepted).toBe(false);
  });
  it("keeps consent unavailable to other operations until the first save completes", async () => {
    const f = fixture(null); let finish!: () => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.store.acceptBlockIds();
    expect(f.store.blockIdConsentAccepted).toBe(false);
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1));
    expect(f.store.blockIdConsentAccepted).toBe(false);
    finish(); await pending; expect(f.store.blockIdConsentAccepted).toBe(true);
  });

});
