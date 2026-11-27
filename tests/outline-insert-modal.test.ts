// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { installObsidianDom } from "./support/dom";
import { BlockIdService } from "../src/infra/BlockIdService";
import { CitationLinkService } from "../src/infra/CitationLinkService";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { CitationEngine } from "../src/domain/CitationEngine";
import { CitationRecordsService } from "../src/domain/CitationRecords";
import { DeskService } from "../src/domain/DeskService";
import { EvidenceResolver, type EvidenceReaderPort } from "../src/domain/EvidenceResolver";
import { OutlineService } from "../src/domain/OutlineService";
import { CitationError, type TargetTicket } from "../src/domain/citationTypes";
import { sliceContextAfter, sliceContextBefore, type EvidenceSnapshot } from "../src/domain/outlineTypes";
import { setLanguage, t } from "../src/util/i18n";
import { OutlineInsertModal, type OutlineInsertModalOptions, type OutlinePreviewDraft } from "../src/view/OutlineInsertModal";

installObsidianDom();

const openModals: OutlineInsertModal[] = [];
afterEach(() => {
  while (openModals.length) openModals.pop()!.close();
  setLanguage("auto");
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function createModalFixture(initialSources: Record<string, string> = { "Sources/A.md": "First evidence paragraph.\n\nSecond evidence paragraph." }) {
  setLanguage("en");
  const files = new Map<string, TFile>();
  const refs = new Map<string, string>();
  const contents = new Map<string, string>();
  const versions = new Map<string, number>();
  let targetBody = "";
  let targetPath = "Drafts/Target.md";
  let targetFile = new TFile(targetPath);
  files.set(targetPath, targetFile);
  refs.set("target", targetPath);

  let seq = 0;
  for (const [path, text] of Object.entries(initialSources)) {
    const file = new TFile(path);
    files.set(path, file);
    refs.set(`src-${++seq}`, path);
    contents.set(path, text);
    versions.set(path, 1);
  }

  const subListeners = new Set<() => void>();
  const contentListeners = new Set<(fileRef: string, path: string) => void>();
  const refForPath = (path: string): string => {
    for (const [r, p] of refs) if (p === path) return r;
    const ref = `ref-${++seq}`;
    refs.set(ref, path);
    return ref;
  };
  const pathForRef = (ref: string): string => {
    const p = refs.get(ref);
    if (!p || !files.has(p)) throw new CitationError("SOURCE_MISSING");
    return p;
  };

  const save = vi.fn(async () => {});
  const store = new PluginDataStore({ load: async () => null, save, backup: async () => {} });
  store.data.consent.blockIdExplanationAccepted = true;
  await store.acceptBlockIds();

  const desks = new DeskService(store);
  const outline = new OutlineService(desks, store);
  const history = new CitationRecordsService(store);
  const createdDesk = (await desks.create({ name: "Essay", targetPath })).desk!;

  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getMarkdownFiles: () => [...files.values()],
      read: async (f: TFile) => contents.get(f.path) ?? targetBody,
      process: async (f: TFile, fn: (c: string) => string) => {
        const next = fn(contents.get(f.path) ?? "");
        contents.set(f.path, next);
        versions.set(f.path, (versions.get(f.path) ?? 1) + 1);
        return next;
      },
    },
    metadataCache: {
      getFileCache: () => ({}),
      getFirstLinkpathDest: (p: string) => files.get(p) ?? files.get(`${p}.md`) ?? null,
    },
  };

  let ticket: TargetTicket | undefined = { fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 0, to: 0 }, baselineText: "", bindingGeneration: 1 };
  const validate = vi.fn((tk: TargetTicket) => {
    const live = tk.fileRef === "target" ? targetBody : (contents.get(pathForRef(tk.fileRef)) ?? "");
    if (live !== tk.baselineText) throw new CitationError("TARGET_STALE");
  });
  const commit = vi.fn((tk: TargetTicket, citation: string, block = true) => {
    validate(tk);
    const norm = citation.replace(/\r\n/g, "\n");
    const beforeAll = tk.baselineText.slice(0, tk.range.from);
    const afterAll = tk.baselineText.slice(tk.range.to);
    const prefix = block && beforeAll && !beforeAll.endsWith("\n\n") ? (beforeAll.endsWith("\n") ? "\n" : "\n\n") : "";
    const suffix = block && afterAll && !afterAll.startsWith("\n\n") ? (afterAll.startsWith("\n") ? "\n" : "\n\n") : "";
    const text = prefix + norm + suffix;
    const next = beforeAll + text + afterAll;
    if (tk.fileRef === "target") targetBody = next;
    else contents.set(pathForRef(tk.fileRef), next);
    return {
      targetPath: pathForRef(tk.fileRef),
      range: { from: tk.range.from, to: tk.range.from + text.length },
      contentRange: { from: tk.range.from + prefix.length, to: tk.range.from + prefix.length + norm.length },
      text,
      before: tk.baselineText.slice(Math.max(0, tk.range.from - 80), tk.range.from),
      after: tk.baselineText.slice(tk.range.to, tk.range.to + 80),
    };
  });

  const editors = {
    path: pathForRef,
    file: (ref: string) => files.get(pathForRef(ref))!,
    fileRef: (f: TFile) => refForPath(f.path),
    readSource: vi.fn(async (ref: string) => {
      const p = pathForRef(ref);
      return p === targetPath ? targetBody : (contents.get(p) ?? "");
    }),
    writeSource: vi.fn(() => false),
    validate,
    commit,
    copy: vi.fn(async () => {}),
    subscribe: (cb: () => void) => { subListeners.add(cb); return () => subListeners.delete(cb); },
    onContentChanged: (cb: (fileRef: string, path: string) => void) => { contentListeners.add(cb); return () => contentListeners.delete(cb); },
  };

  const sources = new BlockIdService(app as never, editors as never);
  const links = new CitationLinkService(app as never, editors as never);
  const reader: EvidenceReaderPort = {
    resolveRef: (p) => (files.has(p) ? refForPath(p) : undefined),
    read: async (ref, signal) => {
      if (signal?.aborted) throw new CitationError("OPERATION_CANCELLED");
      const p = pathForRef(ref);
      const text = p === targetPath ? targetBody : contents.get(p);
      if (text === undefined) throw new CitationError("SOURCE_READ_FAILED");
      return { fileRef: ref, path: p, text, bodyStart: 0, version: versions.get(p) ?? 1 };
    },
    capture: (ref, text) => sources.capture(files.get(pathForRef(ref))! as never, text),
  };
  const evidence = new EvidenceResolver(reader);
  const cite = new CitationEngine({
    settings: () => store.data.settings,
    consentAccepted: () => store.blockIdConsentAccepted,
    anchorWritesEnabled: () => !store.readOnly,
    sources, editors, links, records: history,
  });

  let templateRevision = 1;
  const plugin = {
    app: app as never,
    settings: store.data.settings,
    store,
    editors,
    desks,
    outline,
    evidence,
    cite,
    history,
    persist: async () => { await store.save(); },
  };

  const collectBlock = async (path: string, spanIndex = 0, note = "", groupId?: string) => {
    const text = path === targetPath ? targetBody : (contents.get(path) ?? "");
    const snap = sources.capture(files.get(path)! as never, text, files.get(path)!.basename);
    const span = snap.spans[spanIndex];
    const snapshot: EvidenceSnapshot = {
      content: sources.content(span),
      mode: "block",
      source: { path, capturedPath: path, title: snap.title ?? "", capturedAt: 100, sourceLength: text.length, identity: "path-reference" },
      origins: [{ range: { ...span.rawRange }, rawText: span.rawText, kind: span.kind, ...(span.existingBlockId ? { blockId: span.existingBlockId } : {}), before: sliceContextBefore(text, span.rawRange.from), after: sliceContextAfter(text, span.rawRange.to) }],
      selectedRanges: [{ ...span.rawRange }],
    };
    const res = await outline.collect({ deskId: createdDesk.id, expectedRevision: outline.outlineRevision(createdDesk.id), entryId: `e-${++seq}`, snapshot, note });
    if (groupId && res.entry) {
      await outline.moveEntry({ deskId: createdDesk.id, expectedRevision: outline.outlineRevision(createdDesk.id), entryId: res.entry.id, targetGroupId: groupId });
    }
    return res.entry!;
  };

  const openModal = (overrides: Partial<OutlineInsertModalOptions> = {}) => {
    const onSuspend = vi.fn();
    const onCancel = vi.fn();
    const onCommitted = vi.fn();
    const modal = new OutlineInsertModal({
      plugin,
      deskId: createdDesk.id,
      scope: { kind: "all" },
      getTicket: () => ticket,
      getTargetPath: () => targetPath,
      getTemplateRevision: () => templateRevision,
      openTarget: vi.fn(),
      onSuspend,
      onCancel,
      onCommitted,
      ...overrides,
    });
    openModals.push(modal);
    modal.open();
    return { modal, onSuspend, onCancel, onCommitted };
  };

  return {
    deskId: createdDesk.id, files, contents, versions, store, desks, outline, history, evidence, cite, editors, sources, plugin, reader, save,
    collectBlock, openModal,
    setSource: (path: string, text: string, notify = false) => {
      if (!files.has(path)) files.set(path, new TFile(path));
      contents.set(path, text);
      versions.set(path, (versions.get(path) ?? 0) + 1);
      if (notify) { const ref = refForPath(path); contentListeners.forEach((cb) => cb(ref, path)); }
    },
    deleteSource: (path: string) => { files.delete(path); contents.delete(path); },
    setTargetBody: (text: string) => { targetBody = text; },
    getTargetBody: () => targetBody,
    setTicket: (next: TargetTicket | undefined, notify = false) => {
      ticket = next;
      if (notify) subListeners.forEach((cb) => cb());
    },
    bumpTemplateRev: () => { templateRevision++; },
    commitSpy: commit,
  };
}

function btnByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
}

function commitBtn(root: HTMLElement): HTMLButtonElement {
  return root.querySelector(".slipstream-outline-modal-actions button.is-active") as HTMLButtonElement;
}

async function waitForReady(modal: OutlineInsertModal, label = "modal") {
  await vi.waitFor(() => {
    expect(modal.draft.state, `${label}: ${modal.contentEl.textContent}`).toBe("preview");
    expect(modal.contentEl.querySelector(".slipstream-outline-markdown") || modal.contentEl.querySelector(".slipstream-outline-rendered") || modal.contentEl.querySelector(".slipstream-outline-issue")).toBeTruthy();
  });
}

describe("OutlineInsertModal", () => {
  it("handles scope selection, Markdown/rendered parity, escaped notes/headings, and empty/skeleton guards (AC-13, AC-14, AC-39)", async () => {
    const f = await createModalFixture();
    // Empty outline blocks commit.
    const empty = f.openModal();
    await waitForReady(empty.modal);
    expect(empty.modal.contentEl.textContent).toContain(t("outline.issueEmptyOutput"));
    expect(btnByText(empty.modal.contentEl, "Insert into")?.disabled).toBe(true);
    empty.modal.close();

    // Group + inbox + empty group.
    const g1 = (await f.outline.createGroup({ deskId: f.deskId, expectedRevision: 0, name: "Claim #1 [A]" })).group!;
    const gEmpty = (await f.outline.createGroup({ deskId: f.deskId, expectedRevision: 1, name: "Empty Group" })).group!;
    await f.collectBlock("Sources/A.md", 0, "> injected note");
    const e2 = await f.collectBlock("Sources/A.md", 1, "Line1\n## Line2", g1.id);

    const { modal, onCommitted } = f.openModal();
    await waitForReady(modal);
    const mdText = modal.contentEl.querySelector(".slipstream-outline-markdown")!.textContent!;
    expect(mdText).toContain("## Claim \\#1 \\[A\\]");
    expect(mdText).toContain("Note: \\> injected note");
    expect(mdText).toContain("Note: Line1\nNote: \\#\\# Line2");
    expect(mdText).toContain(t("outline.emptyGroup"));

    // Switch to Rendered preview tab and verify same content rendered.
    btnByText(modal.contentEl, t("outline.previewRendered"))!.click();
    await vi.waitFor(() => expect(modal.contentEl.querySelector(".slipstream-outline-rendered")?.textContent).toContain("Claim #1 [A]"));

    // Switch scope dropdown to Empty Group -> skeleton confirmation required (AC-39).
    const select = modal.contentEl.querySelector("select") as HTMLSelectElement;
    select.value = `group:${gEmpty.id}`;
    select.dispatchEvent(new Event("change"));
    await waitForReady(modal, "emptyGroup");
    expect(modal.contentEl.textContent).toContain(t("outline.issueSkeletonOnly"));
    expect(commitBtn(modal.contentEl).disabled).toBe(true);
    btnByText(modal.contentEl, t("outline.actionConfirmSkeleton"))!.click();
    await vi.waitFor(() => expect(commitBtn(modal.contentEl).disabled).toBe(false));
    commitBtn(modal.contentEl).click();
    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    expect(f.getTargetBody()).toContain("## Empty Group");
    expect(f.store.data.relations).toHaveLength(0);
    modal.close();

    // Skipping single entry with an issue (changed/duplicate) disables commit cleanly with zero target writes (AC-39).
    f.setSource("Sources/A.md", "First evidence paragraph.\n\nEdited second paragraph.");
    f.setTargetBody("Keep me intact");
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 1, range: { from: 0, to: 4 }, baselineText: "Keep me intact", bindingGeneration: 1 });
    const single = f.openModal({ scope: { kind: "entry", entryId: e2.id } });
    await waitForReady(single.modal, "singleEntry");
    expect(single.modal.contentEl.textContent).toContain("Will replace selection: Keep");
    btnByText(single.modal.contentEl, t("outline.actionSkip"))!.click();
    await vi.waitFor(() => expect(single.modal.contentEl.textContent).toContain(t("outline.issueEmptyOutput")));
    expect(commitBtn(single.modal.contentEl).disabled).toBe(true);
    expect(f.getTargetBody()).toBe("Keep me intact");
    // Also verify leave-to-reselect-source handoff when entry is unlocated (AC-42).
    single.modal.close();
    f.setSource("Sources/A.md", "Completely unrelated content.");
    const reselect = f.openModal({ scope: { kind: "entry", entryId: e2.id } });
    await waitForReady(reselect.modal, "reselectEntry");
    btnByText(reselect.modal.contentEl, t("outline.goReselectSource"))!.click();
    expect(reselect.onSuspend).toHaveBeenCalledWith("source", expect.objectContaining({ state: "suspended-source" }), e2.id);
    expect(reselect.onCancel).not.toHaveBeenCalled();
  });

  it("blocks target-less or invalid targets and handles C template fallback (AC-15, AC-16)", async () => {
    const f = await createModalFixture();
    await f.collectBlock("Sources/A.md", 0);
    f.setTicket(undefined);
    const pending = f.openModal({ getTargetError: () => "TARGET_READONLY" });
    await waitForReady(pending.modal);
    expect(pending.modal.contentEl.textContent).toContain(t("outline.targetPending", { path: "Drafts/Target.md" }));
    expect(pending.modal.contentEl.textContent).toContain(t("error.TARGET_READONLY"));
    expect(commitBtn(pending.modal.contentEl).disabled).toBe(true);
    pending.modal.close();

    // Missing source + template C requires explicit switch to A/B.
    f.store.data.settings.defaultTemplate = "C";
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 0, to: 0 }, baselineText: "", bindingGeneration: 1 });
    f.deleteSource("Sources/A.md");
    const { modal, onCommitted } = f.openModal();
    await waitForReady(modal);
    btnByText(modal.contentEl, t("outline.actionUseSnapshot"))!.click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain(t("error.TEMPLATE_REQUIRES_BLOCK")));
    expect(commitBtn(modal.contentEl).disabled).toBe(true);
    btnByText(modal.contentEl, t("outline.actionUseA"))!.click();
    await vi.waitFor(() => expect(commitBtn(modal.contentEl).disabled).toBe(false));
    commitBtn(modal.contentEl).click();
    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    expect(f.getTargetBody()).toContain("来源已失效，原路径：Sources/A.md");
    expect(f.getTargetBody()).not.toContain("[[Sources/A");
  });

  it("resolves relocated, changed (with refresh comparison), and unavailable sources without mutating sources before commit (AC-17, AC-18, AC-19, AC-22)", async () => {
    const f = await createModalFixture({ "Sources/Reloc.md": "Target block text.", "Sources/Chg.md": "Before.\n\nOld wording.\n\nAfter.", "Sources/Unavail.md": "Locked note." });
    await f.collectBlock("Sources/Reloc.md", 0);
    const eChg = await f.collectBlock("Sources/Chg.md", 1, "Keep my note");
    await f.collectBlock("Sources/Unavail.md", 0);

    f.setSource("Sources/Reloc.md", "New intro paragraph.\n\nTarget block text.");
    f.setSource("Sources/Chg.md", "Before.\n\nUpdated wording.\n\nAfter.");
    const origRead = f.reader.read;
    f.reader.read = async (ref, sig) => {
      if (f.editors.path(ref) === "Sources/Unavail.md") throw new CitationError("SOURCE_AMBIGUOUS");
      return origRead(ref, sig);
    };

    const { modal } = f.openModal();
    await waitForReady(modal);
    expect(modal.contentEl.textContent).toContain(t("outline.issueRelocated"));
    expect(modal.contentEl.textContent).toContain(t("outline.issueChanged"));
    expect(modal.contentEl.textContent).toContain("Old wording.");
    expect(modal.contentEl.textContent).toContain("Updated wording.");
    expect(modal.contentEl.textContent).toContain(t("outline.issueUnavailable"));
    expect(commitBtn(modal.contentEl).disabled).toBe(true);

    // Confirm refresh on changed block preserves note and updates snapshot.
    btnByText(modal.contentEl, t("outline.refreshConfirm"))!.click();
    await waitForReady(modal);
    expect(f.outline.getEntry(f.deskId, eChg.id)!.snapshot.content).toBe("Updated wording.");
    expect(f.outline.getEntry(f.deskId, eChg.id)!.note).toBe("Keep my note");

    // Confirm relocated and use saved snapshot on unavailable -> enables commit; sources untouched until commit.
    btnByText(modal.contentEl, t("outline.actionConfirmRelocated"))!.click();
    await vi.waitFor(() => expect(modal.contentEl.querySelectorAll(".is-blocking")).toHaveLength(1));
    btnByText(modal.contentEl, t("outline.actionUseSnapshot"))!.click();
    await vi.waitFor(() => expect(commitBtn(modal.contentEl).disabled).toBe(false));
    expect(f.contents.get("Sources/Reloc.md")).toBe("New intro paragraph.\n\nTarget block text.");
    expect(f.contents.get("Sources/Chg.md")).toBe("Before.\n\nUpdated wording.\n\nAfter.");
  });

  it("handles preflight cancel (<=100ms), consent gate, duplicates, partial source failure, uncertain commit, record retry, and disabled history (AC-20..25, AC-27, AC-28, AC-31)", async () => {
    const f = await createModalFixture({ "Sources/One.md": "Block one", "Sources/Two.md": "Block two" });
    await f.collectBlock("Sources/One.md", 0);
    await f.collectBlock("Sources/Two.md", 0);
    // Test synchronous cancel on slow read.
    let resolveSlow!: () => void;
    const origRead = f.reader.read;
    f.reader.read = async (ref, sig) => {
      if (f.editors.path(ref) === "Sources/One.md") await new Promise<void>((r) => { resolveSlow = r; });
      return origRead(ref, sig);
    };
    const cancelFlow = f.openModal();
    await vi.waitFor(() => expect(cancelFlow.modal.draft.state).toBe("checking"));
    const t0 = performance.now();
    btnByText(cancelFlow.modal.contentEl, t("outline.checkingCancel"))!.click();
    expect(performance.now() - t0).toBeLessThan(100);
    expect(cancelFlow.modal.contentEl.textContent).toContain(t("outline.checkingCancelled"));
    resolveSlow();
    cancelFlow.modal.close();
    f.reader.read = origRead;

    // Require consent first.
    f.store.data.consent.blockIdExplanationAccepted = false;
    await f.store.load(); // reset internal consentSaved flag? No, let's test consent via fresh store or explicit mock:
    f.reader.read = origRead;
    const origConsent = f.store.blockIdConsentAccepted;
    Object.defineProperty(f.store, "blockIdConsentAccepted", { configurable: true, get: () => false });
    const consentFlow = f.openModal();
    await waitForReady(consentFlow.modal);
    expect(consentFlow.modal.contentEl.textContent).toContain(t("outline.issueConsent"));
    expect(commitBtn(consentFlow.modal.contentEl).disabled).toBe(true);
    Object.defineProperty(f.store, "blockIdConsentAccepted", { configurable: true, get: () => true });
    btnByText(consentFlow.modal.contentEl, t("outline.actionAcceptConsent"))!.click();
    await vi.waitFor(() => expect(commitBtn(consentFlow.modal.contentEl).disabled).toBe(false));
    expect(origConsent).toBe(true);

    // Live target change invalidates confirmation (AC-25).
    const prepSpy = vi.spyOn(f.cite, "prepareBatch");
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 0, to: 0 }, baselineText: "", bindingGeneration: 2 }, true);
    await vi.waitFor(() => expect(prepSpy).toHaveBeenCalled());
    const invalidatedPlan = await prepSpy.mock.results.at(-1)!.value;
    expect(invalidatedPlan.planId).toBeTruthy();
    prepSpy.mockRestore();
    await Promise.resolve();
    await vi.waitFor(() => expect(commitBtn(consentFlow.modal.contentEl).disabled).toBe(false));

    // Fail second source during commit -> reports source 1 created, target untouched (AC-24).
    const origTwo = f.contents.get("Sources/Two.md")!;
    f.setSource("Sources/Two.md", "Changed before commit");
    commitBtn(consentFlow.modal.contentEl).click();
    await vi.waitFor(() => expect(consentFlow.modal.contentEl.textContent).toContain(t("outline.commitPartialSources")));
    expect(consentFlow.modal.contentEl.textContent).toContain("Sources/One.md");
    expect(f.getTargetBody()).toBe("");
    consentFlow.modal.close();

    // Restore source 2, commit with save failure -> record retry only, no second commit (AC-28).
    f.setSource("Sources/Two.md", origTwo);
    f.save.mockRejectedValueOnce(new Error("disk"));
    const retryFlow = f.openModal();
    await waitForReady(retryFlow.modal);
    commitBtn(retryFlow.modal.contentEl).click();
    await vi.waitFor(() => expect(retryFlow.modal.contentEl.textContent).toContain(t("outline.retryRecordOnly")));
    const commitsBefore = f.commitSpy.mock.calls.length;
    btnByText(retryFlow.modal.contentEl, t("outline.retryRecordOnly"))!.click();
    await vi.waitFor(() => expect(retryFlow.modal.contentEl.textContent).toContain(t("citation.recordSaved")));
    expect(f.commitSpy).toHaveBeenCalledTimes(commitsBefore);
    retryFlow.modal.close();

    // Duplicate reminder on second insert + uncertain commit has no auto-retry (AC-20, AC-27).
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 1, range: { from: f.getTargetBody().length, to: f.getTargetBody().length }, baselineText: f.getTargetBody(), bindingGeneration: 3 });
    const dupFlow = f.openModal();
    await waitForReady(dupFlow.modal);
    expect(dupFlow.modal.contentEl.textContent).toContain(t("outline.issueDuplicate"));
    expect(commitBtn(dupFlow.modal.contentEl).disabled).toBe(true);
    for (const btn of dupFlow.modal.contentEl.querySelectorAll("button")) {
      if (btn.textContent === t("outline.actionInsertAgain")) btn.click();
    }
    await vi.waitFor(() => expect(commitBtn(dupFlow.modal.contentEl).disabled).toBe(false));
    f.commitSpy.mockImplementationOnce(() => { throw new CitationError("COMMIT_STATE_UNCERTAIN"); });
    commitBtn(dupFlow.modal.contentEl).click();
    await vi.waitFor(() => expect(dupFlow.modal.contentEl.textContent).toContain("uncertain"));
    expect(dupFlow.onCommitted).not.toHaveBeenCalled();
    expect(btnByText(dupFlow.modal.contentEl, t("outline.retryPreflight"))).toBeUndefined();
    expect(btnByText(dupFlow.modal.contentEl, t("outline.openTarget"))).toBeTruthy();
    dupFlow.modal.close();
    expect(dupFlow.onCancel).toHaveBeenCalledWith(dupFlow.modal.draft.draftId);

    // historyEnabled=false inserts without recording (AC-31).
    f.store.data.settings.historyEnabled = false;
    f.store.data.settings.dedupe = false;
    const noHist = f.openModal();
    await waitForReady(noHist.modal);
    expect(noHist.modal.contentEl.textContent).toContain(t("outline.recordingDisabledNotice"));
    commitBtn(noHist.modal.contentEl).click();
    await vi.waitFor(() => expect(noHist.onCommitted).toHaveBeenCalledOnce());
    expect(noHist.onCommitted.mock.calls[0][0].recording).toBe("disabled");
  });

  it("blocks self-target conflict, unsafe Markdown boundaries, and supports suspend/resume draft lifecycle (AC-40, AC-41, AC-42)", async () => {
    const f = await createModalFixture({ "Sources/Fence.md": "```ts\nconst x = 1;" });
    f.setTargetBody("Intro\n\nCited block ^c1\n\nTail");
    await f.collectBlock("Drafts/Target.md", 1); // Cited block ^c1
    const fenceEntry = await f.collectBlock("Sources/Fence.md", 0, "Note after fence");
    f.store.data.settings.defaultTemplate = "B";
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 7, to: 18 }, baselineText: f.getTargetBody(), bindingGeneration: 1 });

    const first = f.openModal();
    expect(first.modal.shouldRestoreSelection).toBe(false);
    await waitForReady(first.modal);
    expect(first.modal.contentEl.textContent).toContain(t("outline.issueSelfTarget"));
    expect(first.modal.contentEl.textContent).toContain(t("outline.issueMarkdownBoundary"));

    // Resolve Markdown boundary by switching fenceEntry to A, then suspend to relocate target.
    btnByText(first.modal.contentEl, t("outline.actionUseA"))!.click();
    await vi.waitFor(() => expect(first.modal.contentEl.textContent).not.toContain(t("outline.issueMarkdownBoundary")));
    btnByText(first.modal.contentEl, t("outline.goLocateTarget"))!.click();
    expect(first.onSuspend).toHaveBeenCalledWith("target", expect.objectContaining({ state: "suspended-target" }), undefined);
    expect(first.onCancel).not.toHaveBeenCalled();

    // Resume with preserved draft and safe offset 0 -> self-target conflict clears cleanly!
    const draft: OutlinePreviewDraft = first.onSuspend.mock.calls[0][1];
    draft.skeletonConfirmed = true; // Must be cleared on resume.
    expect(draft.decisions.get(fenceEntry.id)?.templateOverride).toBe("A");
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 0, to: 0 }, baselineText: f.getTargetBody(), bindingGeneration: 2 });
    const resumed = f.openModal({ draft });
    await waitForReady(resumed.modal);
    expect(resumed.modal.draft.skeletonConfirmed).toBe(false);
    expect(resumed.modal.draft.decisions.get(fenceEntry.id)?.templateOverride).toBe("A");
    expect(commitBtn(resumed.modal.contentEl).disabled).toBe(false);

    // Changing templateRevision invalidates stale decisions on next resume (AC-42).
    resumed.modal.close();
    f.bumpTemplateRev();
    const staleResume = f.openModal({ draft });
    await waitForReady(staleResume.modal);
    expect(staleResume.modal.contentEl.textContent).toContain(t("outline.decisionsResetNotice"));
    expect(staleResume.modal.draft.decisions.size).toBe(0);
    staleResume.modal.close();

    // Deleted desk expires suspended draft cleanly (AC-42).
    await f.desks.delete(f.deskId);
    const expired = f.openModal({ draft });
    await vi.waitFor(() => expect(expired.modal.contentEl.textContent).toContain(t("outline.draftExpired")));
    expired.modal.close();
    expect(expired.onCancel).toHaveBeenCalledWith(draft.draftId);
  });

  it("handles relation capacity choice, self-target snapshot degradation, live source invalidation, and custom renderMarkdown fallback (AC-25, AC-29, AC-40)", async () => {
    const f = await createModalFixture({ "Sources/Cap.md": "Cap paragraph" });
    f.setTargetBody("Intro\n\nCited ^c1\n\nEnd");
    await f.collectBlock("Drafts/Target.md", 1);
    await f.collectBlock("Sources/Cap.md", 0);

    // Capacity exceeded + self-target conflict -> degrade self-target and skip relations for this batch.
    vi.spyOn(f.history, "canFitRelations").mockReturnValue(false);
    f.setTicket({ fileRef: "target", editorId: "ed-1", revision: 0, range: { from: 7, to: 16 }, baselineText: f.getTargetBody(), bindingGeneration: 1 });
    const renderMarkdown = vi.fn(async (_md: string, el: HTMLElement) => {
      el.createSpan({ text: "custom-rendered" });
    });
    const flow = f.openModal({ renderMarkdown });
    await waitForReady(flow.modal, "capSelf");
    expect(flow.modal.contentEl.textContent).toContain(t("outline.issueCapacity"));
    expect(flow.modal.contentEl.textContent).toContain(t("outline.issueSelfTarget"));

    btnByText(flow.modal.contentEl, t("outline.actionUseSnapshot"))!.click();
    await vi.waitFor(() => expect(flow.modal.contentEl.textContent).toContain(t("outline.sourceSelfTargetDegraded")));
    btnByText(flow.modal.contentEl, t("outline.actionSkipRelations"))!.click();
    await vi.waitFor(() => expect(commitBtn(flow.modal.contentEl).disabled).toBe(false));

    // Switch to rendered tab -> custom renderMarkdown invoked; live source change triggers re-check.
    btnByText(flow.modal.contentEl, t("outline.previewRendered"))!.click();
    await vi.waitFor(() => expect(flow.modal.contentEl.textContent).toContain("custom-rendered"));
    f.setSource("Sources/Cap.md", "Cap paragraph edited", true);
    await vi.waitFor(() => expect(flow.modal.contentEl.textContent).toContain(t("outline.issueUnlocated")));
    btnByText(flow.modal.contentEl, t("outline.actionSkip"))!.click();
    await vi.waitFor(() => expect(commitBtn(flow.modal.contentEl).disabled).toBe(false));
    commitBtn(flow.modal.contentEl).click();
    await vi.waitFor(() => expect(flow.onCommitted).toHaveBeenCalledOnce());
    expect(f.store.data.relations).toHaveLength(0);
    expect(f.getTargetBody()).toContain("保存时摘录，非当前原文");
  });

  it("synchronously disables commit and releases stale plans on rebuildPlan, cancel, suspend, and close (Bugs 2 & 5)", async () => {
    const f = await createModalFixture({ "Sources/A.md": "Block one\n\nBlock two" });
    const e1 = await f.collectBlock("Sources/A.md", 0);
    await f.collectBlock("Sources/A.md", 1);
    const releaseSpy = vi.spyOn(f.cite, "releaseBatchPlan");
    const { modal } = f.openModal();
    await waitForReady(modal);

    // Hold two overlapping rebuildPlan calls; commit must disable immediately and stale plan must be released.
    let resolveFirst!: (p: Awaited<ReturnType<typeof f.cite.prepareBatch>>) => void;
    let resolveSecond!: (p: Awaited<ReturnType<typeof f.cite.prepareBatch>>) => void;
    const origPrepare = f.cite.prepareBatch.bind(f.cite);
    const prepSpy = vi.spyOn(f.cite, "prepareBatch")
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    // Trigger 1st decision rebuild -> synchronously releases initial plan and disables commit.
    void modal.rebuildPlan();
    expect(commitBtn(modal.contentEl).disabled).toBe(true);
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    // Trigger 2nd decision rebuild before 1st resolves -> resolve 1st stale plan -> must be released and commit stays disabled.
    void modal.rebuildPlan();
    await vi.waitFor(() => expect(prepSpy).toHaveBeenCalledTimes(2));
    const stalePlan = await origPrepare({
      batchId: "b-stale-check", deskId: f.deskId, items: [], layout: [], signal: new AbortController().signal,
    });
    const prevReleases = releaseSpy.mock.calls.length;
    resolveFirst(stalePlan);
    await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledWith(stalePlan.planId));
    expect(commitBtn(modal.contentEl).disabled).toBe(true);
    expect(releaseSpy.mock.calls.length).toBeGreaterThan(prevReleases);

    // Resolve 2nd active plan -> rebuild finishes, then close releases currentPlan.
    resolveSecond(await origPrepare({
      batchId: "b-active", deskId: f.deskId, items: [], layout: [], signal: new AbortController().signal,
    }));
    await vi.waitFor(() => expect(prepSpy).toHaveBeenCalledTimes(2));
    prepSpy.mockRestore();
    void e1;
    await modal.rebuildPlan();
    const releasesBeforeClose = releaseSpy.mock.calls.length;
    modal.close();
    expect(releaseSpy.mock.calls.length).toBe(releasesBeforeClose + 1);
  });

  it("fires onCommitted and onUncertain even if modal closes while commitBatch is in flight (Bug 3)", async () => {
    const f = await createModalFixture({ "Sources/A.md": "Block one" });
    await f.collectBlock("Sources/A.md", 0);

    let resolveInserted!: (v: Awaited<ReturnType<typeof f.cite.commitBatch>>) => void;
    const commitMock = vi.spyOn(f.cite, "commitBatch").mockImplementationOnce(
      () => new Promise((r) => { resolveInserted = r; }),
    );
    const m1 = f.openModal();
    await waitForReady(m1.modal);
    commitBtn(m1.modal.contentEl).click();
    await vi.waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    m1.modal.close();
    resolveInserted({
      batchId: "b1", planId: "p1", status: "partial", effect: "inserted", recording: "pending",
      targetPath: "Drafts/Target.md", includedItemCount: 1, hasSkeleton: false, sourceResults: [], items: [],
    });
    await vi.waitFor(() => expect(m1.onCommitted).toHaveBeenCalledOnce());
    expect(m1.modal.draft.state).toBe("closed");

    let resolveUncertain!: (v: Awaited<ReturnType<typeof f.cite.commitBatch>>) => void;
    commitMock.mockImplementationOnce(() => new Promise((r) => { resolveUncertain = r; }));
    const onUncertain = vi.fn();
    const m2 = f.openModal({ onUncertain });
    await waitForReady(m2.modal);
    commitBtn(m2.modal.contentEl).click();
    await vi.waitFor(() => expect(commitMock).toHaveBeenCalledTimes(2));
    m2.modal.close();
    resolveUncertain({
      batchId: "b2", planId: "p2", status: "uncertain", effect: "unknown", recording: "not-attempted",
      code: "COMMIT_STATE_UNCERTAIN", targetPath: "Drafts/Target.md", includedItemCount: 1, hasSkeleton: false, sourceResults: [], items: [],
    });
    await vi.waitFor(() => expect(onUncertain).toHaveBeenCalledOnce());
    expect(m2.onCommitted).not.toHaveBeenCalled();

    // Partial source anchor writes with effect: "none" must still report via onPartialSources after modal close (Bug 3).
    let resolvePartial!: (v: Awaited<ReturnType<typeof f.cite.commitBatch>>) => void;
    commitMock.mockImplementationOnce(() => new Promise((r) => { resolvePartial = r; }));
    const onPartialSources = vi.fn();
    const m3 = f.openModal({ onPartialSources });
    await waitForReady(m3.modal);
    commitBtn(m3.modal.contentEl).click();
    await vi.waitFor(() => expect(commitMock).toHaveBeenCalledTimes(3));
    m3.modal.close();
    resolvePartial({
      batchId: "b3", planId: "p3", status: "partial", effect: "none", recording: "not-attempted",
      code: "OPERATION_CANCELLED", includedItemCount: 1, hasSkeleton: false,
      sourceResults: [{ sourceRef: "src-a", sourcePath: "Sources/A.md", kind: "created", createdIds: ["^a1"], reusedIds: [] }],
      items: [],
    });
    await vi.waitFor(() => expect(onPartialSources).toHaveBeenCalledOnce());
    expect(m3.onCommitted).not.toHaveBeenCalled();
  });

  it("renders full markdown context once so reference definitions resolve across >20 blocks before batched DOM mounting (Bug 4/6)", async () => {
    const sources: Record<string, string> = {};
    for (let i = 1; i <= 21; i++) {
      sources[`Sources/B${i}.md`] = i === 20
        ? "```ts\nconst first = 1;\n\nconst second = 2;\n```"
        : `Paragraph number ${i}.`;
    }
    const f = await createModalFixture(sources);
    f.store.data.settings.defaultTemplate = "B";
    for (let i = 1; i <= 21; i++) await f.collectBlock(`Sources/B${i}.md`, 0);

    const renderedInputs: string[] = [];
    const custom = f.openModal({
      renderMarkdown: async (md, el) => {
        renderedInputs.push(md);
        for (const block of md.split(/\n\n+/)) el.createDiv({ text: block });
      },
    });
    await waitForReady(custom.modal);
    btnByText(custom.modal.contentEl, t("outline.previewRendered"))!.click();
    await vi.waitFor(() => expect(renderedInputs).toHaveLength(1));
    expect(renderedInputs[0]).toContain("```ts\nconst first = 1;\n\nconst second = 2;\n```");
    custom.modal.close();

    // Reference-style link defined after >20 blocks resolves when rendered as a single full document before batched DOM mounting.
    const { renderPreviewBatched } = await import("../src/view/OutlinePreviewRenderer");
    const { Component } = await import("./support/obsidian");
    const longDoc = [
      "See [evidence][paper].",
      ...Array.from({ length: 20 }, (_, i) => `Filler paragraph ${i + 1}.`),
      "[paper]: https://example.com/paper",
    ].join("\n\n");
    const targetEl = document.createElement("div");
    const docInputs: string[] = [];
    await renderPreviewBatched({
      container: targetEl,
      markdown: longDoc,
      targetPath: "Drafts/Target.md",
      component: new Component() as never,
      isStale: () => false,
      renderer: async (md, el) => {
        docInputs.push(md);
        const def = md.match(/\[paper\]:\s*(https:\/\/\S+)/);
        for (const block of md.split("\n\n")) {
          if (block.includes("[evidence][paper]") && def) {
            const p = el.createEl("p");
            p.createEl("a", { text: "evidence", attr: { href: def[1] } });
          } else {
            el.createEl("p", { text: block });
          }
        }
      },
    });
    expect(docInputs).toHaveLength(1);
    expect(targetEl.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("https://example.com/paper");
    expect(targetEl.children.length).toBeGreaterThan(20);

    // Fallback DOM renderer also keeps the fenced block intact inside a single <pre>.
    const fallback = f.openModal();
    await waitForReady(fallback.modal);
    btnByText(fallback.modal.contentEl, t("outline.previewRendered"))!.click();
    await vi.waitFor(() => {
      const pres = [...fallback.modal.contentEl.querySelectorAll(".slipstream-outline-rendered pre")];
      expect(pres.some((pre) => pre.textContent?.includes("const first = 1;") && pre.textContent?.includes("const second = 2;"))).toBe(true);
    });
  });
});
