// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTLINE_WINDOW_SIZE, OutlinePanel } from "../src/view/OutlinePanel";
import type { OutlinePanelHost } from "../src/view/OutlinePanel";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DeskService } from "../src/domain/DeskService";
import { OutlineService } from "../src/domain/OutlineService";
import type { EvidenceSnapshot } from "../src/domain/outlineTypes";
import { setLanguage, t } from "../src/util/i18n";
import { installObsidianDom } from "./support/dom";

installObsidianDom();

function makeSnapshot(content: string, path = "Sources/A.md", idx = 0): EvidenceSnapshot {
  return {
    content,
    mode: "block",
    source: {
      path,
      capturedPath: path,
      title: path.split("/").pop()!.replace(/\.md$/, ""),
      capturedAt: 1000 + idx,
      sourceLength: Math.max(content.length + 10, 50),
      identity: "path-reference",
    },
    origins: [{
      range: { from: 0, to: content.length },
      rawText: content,
      kind: "paragraph",
      before: "",
      after: "",
    }],
    selectedRanges: [{ from: 0, to: content.length }],
  };
}

function fixture(options: { readOnly?: boolean; saveFail?: boolean; recording?: boolean; missingPaths?: Set<string> } = {}) {
  let shouldFail = !!options.saveFail;
  const save = vi.fn(async () => {
    if (shouldFail) throw new Error("DISK_FAIL");
  });
  const store = new PluginDataStore({ load: async () => null, save, backup: async () => {} });
  if (options.readOnly) store.readOnly = true;
  if (options.recording === false) store.data.settings.historyEnabled = false;
  const desks = new DeskService(store);
  const outline = new OutlineService(desks, store);
  let currentDeskId: string | undefined;
  const openSource = vi.fn();
  const openPreview = vi.fn();
  const switchToMaterials = vi.fn();
  const openCreateDesk = vi.fn();
  const missing = options.missingPaths ?? new Set<string>();

  const host: OutlinePanelHost = {
    app: {} as never,
    currentDeskId: () => currentDeskId,
    getOutline: () => currentDeskId ? outline.getOutline(currentDeskId) : undefined,
    isDirty: () => currentDeskId ? outline.isDirty(currentDeskId) : false,
    isReadOnly: () => store.readOnly,
    recordingEnabled: () => store.data.settings.historyEnabled && !store.readOnly,
    isSourceMissing: (path) => missing.has(path),
    switchToMaterials,
    openCreateDesk,
    openSource,
    openPreview,
    retrySave: async () => { if (currentDeskId) await outline.save(currentDeskId); },
    setNote: (entryId, rev, note, persist) => outline.setNote({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      entryId,
      expectedContentRevision: rev,
      note,
      persist,
    }),
    createGroup: (name, groupId) => outline.createGroup({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      name,
      groupId,
    }),
    renameGroup: (groupId, name) => outline.renameGroup({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      groupId,
      name,
    }),
    moveGroup: (groupId, direction) => outline.moveGroup({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      groupId,
      direction,
    }),
    removeGroup: (groupId) => outline.removeGroup({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      groupId,
    }),
    moveEntry: (entryId, targetGroupId, direction) => outline.moveEntry({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      entryId,
      targetGroupId,
      direction,
    }),
    removeEntry: (entryId) => outline.removeEntry({
      deskId: currentDeskId!,
      expectedRevision: outline.outlineRevision(currentDeskId!),
      entryId,
    }),
  };

  const panel = new OutlinePanel(host);
  panel.el.classList.remove("is-hidden");
  document.body.appendChild(panel.el);

  return {
    store,
    desks,
    outline,
    panel,
    openSource,
    openPreview,
    switchToMaterials,
    openCreateDesk,
    setDesk: (id: string | undefined) => { currentDeskId = id; },
    setSaveFail: (fail: boolean) => { shouldFail = fail; },
  };
}

beforeEach(() => {
  setLanguage("en");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setLanguage("auto");
  document.body.replaceChildren();
});

describe("OutlinePanel", () => {
  it("guides temporary browse to save desk or return to materials, and renders empty outline guide", async () => {
    const f = fixture();
    f.panel.render();
    expect(f.panel.el.textContent).toContain(t("outline.saveDeskFirst"));

    const created = await f.desks.create({ name: "Desk 1", targetPath: "Drafts/Out.md" });
    f.setDesk(created.desk!.id);
    f.panel.render();
    expect(f.panel.el.textContent).toContain(t("outline.emptyTitle"));
    const previewAll = [...f.panel.el.querySelectorAll("button")].find((b) => b.textContent === t("outline.previewAll"))!;
    expect(previewAll.disabled).toBe(true);
    const backBtn = [...f.panel.el.querySelectorAll("button")].find((b) => b.textContent === t("outline.backToMaterials"))!;
    backBtn.click();
    expect(f.switchToMaterials).toHaveBeenCalledOnce();
  });

  it("validates group creation, handles empty/pending-source groups, and moves entries back to inbox on non-empty group delete", async () => {
    const f = fixture({ missingPaths: new Set(["Sources/Missing.md"]) });
    const created = await f.desks.create({ name: "Desk", targetPath: "Drafts/Out.md" });
    const deskId = created.desk!.id;
    f.setDesk(deskId);

    await f.outline.createGroup({ deskId, expectedRevision: 0, name: "Group A", groupId: "g1" });
    await f.outline.createGroup({ deskId, expectedRevision: 1, name: "Group B", groupId: "g2" });
    await f.outline.collect({ deskId, expectedRevision: 2, entryId: "e1", snapshot: makeSnapshot("Alpha text", "Sources/Missing.md") });
    await f.outline.moveEntry({ deskId, expectedRevision: 3, entryId: "e1", targetGroupId: "g1" });
    f.panel.render();

    const g1El = f.panel.el.querySelector('[data-group-id="g1"]')!;
    const g2El = f.panel.el.querySelector('[data-group-id="g2"]')!;
    expect(g1El.textContent).toContain(t("outline.pendingSources", { n: 1 }));
    expect(g2El.textContent).toContain(t("outline.emptyGroup"));

    // Open Group A menu, verify Move up disabled on first group, Move down enabled
    g1El.querySelector<HTMLButtonElement>(`[aria-label="${t("outline.groupActions")}"]`)!.click();
    const menuBtns = [...f.panel.el.querySelectorAll<HTMLButtonElement>('[data-group-id="g1"] [role="menu"] button')];
    expect(menuBtns.find((b) => b.textContent === t("outline.moveUp"))!.disabled).toBe(true);
    expect(menuBtns.find((b) => b.textContent === t("outline.moveDown"))!.disabled).toBe(false);

    // Delete non-empty Group A -> confirms and moves e1 back to Inbox
    menuBtns.find((b) => b.textContent === t("outline.deleteGroup"))!.click();
    const modalDelete = [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-citation-prompt button")].find((b) => b.textContent === t("outline.deleteGroup"))!;
    modalDelete.click();
    await vi.waitFor(() => expect(f.outline.getOutline(deskId)!.outline.groups.map((g) => g.id)).toEqual(["g2"]));
    expect(f.outline.getOutline(deskId)!.outline.entries[0].groupId).toBeNull();
  });

  it("supports keyboard group/entry menu Esc close, moving entries, and focus retention", async () => {
    const f = fixture();
    const created = await f.desks.create({ name: "Desk", targetPath: "Drafts/Out.md" });
    const deskId = created.desk!.id;
    f.setDesk(deskId);
    await f.outline.createGroup({ deskId, expectedRevision: 0, name: "G1", groupId: "g1" });
    await f.outline.collect({ deskId, expectedRevision: 1, entryId: "e1", snapshot: makeSnapshot("One", "Sources/One.md") });
    await f.outline.collect({ deskId, expectedRevision: 2, entryId: "e2", snapshot: makeSnapshot("Two", "Sources/Two.md") });
    f.panel.render();

    const menuBtn = f.panel.el.querySelector<HTMLButtonElement>('[data-focus-target="entry-menu:e2"]')!;
    menuBtn.click();
    expect(f.panel.el.querySelector('[data-entry-id="e2"] [role="menu"]')).toBeTruthy();

    // Esc closes menu and returns focus to menu button
    f.panel.el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(f.panel.el.querySelector('[data-entry-id="e2"] [role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(f.panel.el.querySelector('[data-focus-target="entry-menu:e2"]'));

    // Reopen and move e2 up -> focus follows e2
    f.panel.el.querySelector<HTMLButtonElement>('[data-focus-target="entry-menu:e2"]')!.click();
    const moveUp = [...f.panel.el.querySelectorAll<HTMLButtonElement>('[data-entry-id="e2"] [role="menu"] button')].find((b) => b.textContent === t("outline.moveUp"))!;
    moveUp.click();
    await vi.waitFor(() => expect(f.outline.getOutline(deskId)!.outline.entries.map((e) => e.id)).toEqual(["e2", "e1"]));
    expect(document.activeElement).toBe(f.panel.el.querySelector('[data-focus-target="entry-menu:e2"]'));
  });

  it("debounces notes, ignores intermediate IME composition, and flushes on blur", async () => {
    const f = fixture();
    const created = await f.desks.create({ name: "Desk", targetPath: "Drafts/Out.md" });
    const deskId = created.desk!.id;
    f.setDesk(deskId);
    await f.outline.collect({ deskId, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot("Excerpt body") });
    f.panel.render();

    const noteEl = f.panel.el.querySelector<HTMLTextAreaElement>('[data-focus-target="entry-note:e1"]')!;
    noteEl.dispatchEvent(new Event("compositionstart"));
    noteEl.value = "zhongw";
    noteEl.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(500);
    expect(f.outline.getEntry(deskId, "e1")?.note).toBe("");

    noteEl.value = "中文备注";
    noteEl.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(350);
    await vi.waitFor(() => expect(f.outline.getEntry(deskId, "e1")?.note).toBe("中文备注"));

    noteEl.value = "Blur flush";
    noteEl.dispatchEvent(new Event("input"));
    noteEl.dispatchEvent(new Event("blur"));
    await vi.waitFor(() => expect(f.outline.getEntry(deskId, "e1")?.note).toBe("Blur flush"));
  });

  it("shows save failure retry, stale vs current lastInsertion badges, and recording disabled notice", async () => {
    const f = fixture({ recording: false });
    const created = await f.desks.create({ name: "Desk", targetPath: "Drafts/Out.md" });
    const deskId = created.desk!.id;
    f.setDesk(deskId);
    await f.outline.collect({ deskId, expectedRevision: 0, entryId: "e1", snapshot: makeSnapshot("A".repeat(300)) });

    // Simulate an existing lastInsertion from an earlier contentRevision
    const desk = f.desks.get(deskId)!;
    desk.outline.entries[0].contentRevision = 2;
    desk.outline.entries[0].lastInsertion = {
      batchId: "b1",
      operationId: "b1:e1",
      targetPath: "Drafts/Out.md",
      at: new Date(2026, 10, 14, 12, 0).valueOf(),
      contentRevision: 1,
      commitSequence: 1,
    };

    f.setSaveFail(true);
    await f.outline.createGroup({ deskId, expectedRevision: 1, name: "Dirty Group" });
    f.panel.render();

    expect(f.panel.el.textContent).toContain(t("outline.recordingDisabledNotice"));
    expect(f.panel.el.textContent).toContain(t("outline.statusUnsaved"));
    expect(f.panel.el.textContent).toContain("Current version not inserted");
    expect(f.panel.el.querySelector(".slipstream-outline-entry-content")?.textContent?.length).toBe(240);

    // Retry save succeeds
    f.setSaveFail(false);
    const retryBtn = [...f.panel.el.querySelectorAll("button")].find((b) => b.textContent === t("outline.retrySave"))!;
    retryBtn.click();
    await vi.waitFor(() => expect(f.panel.el.textContent).toContain(t("outline.statusSaved")));
  });

  it("windows 200 entries to 30 DOM cards while preserving full-outline preview and moving the 200th entry (AC-35)", async () => {
    const f = fixture();
    const created = await f.desks.create({ name: "Large Desk", targetPath: "Drafts/Out.md" });
    const deskId = created.desk!.id;
    f.setDesk(deskId);
    let rev = 0;
    await f.outline.createGroup({ deskId, expectedRevision: rev++, name: "G1", groupId: "g1" });
    for (let i = 0; i < 200; i++) {
      await f.outline.collect({
        deskId,
        expectedRevision: rev++,
        entryId: `e-${i}`,
        snapshot: makeSnapshot(`Paragraph ${i} ${"x".repeat(40)}`, `Sources/N${i % 10}.md`, i),
      });
      await f.outline.moveEntry({ deskId, expectedRevision: rev++, entryId: `e-${i}`, targetGroupId: "g1" });
    }
    f.panel.render();

    expect(f.panel.el.querySelectorAll(".slipstream-outline-entry")).toHaveLength(OUTLINE_WINDOW_SIZE);
    expect(f.panel.el.textContent).toContain("G1 (200)");

    // Select & move the 200th entry (e-199) -> materializes its window and moves it in full outline
    f.panel.selectEntry("e-199", "menu");
    expect(f.panel.el.querySelector('[data-entry-id="e-199"]')).toBeTruthy();
    f.panel.el.querySelector<HTMLButtonElement>('[data-focus-target="entry-menu:e-199"]')!.click();
    const moveUp = [...f.panel.el.querySelectorAll<HTMLButtonElement>('[data-entry-id="e-199"] [role="menu"] button')].find((b) => b.textContent === t("outline.moveUp"))!;
    moveUp.click();
    await vi.waitFor(() => {
      const entries = f.outline.getOutline(deskId)!.outline.entries;
      expect(entries[198].id).toBe("e-199");
      expect(entries[199].id).toBe("e-198");
    });

    const previewAll = [...f.panel.el.querySelectorAll("button")].find((b) => b.textContent === t("outline.previewAll"))!;
    previewAll.click();
    await vi.waitFor(() => expect(f.openPreview).toHaveBeenCalledWith({ kind: "all" }));
  });
});
