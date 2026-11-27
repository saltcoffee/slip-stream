import { describe, expect, it, vi } from "vitest";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DEFAULT_SETTINGS } from "../src/settings/settings";

const legacyRecord = { id: "old", at: 1, sourcePath: "Sources/A.md", snippet: "Saved", text: "> Saved", template: "A" };

function fixture(raw: unknown) {
  const save = vi.fn(async (_data: unknown) => {});
  const backup = vi.fn(async (_raw: unknown) => {});
  return { store: new PluginDataStore({ load: async () => raw, save, backup }), save, backup };
}

function v2Desk(id: string, name: string) {
  return {
    id,
    name,
    targetPath: "Drafts/A.md",
    rules: [{ id: "r1", spec: { kind: "folder", value: "Sources" } }],
    manualPaths: ["Sources/Extra.md"],
    reading: {
      density: "snippet",
      filter: "",
      sort: "mtime",
      sortAsc: false,
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
  };
}

function validEntry(id: string, groupId: string | null, overrides: Record<string, unknown> = {}) {
  const rawText = "Original paragraph";
  return {
    id,
    groupId,
    snapshot: {
      content: rawText,
      mode: "block",
      source: {
        path: "Sources/A.md",
        capturedPath: "Sources/A.md",
        title: "A",
        capturedAt: 100,
        sourceLength: rawText.length,
        identity: "path-reference",
      },
      origins: [
        {
          range: { from: 0, to: rawText.length },
          rawText,
          kind: "paragraph",
          before: "",
          after: "",
        },
      ],
      selectedRanges: [{ from: 0, to: rawText.length }],
    },
    note: "",
    contentRevision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function v3Root(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    relations: [],
    consent: { blockIdExplanationAccepted: true },
    desks: [],
    lastCommitSequence: 0,
    ...overrides,
  };
}

describe("PluginDataStore", () => {
  it("backs up before migrating v0 directly to v3, preserving preferences and unknown root fields", async () => {
    const raw = {
      settings: { ...DEFAULT_SETTINGS, defaultTemplate: "D", customTemplate: "my template", language: "zh", historyLimit: 1 },
      history: [legacyRecord],
      futureAddon: { keep: true },
    };
    const f = fixture(raw);
    await f.store.load();
    expect(f.backup).toHaveBeenCalledTimes(1);
    expect(f.backup).toHaveBeenCalledWith(raw);
    expect(f.backup.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0]);
    expect(f.store.data).toMatchObject({
      schemaVersion: 3,
      settings: raw.settings,
      futureAddon: { keep: true },
      history: [{ action: "legacy-unknown" }],
      relations: [],
      consent: { blockIdExplanationAccepted: false },
      desks: [],
      lastCommitSequence: 0,
    });
    expect(f.store.data.history[0].targetPath).toBeUndefined();
    const reload = fixture(f.store.data);
    await reload.store.load();
    expect(reload.backup).not.toHaveBeenCalled();
    expect(reload.save).not.toHaveBeenCalled();
    expect(reload.store.data).toEqual(f.store.data);
  });

  it("upgrades schemaVersion 1 directly to v3 without entering read-only", async () => {
    const { collectionPageSize: _pageSize, ...legacySettings } = DEFAULT_SETTINGS;
    const raw = {
      schemaVersion: 1,
      settings: { ...legacySettings, collectionLimit: 50 },
      history: [legacyRecord],
      relations: [],
      consent: { blockIdExplanationAccepted: true },
    };
    const f = fixture(raw);
    await f.store.load();
    expect(f.store.readOnly).toBe(false);
    expect(f.store.data.schemaVersion).toBe(3);
    expect(f.store.data.settings.collectionPageSize).toBe(50);
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.data.desks).toEqual([]);
    expect(f.store.data.lastCommitSequence).toBe(0);
    expect(f.backup).toHaveBeenCalledTimes(1);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("migrates v2 desks to v3 with empty outlines, preserving all v2 fields after a single backup", async () => {
    const raw = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS },
      history: [legacyRecord],
      relations: [],
      consent: { blockIdExplanationAccepted: true },
      desks: [v2Desk("d1", "Alpha")],
      futureAddon: { keep: true },
    };
    const f = fixture(raw);
    await f.store.load();
    expect(f.store.readOnly).toBe(false);
    expect(f.backup).toHaveBeenCalledTimes(1);
    expect(f.backup.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0]);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.store.data.schemaVersion).toBe(3);
    expect(f.store.data.lastCommitSequence).toBe(0);
    expect(f.store.data.desks[0].outline).toEqual({ groups: [], entries: [] });
    expect(f.store.data.desks[0].rules).toHaveLength(1);
    expect(f.store.data.desks[0].manualPaths).toEqual(["Sources/Extra.md"]);
    expect((f.store.data as Record<string, unknown>).futureAddon).toEqual({ keep: true });
  });

  it("never overwrites v2 data when backup fails during v2->v3 migration", async () => {
    const raw = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS },
      history: [],
      relations: [],
      consent: { blockIdExplanationAccepted: false },
      desks: [v2Desk("d1", "Alpha")],
    };
    const f = fixture(raw);
    f.backup.mockRejectedValueOnce(new Error("No permission"));
    await f.store.load();
    expect(f.store.readOnly).toBe(true);
    expect(f.store.warning).toBe("data.backupFailed");
    expect(f.save).not.toHaveBeenCalled();
    await expect(f.store.save()).rejects.toThrow("DATA_READONLY");
  });

  it("never overwrites legacy data when backup fails", async () => {
    const f = fixture({ history: [legacyRecord] });
    f.backup.mockRejectedValueOnce(new Error("No permission"));
    await f.store.load();
    expect(f.store.readOnly).toBe(true);
    expect(f.save).not.toHaveBeenCalled();
    await expect(f.store.save()).rejects.toThrow("DATA_READONLY");
  });

  it.each(["broken", [], { schemaVersion: 7, history: [legacyRecord] }, { schemaVersion: 4, desks: [] }])(
    "does not downgrade malformed or future data %o",
    async (raw) => {
      const f = fixture(raw);
      await f.store.load();
      expect(f.store.readOnly).toBe(true);
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it("preserves valid records and backs up malformed individual entries", async () => {
    const f = fixture({
      settings: { historyLimit: -1, blockPrecision: "yes", fontScale: NaN, language: "fr", customTemplate: "unchanged" },
      history: [legacyRecord, null, { id: "broken" }],
    });
    await f.store.load();
    expect(f.store.data.history).toHaveLength(1);
    expect(f.store.warning).toBe("data.invalidEntries");
    expect(f.store.data.settings).toMatchObject({ historyLimit: 200, blockPrecision: true, fontScale: 1, language: "auto", customTemplate: "unchanged" });
  });

  it("retains one migration result and backup when first migration save fails", async () => {
    const f = fixture({
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS },
      history: [legacyRecord],
      relations: [],
      consent: { blockIdExplanationAccepted: false },
      desks: [v2Desk("d1", "Alpha")],
    });
    f.save.mockRejectedValueOnce(new Error("Disk full"));
    await f.store.load();
    expect(f.store.warning).toBe("data.migrationFailed");
    await f.store.save();
    expect(f.backup).toHaveBeenCalledTimes(1);
    expect(f.store.data.schemaVersion).toBe(3);
    expect(f.store.data.desks[0].outline).toEqual({ groups: [], entries: [] });
  });

  it("serializes saves, preserves newer rootRevision against stale SaveReceipts, and reads latest root state", async () => {
    const f = fixture(null);
    let finishFirst!: () => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const rev1 = f.store.touch();
    const first = f.store.save();
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1));

    f.store.data.history.push({ ...legacyRecord, operationId: "op", action: "copy" });
    const rev2 = f.store.touch();
    const second = f.store.save();
    f.store.data.settings.language = "zh";
    const rev3 = f.store.touch();
    const third = f.store.save();

    finishFirst();
    const firstReceipt = await first;
    expect(firstReceipt.persistedRevision).toBe(rev1);
    expect(f.store.isPersisted(rev1)).toBe(true);
    expect(f.store.isPersisted(rev2)).toBe(false);

    const [, thirdReceipt] = await Promise.all([second, third]);
    expect(thirdReceipt.persistedRevision).toBe(rev3);
    expect(f.store.isPersisted(rev3)).toBe(true);
    expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ settings: { language: "zh" }, history: [{ operationId: "op" }] });
  });

  it("does not accept source-ID consent until its save succeeds", async () => {
    const f = fixture(null);
    f.save.mockRejectedValueOnce(new Error("failure"));
    await expect(f.store.acceptBlockIds()).rejects.toThrow();
    expect(f.store.data.consent.blockIdExplanationAccepted).toBe(false);
  });

  it("keeps consent unavailable to other operations until the first save completes", async () => {
    const f = fixture(null);
    let finish!: () => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.store.acceptBlockIds();
    expect(f.store.blockIdConsentAccepted).toBe(false);
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(1));
    expect(f.store.blockIdConsentAccepted).toBe(false);
    finish();
    await pending;
    expect(f.store.blockIdConsentAccepted).toBe(true);
  });
});

describe("PluginDataStore v3 desks, outlines, and boundary validation", () => {
  it("loads valid v3 desks, outlines, lastCommitSequence, and new relation states idempotently", async () => {
    const raw = v3Root({
      lastCommitSequence: 4,
      relations: [
        {
          id: "rel-1",
          batchId: "batch-1",
          operationId: "batch-1:item-1",
          at: 200,
          sourcePath: "Sources/A.md",
          targetPath: "Drafts/A.md",
          sourceSpans: [{ range: { from: 0, to: 18 }, rawText: "Original paragraph", kind: "paragraph" }],
          content: "Original paragraph",
          insertedText: "> Original paragraph",
          precision: "file",
          sourceState: "missing-snapshot",
          template: "A",
          targetHint: { range: { from: 0, to: 20 }, before: "", after: "" },
        },
      ],
      desks: [
        {
          ...v2Desk("d1", "Alpha"),
          outline: {
            groups: [{ id: "g1", name: "Thesis" }],
            entries: [
              validEntry("e1", "g1", {
                note: "Line 1\nLine 2",
                contentRevision: 2,
                lastInsertion: {
                  batchId: "batch-1",
                  operationId: "batch-1:item-1",
                  targetPath: "Drafts/A.md",
                  at: 200,
                  contentRevision: 1,
                  commitSequence: 4,
                },
              }),
            ],
          },
        },
      ],
      futureAddon: { keep: true },
    });
    const f = fixture(raw);
    await f.store.load();
    expect(f.store.readOnly).toBe(false);
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.store.data.lastCommitSequence).toBe(4);
    expect(f.store.data.desks[0].outline.entries[0].lastInsertion?.commitSequence).toBe(4);
    expect((f.store.data as Record<string, unknown>).futureAddon).toEqual({ keep: true });
  });

  it("backs up before normalizing v3 desk and group names", async () => {
    const raw = v3Root({
      desks: [
        {
          ...v2Desk("d1", "  Alpha  "),
          outline: { groups: [{ id: "g1", name: "  Claims  " }], entries: [] },
        },
      ],
    });
    const f = fixture(raw);
    await f.store.load();
    expect(f.backup).toHaveBeenCalledWith(raw);
    expect(f.store.data.desks[0].name).toBe("Alpha");
    expect(f.store.data.desks[0].outline.groups[0].name).toBe("Claims");
  });

  it("enters read-only for invalid lastCommitSequence without overwriting", async () => {
    for (const bad of [-1, 1.5, "2", NaN, undefined]) {
      const f = fixture(v3Root({ lastCommitSequence: bad }));
      await f.store.load();
      expect(f.store.readOnly).toBe(true);
      expect(f.save).not.toHaveBeenCalled();
    }
  });

  it("handles empty targetPath consistently across v2->v3 migration and v3 reload, while rejecting invalid non-empty targetPaths", async () => {
    const v2EmptyTarget = {
      schemaVersion: 2,
      settings: { ...DEFAULT_SETTINGS },
      history: [],
      relations: [],
      consent: { blockIdExplanationAccepted: false },
      desks: [{ ...v2Desk("d1", "Alpha"), targetPath: "" }],
    };
    const migrated = fixture(v2EmptyTarget);
    await migrated.store.load();
    expect(migrated.store.readOnly).toBe(false);
    expect(migrated.store.data.desks[0].targetPath).toBe("");

    const reloaded = fixture(migrated.store.data);
    await reloaded.store.load();
    expect(reloaded.store.readOnly).toBe(false);
    expect(reloaded.save).not.toHaveBeenCalled();

    for (const badDesk of [
      { ...v2Desk("d1", "Alpha"), targetPath: "../bad.md" },
      { ...v2Desk("d1", "Alpha"), targetPath: "Notes/plain.txt" },
    ]) {
      const badV2 = fixture({ ...v2EmptyTarget, desks: [badDesk] });
      await badV2.store.load();
      expect(badV2.store.readOnly).toBe(true);
      expect(badV2.save).not.toHaveBeenCalled();
    }
  });

  it("enters read-only instead of filtering malformed v3 outlines, dangling groupIds, or duplicate IDs", async () => {
    const cases: unknown[] = [
      // Missing outline
      v3Root({ desks: [v2Desk("d1", "Alpha")] }),
      // Duplicate desk ID
      v3Root({ desks: [{ ...v2Desk("d1", "A"), outline: { groups: [], entries: [] } }, { ...v2Desk("d1", "B"), outline: { groups: [], entries: [] } }] }),
      // Duplicate group name (case-insensitive)
      v3Root({ desks: [{ ...v2Desk("d1", "A"), outline: { groups: [{ id: "g1", name: "Claim" }, { id: "g2", name: "claim" }], entries: [] } }] }),
      // Multiline group name
      v3Root({ desks: [{ ...v2Desk("d1", "A"), outline: { groups: [{ id: "g1", name: "Line1\nLine2" }], entries: [] } }] }),
      // Dangling groupId
      v3Root({ desks: [{ ...v2Desk("d1", "A"), outline: { groups: [], entries: [validEntry("e1", "missing-group")] } }] }),
      // Duplicate entry id
      v3Root({ desks: [{ ...v2Desk("d1", "A"), outline: { groups: [], entries: [validEntry("e1", null), validEntry("e1", null)] } }] }),
      // commitSequence exceeds root high-water mark
      v3Root({
        lastCommitSequence: 2,
        desks: [{
          ...v2Desk("d1", "A"),
          outline: {
            groups: [],
            entries: [validEntry("e1", null, {
              lastInsertion: { batchId: "b1", operationId: "op1", targetPath: "Drafts/A.md", at: 10, contentRevision: 1, commitSequence: 3 },
            })],
          },
        }],
      }),
      // rawText length mismatch
      v3Root({
        desks: [{
          ...v2Desk("d1", "A"),
          outline: {
            groups: [],
            entries: [{
              ...validEntry("e1", null),
              snapshot: {
                ...validEntry("e1", null).snapshot,
                origins: [{ range: { from: 0, to: 5 }, rawText: "mismatch", kind: "paragraph", before: "", after: "" }],
              },
            }],
          },
        }],
      }),
      // selectedRanges outside saved origins
      v3Root({
        desks: [{
          ...v2Desk("d1", "A"),
          outline: {
            groups: [],
            entries: [{
              ...validEntry("e1", null),
              snapshot: {
                ...validEntry("e1", null).snapshot,
                selectedRanges: [{ from: 0, to: 99 }],
              },
            }],
          },
        }],
      }),
      // Unpaired surrogate in context hint
      v3Root({
        desks: [{
          ...v2Desk("d1", "A"),
          outline: {
            groups: [],
            entries: [{
              ...validEntry("e1", null),
              snapshot: {
                ...validEntry("e1", null).snapshot,
                origins: [{ range: { from: 0, to: 18 }, rawText: "Original paragraph", kind: "paragraph", before: "\uD83D", after: "" }],
              },
            }],
          },
        }],
      }),
      // Non-normalized path
      v3Root({
        desks: [{
          ...v2Desk("d1", "A"),
          outline: {
            groups: [],
            entries: [{
              ...validEntry("e1", null),
              snapshot: {
                ...validEntry("e1", null).snapshot,
                source: { ...validEntry("e1", null).snapshot.source, path: "../escape.md" },
              },
            }],
          },
        }],
      }),
    ];

    for (const raw of cases) {
      const f = fixture(raw);
      await f.store.load();
      expect(f.store.readOnly).toBe(true);
      expect(f.store.warning).toBe("data.invalidDesks");
      expect(f.save).not.toHaveBeenCalled();
    }
  });
});
