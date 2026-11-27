// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFolder, TFile, Notice, MarkdownView, MarkdownRenderer, Component } from "./support/obsidian";
import MarkdownIt from "markdown-it";
import { CardStreamController } from "../src/domain/CardStreamController";
import { DeskService } from "../src/domain/DeskService";
import { OutlineService } from "../src/domain/OutlineService";
import { EvidenceResolver } from "../src/domain/EvidenceResolver";
import { CitationRecordsService } from "../src/domain/CitationRecords";
import { CitationEngine } from "../src/domain/CitationEngine";
import { CitationLinkService } from "../src/infra/CitationLinkService";
import { CollectionService } from "../src/domain/CollectionService";
import { SearchDocumentReader } from "../src/infra/SearchDocumentReader";
import { FocusSearch } from "../src/domain/FocusSearch";
import type { FocusResult } from "../src/domain/FocusSearch";
import { BlockIdService } from "../src/infra/BlockIdService";
import { PluginDataStore } from "../src/infra/PluginDataStore";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { installObsidianDom } from "./support/dom";
import { t } from "../src/util/i18n";

installObsidianDom();
const controllers: CardStreamController[] = [];
afterEach(() => { for (const controller of controllers) controller.destroy(); controllers.length = 0; document.body.replaceChildren(); });

function fixture(overrides: Record<string, unknown> = {}, paths = ["Sources/Note.md"], bodies: Record<string, string> = {}) {
  const files = paths.map((path) => new TFile(path));
  const settings = { ...DEFAULT_SETTINGS, virtualScroll: false, ...overrides };
  const body = (path: string) => bodies[path] ?? "Full body";
  const folders = new Set(paths.map((path) => path.split("/").slice(0, -1).join("/")).filter(Boolean));
  if (paths.some((path) => path.startsWith("Sources/"))) folders.add("Sources");
  const gateway = {
    getMarkdownFiles: () => files,
    getFileCache: () => ({ tags: [], headings: [], blocks: {} }),
    getAbstractFileByPath: (path: string) => folders.has(path) ? new TFolder() : files.find((file) => file.path === path) ?? null,
    read: async (file: TFile) => body(file.path),
  };
  const refByPath = new Map(files.map((file) => [file.path, `ref:${file.path}`]));
  const editors = {
    fileRef: (file: TFile) => refByPath.get(file.path)!,
    path: (ref: string) => ref.slice(4),
    file: (ref: string) => files.find((file) => refByPath.get(file.path) === ref)!,
    readSource: vi.fn(async (ref: string) => body(ref.slice(4))),
    subscribe: () => () => {},
    onContentChanged: () => () => {},
    bind: (editorId: string) => ({ fileRef: editorId, editorId, generation: 1, path: `Drafts/${editorId}.md` }),
    release: () => {},
    ticket: (binding?: { fileRef: string; editorId: string; generation: number }) => {
      if (!binding) throw new Error("TARGET_MISSING");
      return { fileRef: binding.fileRef, editorId: binding.editorId, revision: 1, baselineText: "Draft", range: { from: 0, to: 0 }, bindingGeneration: binding.generation };
    },
    validate: () => {},
    commit: vi.fn(() => ({ targetPath: "Drafts/Out.md", range: { from: 0, to: 4 }, text: "Cite", before: "", after: "" })),
    copy: vi.fn(async () => {}),
    options: () => [],
    show: () => {},
    editorId: () => undefined,
  };
  const leaves: Array<{ view: unknown }> = [];
  const app = { vault: { getAbstractFileByPath: gateway.getAbstractFileByPath, getMarkdownFiles: () => files, read: gateway.read },
    metadataCache: { getFileCache: () => ({ headings: [], blocks: {} }), getFirstLinkpathDest: (p: string) => files.find((f) => f.path === p) ?? null },
    workspace: { getActiveFile: () => files[0], getLeavesOfType: (type?: string) => (type === "markdown" ? leaves : []), openLinkText: vi.fn(async () => {}) } };
  let saveFail = false;
  const store = new PluginDataStore({ load: async () => null, save: vi.fn(async () => { if (saveFail) throw new Error("SAVE_FAIL"); }), backup: vi.fn(async () => {}) });
  store.data.settings = settings;
  const desks = new DeskService(store);
  const outline = new OutlineService(desks, store);
  const history = new CitationRecordsService(store);
  const collections = new CollectionService({ app: app as never, gateway: gateway as never,
    fileRef: (file) => editors.fileRef(file), globalExcludeGlobs: () => String(settings.excludeGlobs).split(",").map((glob) => glob.trim()).filter(Boolean) });
  const searchReader = new SearchDocumentReader(editors as never);
  const focusSearch = new FocusSearch(searchReader);
  const blockIds = new BlockIdService(app as never, editors as never);
  const evidence = new EvidenceResolver({
    resolveRef: (path) => (files.find((f) => f.path === path) ? refByPath.get(path) : undefined),
    read: (fileRef, signal) => searchReader.read(fileRef, signal),
    capture: (fileRef, text) => blockIds.capture(editors.file(fileRef) as never, text),
  });
  const realEngine = new CitationEngine({
    settings: () => store.data.settings,
    consentAccepted: () => store.blockIdConsentAccepted,
    anchorWritesEnabled: () => !store.readOnly,
    sources: blockIds,
    editors: editors as never,
    links: new CitationLinkService(app as never, editors as never),
    records: history,
  });
  const executeMock = vi.fn(async (intent: { operationId: string; action: string }) => ({ operationId: intent.operationId, status: "success", sourceAnchor: "unchanged", effect: intent.action === "copy" ? "copied" : "inserted", precision: "fragment", recording: "disabled" }));
  const plugin = {
    settings, store, desks, outline, evidence, collections, searchReader, focusSearch, editors, blockIds,
    dragTokens: new Map(), citationBusy: 0, templateRevision: 0,
    app, gateway, renderService: { renderUnit: async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; }, clearCache() {} },
    history, logger: { error: vi.fn() },
    cite: {
      execute: executeMock,
      prepareBatch: realEngine.prepareBatch.bind(realEngine),
      commitBatch: realEngine.commitBatch.bind(realEngine),
      releaseBatchPlan: realEngine.releaseBatchPlan.bind(realEngine),
    },
    openCitationSettings: () => {}, scheduleRefresh: () => {}, openHistory: () => {},
  };
  const controller = new CardStreamController(plugin as never, { requestSaveState() {} } as never);
  controllers.push(controller);
  const root = document.createElement("div");
  return { controller, root, plugin, files, store, leaves, realEngine, setSaveFail: (v: boolean) => { saveFail = v; } };
}

const titles = (root: HTMLElement) => [...root.querySelectorAll(".slipstream-card-title")].map((el) => el.textContent);
const focusResults = (controller: CardStreamController) => (controller as unknown as { focusResults: { results(): FocusResult[] } }).focusResults.results();
const groupOrder = (root: HTMLElement) => [...root.querySelectorAll(".slipstream-focus-group-title")].map((el) => el.textContent);

function deferredText() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("CardStreamController (0.1.5)", () => {
  it("renders the complete outline document through the production Markdown renderer", async () => {
    const bodies = { "Sources/1.md": "Evidence alpha. ^evidence", "Drafts/Out.md": "Draft" };
    const customTemplate = ["{{content}} ({{link}})", "Read [evidence][paper].", ...Array.from({ length: 24 }, (_, i) => `Paragraph ${i}.`), "[paper]: https://example.com/paper"].join("\n\n");
    const f = fixture({ defaultTemplate: "D", customTemplate }, Object.keys(bodies), bodies);
    f.plugin.editors.bind = (editorId: string) => ({ fileRef: editorId, editorId, generation: 1, path: editorId.slice(4) });
    const parser = new MarkdownIt();
    const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, container) => {
      container.innerHTML = parser.render(markdown);
    });
    try {
      await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
      await f.controller.mount(f.root);
      await f.controller.createDesk("Essay", "Drafts/Out.md", "render-preview");
      f.controller.bindTarget("ref:Drafts/Out.md");
      const snapshot = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"]);
      await f.controller.collectToOutline(snapshot, { spans: [snapshot.spans[0]], content: "Evidence alpha.", mode: "block", selectedRanges: [{ ...snapshot.spans[0].rawRange }] });
      f.controller.openPreview({ kind: "all" });
      await vi.waitFor(() => expect(document.body.querySelector(".slipstream-outline-markdown")?.textContent).toContain("[evidence][paper]"));
      const markdown = document.body.querySelector(".slipstream-outline-markdown")!.textContent!;
      [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")]
        .find((button) => button.textContent === t("outline.previewRendered"))!.click();
      await vi.waitFor(() => expect(document.body.querySelector(".slipstream-outline-rendered a")?.getAttribute("href")).toBe("https://example.com/paper"));
      expect(render).toHaveBeenCalledOnce();
      expect(render).toHaveBeenCalledWith(f.plugin.app, markdown, expect.any(HTMLElement), "Drafts/Out.md", expect.any(Component));
    } finally {
      render.mockRestore();
      [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")]
        .find((button) => button.textContent === t("common.cancel"))?.click();
    }
  });

  it("renders a legacy single source as temporary browse honoring global and rule exclusions", async () => {
    const f = fixture({ excludeGlobs: "Sources/hidden.md, Other/**" }, ["Sources/hidden.md", "Sources/manual.md", "Sources/keep.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources", options: { excludeGlobs: ["Sources/manual.md"] } } });
    await f.controller.mount(f.root);
    await vi.waitFor(() => expect(titles(f.root)).toEqual(["keep"]));
    expect(f.controller.serializeViewState()).toMatchObject({ viewStateVersion: 2 });
  });

  it("adds and removes sources as a temporary collection", async () => {
    const f = fixture({}, ["A/one.md", "B/two.md"]);
    await f.controller.restore({});
    await f.controller.mount(f.root);
    f.controller.addRule({ kind: "folder", value: "A", options: { includeSubfolders: true } });
    await vi.waitFor(() => expect(titles(f.root)).toEqual(["one"]));
    f.controller.addRule({ kind: "folder", value: "B", options: { includeSubfolders: true } });
    await vi.waitFor(() => expect(titles(f.root)).toEqual(["one", "two"]));
    f.controller.removeRule(f.controller.getRules()[0].id);
    await vi.waitFor(() => expect(titles(f.root)).toEqual(["two"]));
  });

  it("paginates the full collection by page size instead of truncating it", async () => {
    const paths = ["Sources/1.md", "Sources/2.md", "Sources/3.md", "Sources/4.md", "Sources/5.md"];
    const f = fixture({ collectionPageSize: 2 }, paths);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await vi.waitFor(() => expect(titles(f.root).length).toBe(2));
    const more = f.root.querySelector<HTMLButtonElement>(".slipstream-statusbar button")!;
    more.click();
    expect(titles(f.root).length).toBe(4);
    f.root.querySelector<HTMLButtonElement>(".slipstream-statusbar button")!.click();
    expect(titles(f.root).length).toBe(5);
    expect(f.root.querySelector(".slipstream-statusbar")?.textContent).toContain("All loaded");
  });

  it("creates a desk from the current browse and persists its id in view state", async () => {
    const f = fixture({}, ["Sources/one.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    const result = await f.controller.createDesk("My desk", "Sources/one.md", "create-1");
    expect(result).toBe("ok");
    expect(f.controller.serializeViewState()).toMatchObject({ viewStateVersion: 2, deskId: expect.any(String) });
    expect(f.plugin.desks.list()).toHaveLength(1);
  });

  it("refuses to cite a result whose source changed after the search", async () => {
    const f = fixture({}, ["Sources/1.md"], { "Sources/1.md": "Alpha needle beta." });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    const results = (f.controller as unknown as { focusResults: { results(): Array<{ sourceRef: string }> } }).focusResults.results();
    f.plugin.searchReader.invalidate(results[0].sourceRef);
    await f.controller.cite(results[0] as never, "copy");
    expect(f.plugin.cite.execute).not.toHaveBeenCalled();
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain(t("error.SOURCE_STALE"));
  });

  it("keeps an observed missing manual reference across refreshes", async () => {
    const f = fixture({}, ["Sources/one.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk", "Sources/one.md", "op-1");
    f.controller.addManual("Other/missing.md");
    const desk = () => f.plugin.desks.list()[0];
    await vi.waitFor(() => expect(desk().unresolvedRefs.some((ref) => ref.path === "Other/missing.md")).toBe(true));
    f.controller.refresh();
    await vi.waitFor(() => expect(desk().unresolvedRefs.some((ref) => ref.path === "Other/missing.md")).toBe(true));
  });

  it("refuses to cite a code block whose content changed after the search", async () => {
    const bodies: Record<string, string> = { "Sources/code.md": "```\nneedle\n```" };
    const f = fixture({}, ["Sources/code.md"], bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    const results = (f.controller as unknown as { focusResults: { results(): Array<{ sourceRef: string }> } }).focusResults.results();
    bodies["Sources/code.md"] = "```\nxxxxxx\n```";
    await f.controller.cite(results[0] as never, "copy");
    expect(f.plugin.cite.execute).not.toHaveBeenCalled();
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain(t("error.SOURCE_STALE"));
  });

  it("re-sorts focus results when the sort changes without rescanning", async () => {
    const f = fixture({}, ["Sources/b.md", "Sources/a.md"], { "Sources/b.md": "needle", "Sources/a.md": "needle" });
    f.files[0].stat.mtime = 200;
    f.files[1].stat.mtime = 100;
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    const groupOrder = () => [...f.root.querySelectorAll(".slipstream-focus-group-title")].map((el) => el.textContent);
    expect(groupOrder()).toEqual(["Sources/b.md", "Sources/a.md"]);
    f.controller.setSort("name");
    f.controller.setSortAsc(true);
    expect(groupOrder()).toEqual(["Sources/a.md", "Sources/b.md"]);
  });

  it("finds body matches across the whole collection, not just the loaded page", async () => {
    const paths = ["Sources/1.md", "Sources/2.md", "Sources/3.md"];
    const f = fixture({ collectionPageSize: 1 }, paths, { "Sources/3.md": "Only the last note has a needle." });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await vi.waitFor(() => expect(titles(f.root).length).toBe(1));
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    expect(f.root.querySelector(".slipstream-focus-result")?.textContent).toContain("needle");
  });

  it("rejects a cross-source DOM selection without inserting or creating a drag token", async () => {
    const bodies = { "Sources/A.md": "```text\nneedle A\n```", "Sources/B.md": "```text\nneedle B\n```" };
    const f = fixture({}, Object.keys(bodies), bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    document.body.append(f.root);
    try {
      f.controller.setQuery("needle");
      await vi.waitFor(() => expect(focusResults(f.controller)).toHaveLength(2));
      const nodes = f.root.querySelectorAll(".slipstream-focus-preview mark");
      const range = document.createRange();
      range.setStart(nodes[0].firstChild!, 0);
      range.setEnd(nodes[1].firstChild!, 6);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      const button = f.root.querySelector<HTMLButtonElement>(".slipstream-focus-actions button")!;
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      button.click();
      expect(f.plugin.cite.execute).not.toHaveBeenCalled();
      expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toBe(t("error.SOURCE_MAPPING_UNSUPPORTED"));
      expect(f.controller.drag(focusResults(f.controller)[0], { selectionInvalid: true })).toBeUndefined();
      expect(f.plugin.dragTokens.size).toBe(0);
    } finally { window.getSelection()?.removeAllRanges(); f.root.remove(); }
  });

  it("validates selected code text against the displayed source preview", async () => {
    const f = fixture({}, ["Sources/code.md"], { "Sources/code.md": "```text\nneedle A\n```" });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.progress()?.phase).toBe("complete"));
    const result = focusResults(f.controller)[0];
    await f.controller.cite(result, "copy", { selection: "needle A unrelated source" });
    expect(f.plugin.cite.execute).not.toHaveBeenCalled();
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toBe(t("error.SOURCE_MAPPING_UNSUPPORTED"));
    await f.controller.cite(result, "copy", { selection: "nee" });
    expect(f.plugin.cite.execute).toHaveBeenCalledWith(expect.objectContaining({ content: "nee", mode: "fragment" }), expect.anything());
  });

  it("cannot restore an old query when sorting a new query that is still reading", async () => {
    const bodies = { "Sources/A.md": "needle only", "Sources/B.md": "other only" };
    const f = fixture({}, Object.keys(bodies), bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.progress()?.phase).toBe("complete"));
    const gate = deferredText();
    f.plugin.searchReader.clear();
    f.plugin.editors.readSource.mockImplementation(async (ref) => ref === "ref:Sources/B.md" ? gate.promise : bodies[ref.slice(4) as keyof typeof bodies]);
    try {
      f.controller.setQuery("other");
      await vi.waitFor(() => expect(f.controller.progress()?.scanned).toBe(1));
      expect(f.controller.hasResults()).toBe(false);
      f.controller.setSort("name");
      expect(f.controller.getQuery()).toBe("other");
      expect(f.controller.hasResults()).toBe(false);
    } finally { gate.resolve("other only"); }
    await vi.waitFor(() => expect(f.controller.progress()?.phase).toBe("complete"));
    expect(groupOrder(f.root)).toEqual(["Sources/B.md"]);
  });

  it("applies the latest sort to partial and completed results without restarting the scan", async () => {
    const bodies = { "Sources/A.md": "needle", "Sources/M.md": "needle", "Sources/Z.md": "needle" };
    const f = fixture({}, Object.keys(bodies), bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setSort("name");
    f.controller.setSortAsc(true);
    const gate = deferredText();
    f.plugin.editors.readSource.mockImplementation(async (ref) => ref === "ref:Sources/M.md" ? gate.promise : "needle");
    const scan = vi.spyOn(f.plugin.focusSearch, "run");
    try {
      f.controller.setQuery("needle");
      await vi.waitFor(() => expect(groupOrder(f.root)).toEqual(["Sources/A.md", "Sources/Z.md"]));
      f.controller.setSortAsc(false);
      expect(groupOrder(f.root)).toEqual(["Sources/Z.md", "Sources/A.md"]);
      expect(scan).toHaveBeenCalledTimes(1);
    } finally { gate.resolve("needle"); }
    await vi.waitFor(() => expect(f.controller.progress()?.phase).toBe("complete"));
    expect(groupOrder(f.root)).toEqual(["Sources/Z.md", "Sources/M.md", "Sources/A.md"]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("synchronizes source and reading controls when switching and deleting the current desk", async () => {
    const f = fixture({}, ["Sources/a.md", "Other/b.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    const created = await f.plugin.desks.create({ id: "controls", name: "Other desk", targetPath: "Sources/a.md",
      rules: [{ id: "other-rule", spec: { kind: "folder", value: "Other" } }],
      reading: { density: "compact", sort: "name", sortAsc: true, filter: "b" } });
    await f.controller.openDesk(created.desk!.id);
    expect(f.root.querySelector(".slipstream-sourcebar")?.textContent).toContain("Other");
    expect(f.root.querySelector<HTMLSelectElement>(".slipstream-toolbar select")?.value).toBe("name");
    expect(f.root.querySelector<HTMLInputElement>(".slipstream-toolbar input")?.value).toBe("b");
    expect(f.root.querySelector(".slipstream-toolbar .is-active")?.textContent).toBe(t("tb.compact"));
    expect(f.root.querySelector(`.slipstream-toolbar [aria-label="${t("sort.asc")}"]`)).toBeTruthy();
    await f.controller.deleteDesk(created.desk!.id);
    expect(f.root.querySelector(".slipstream-sourcebar")?.textContent).toContain(t("src.noRules"));
    expect(f.root.querySelector<HTMLSelectElement>(".slipstream-toolbar select")?.value).toBe("mtime");
    expect(f.root.querySelector<HTMLInputElement>(".slipstream-toolbar input")?.value).toBe("");
  });

  it("preserves unresolved ref kind/scope/ruleId for both manual and rule issues", async () => {
    const f = fixture({}, ["Sources/one.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk", "Sources/one.md", "op-unresolved");
    f.controller.addRule({ kind: "backlinks", value: "MissingAnchor.md", anchorFile: "MissingAnchor.md" });
    f.controller.addManual("Other/missing.md");
    const desk = () => f.plugin.desks.list()[0];
    await vi.waitFor(() => expect(desk().unresolvedRefs).toHaveLength(2));
    expect(desk().unresolvedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "MissingAnchor.md", kind: "folder", scope: "rule", reason: "missing" }),
      { path: "Other/missing.md", kind: "file", scope: "manual", reason: "missing" },
    ]));
  });

  it("recovers cleanly when expandSection or cite fails asynchronously", async () => {
    const f = fixture({}, ["Sources/1.md"], { "Sources/1.md": "Alpha needle beta." });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    const result = focusResults(f.controller)[0];
    f.plugin.editors.readSource.mockRejectedValueOnce(new Error("disk error"));
    const section = document.createElement("div");
    const btn = document.createElement("button");
    await f.controller.expandSection(result, section, btn);
    expect(section.classList.contains("is-hidden")).toBe(true);
    expect(btn.textContent).toBe(t("focus.expandSection"));
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toBe(t("error.SOURCE_READ_FAILED"));

    f.plugin.cite.execute.mockRejectedValueOnce(new Error("unexpected"));
    await f.controller.cite(result, "copy");
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toBe(t("state.error"));
  });

  it("notifies and keeps current desk state when opening a missing desk", async () => {
    const f = fixture({}, ["Sources/1.md"]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk", "Sources/1.md", "op-open-missing");
    Notice.messages.length = 0;
    await f.controller.openDesk("non-existent-desk");
    expect(Notice.messages).toContain(t("desk.missing"));
    expect(f.controller.currentDesk()?.name).toBe("Desk");
  });

  it("switches between Materials and Outline without losing reading/focus state, and collects from focus without calling CitationEngine.execute or ensure", async () => {
    const f = fixture({}, ["Sources/1.md"], { "Sources/1.md": "Alpha needle beta.\n\nGamma delta." });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk", "Drafts/Out.md", "op-outline-1");

    const ensureSpy = vi.spyOn(f.plugin.blockIds, "ensure");
    f.controller.setQuery("needle");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));

    const addBtn = [...f.root.querySelectorAll<HTMLButtonElement>(".slipstream-focus-actions button")].find(
      (b) => b.textContent === t("outline.addToOutline"),
    )!;
    addBtn.click();
    await vi.waitFor(() => expect(f.plugin.outline.getOutline(f.controller.currentDeskId()!)?.outline.entries).toHaveLength(1));

    expect(f.plugin.cite.execute).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(f.root.querySelector(".slipstream-mode-switch")?.textContent).toContain("(1)");

    // Switch to Outline and back to Materials -> focus query & results stay intact
    f.controller.openOutline();
    expect(f.root.querySelector(".slipstream-outline-panel")?.classList.contains("is-hidden")).toBe(false);
    expect(f.root.querySelector(".slipstream-outline-panel")?.textContent).toContain("Alpha needle beta.");
    f.controller.switchToMaterials();
    expect(f.controller.hasResults()).toBe(true);
    expect(f.controller.getQuery()).toBe("needle");
  });

  it("requires saving as a named desk before collecting, aborts if source changed during desk creation, and handles duplicate/retry cleanly", async () => {
    const bodies: Record<string, string> = { "Sources/1.md": "Original excerpt." };
    const f = fixture({}, ["Sources/1.md"], bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await vi.waitFor(() => expect(titles(f.root)).toEqual(["1"]));

    // No active selection -> collectActiveToOutline refuses without defaulting to first block
    await f.controller.collectActiveToOutline();
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain(t("outline.noActiveSelection"));

    const snapshot = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    const fragment = { spans: [snapshot.spans[0]], content: "Original excerpt.", mode: "block" as const, selectedRanges: [{ ...snapshot.spans[0].rawRange }] };

    // Temporary browse prompts to save desk; mutate source before createDesk finishes -> rejects stale capture
    const collectPromise = f.controller.collectToOutline(snapshot, fragment);
    await vi.waitFor(() => expect(document.body.querySelector(".slipstream-citation-prompt")).toBeTruthy());
    [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-citation-prompt button")].find((b) => b.textContent === t("desk.saveAs"))!.click();
    await collectPromise;
    bodies["Sources/1.md"] = "Mutated excerpt.";
    await f.controller.createDesk("New Desk", "Sources/1.md", "op-temp-stale");
    expect(f.plugin.outline.getOutline(f.controller.currentDeskId()!)?.outline.entries).toHaveLength(0);
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain(t("error.SOURCE_STALE"));

    // Valid collect + duplicate prompt -> "Collect anyway" adds independent 2nd entry
    const fresh = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    await f.controller.collectToOutline(fresh, { spans: [fresh.spans[0]], content: "Mutated excerpt.", mode: "block" });
    expect(f.plugin.outline.getOutline(f.controller.currentDeskId()!)?.outline.entries).toHaveLength(1);

    const dupPromise = f.controller.collectToOutline(fresh, { spans: [fresh.spans[0]], content: "Mutated excerpt.", mode: "block" });
    await vi.waitFor(() => expect(document.body.querySelector(".slipstream-citation-prompt")).toBeTruthy());
    [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-citation-prompt button")].find((b) => b.textContent === t("outline.duplicateStillCollect"))!.click();
    await dupPromise;
    expect(f.plugin.outline.getOutline(f.controller.currentDeskId()!)?.outline.entries).toHaveLength(2);
  });

  it("handles leave-to-editor target and source reselect handoffs and expires on desk switch (AC-42)", async () => {
    const bodies: Record<string, string> = { "Sources/1.md": "First block.\n\nSecond block.", "Drafts/Out.md": "Target line." };
    const f = fixture({}, ["Sources/1.md", "Drafts/Out.md"], bodies);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk A", "Drafts/Out.md", "op-handoff");
    await f.controller.createDesk("Desk B", "Drafts/Out.md", "op-handoff-b");
    const deskAId = f.plugin.desks.list()[0].id;
    await f.controller.openDesk(deskAId);

    const snap = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    await f.plugin.outline.collect({
      deskId: deskAId,
      expectedRevision: 0,
      entryId: "e1",
      snapshot: {
        content: "First block.",
        mode: "block",
        source: { path: "Sources/1.md", capturedPath: "Sources/1.md", title: "1", capturedAt: 1, sourceLength: bodies["Sources/1.md"].length, identity: "path-reference" },
        origins: [{ range: { ...snap.spans[0].rawRange }, rawText: snap.spans[0].rawText, kind: snap.spans[0].kind, before: "", after: "\n\nSecond block." }],
        selectedRanges: [{ ...snap.spans[0].rawRange }],
      },
    });

    // Open preview modal, suspend for source reselect, provide open MarkdownView selection, confirm refresh & return
    f.controller.openPreview({ kind: "all" });
    await vi.waitFor(() => expect(document.body.querySelector(".slipstream-outline-modal")).toBeTruthy());
    // Close modal via suspend flow using draft banner after binding a source editor selection
    const mdView = new MarkdownView(f.files[0] as never, {
      getSelection: () => "Second block.",
      getCursor: (which: string) => ({ line: which === "from" ? 2 : 2, ch: which === "from" ? 0 : 13 }),
      posToOffset: (pos: { ch: number }) => (pos.ch === 0 ? 14 : 27),
      getValue: () => bodies["Sources/1.md"],
    }, document.createElement("div"));
    f.leaves.push({ view: mdView });

    // Trigger suspend-source via controller's modal options (click goReselectSource if present, or verify draft banner on switch)
    const reselectBtn = [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")].find(
      (b) => b.textContent === t("outline.goReselectSource"),
    );
    if (reselectBtn) {
      reselectBtn.click();
      expect(f.root.querySelector(".slipstream-outline-draft-banner")?.classList.contains("is-hidden")).toBe(false);
      f.root.querySelector<HTMLButtonElement>(".slipstream-outline-draft-banner button")!.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain(t("outline.refreshConfirm")));
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t("outline.refreshConfirm"))!.click();
      await vi.waitFor(() => expect(f.plugin.outline.getEntry(deskAId, "e1")?.snapshot.content).toBe("Second block."));
    }

    // Switching desks cancels any active preview draft
    await f.controller.openDesk(f.plugin.desks.list()[1].id);
    expect(f.root.querySelector(".slipstream-outline-draft-banner")?.classList.contains("is-hidden")).toBe(true);
  });

  it("retains retryRecordOnly button and uncertain feedback even after modal closes or desk switches (Bug 3)", async () => {
    const bodies: Record<string, string> = { "Sources/1.md": "Evidence alpha.", "Drafts/Out.md": "Draft" };
    const f = fixture({}, ["Sources/1.md", "Drafts/Out.md"], bodies);
    f.store.data.consent.blockIdExplanationAccepted = true;
    await f.store.acceptBlockIds();
    (f.plugin.app.vault as { process?: unknown }).process = async (file: TFile, fn: (c: string) => string) => {
      bodies[file.path] = fn(bodies[file.path] ?? "");
      return bodies[file.path];
    };
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk A", "Drafts/Out.md", "op-bug3-a");
    await f.controller.createDesk("Desk B", "Drafts/Out.md", "op-bug3-b");
    const deskAId = f.plugin.desks.list()[0].id;
    await f.controller.openDesk(deskAId);
    f.controller.bindTarget("ref:Drafts/Out.md");

    const snap = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    await f.controller.collectToOutline(snap, {
      spans: [snap.spans[0]],
      content: "Evidence alpha.",
      mode: "block",
      selectedRanges: [{ ...snap.spans[0].rawRange }],
    });

    // Delay commitBatch so modal can close and desk can switch before commit resolves with recording: "pending".
    let resolveCommit!: (v: unknown) => void;
    const origCommit = f.plugin.cite.commitBatch;
    f.plugin.cite.commitBatch = vi.fn(() => new Promise((r) => { resolveCommit = r; })) as never;
    f.controller.openPreview({ kind: "all" });
    await vi.waitFor(() => {
      const btn = document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active");
      expect(btn && !btn.disabled).toBe(true);
    });
    document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active")!.click();
    // Switch desk while commit is in flight (simulating modal closure / desk switch before commit resolves).
    Notice.messages.length = 0;
    await f.controller.openDesk(f.plugin.desks.list()[1].id);
    resolveCommit({
      batchId: "batch-pending-1",
      planId: "plan-1",
      status: "partial",
      effect: "inserted",
      recording: "pending",
      code: "RECORD_SAVE_FAILED",
      targetPath: "Drafts/Out.md",
      includedItemCount: 1,
      hasSkeleton: false,
      sourceResults: [],
      items: [],
    });
    await vi.waitFor(() => {
      const fb = f.root.querySelector(".slipstream-operation-feedback")!;
      expect(fb.textContent).toContain(t("outline.retryRecordOnly"));
    });
    expect(Notice.messages.some((m) => m.includes("Drafts/Out.md"))).toBe(true);
    const retrySpy = vi.spyOn(f.plugin.history, "retryBatch").mockResolvedValueOnce("saved");
    [...f.root.querySelectorAll<HTMLButtonElement>(".slipstream-operation-feedback button")]
      .find((b) => b.textContent === t("outline.retryRecordOnly"))!.click();
    await vi.waitFor(() => expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain(t("citation.recordSaved")));
    expect(retrySpy).toHaveBeenCalledWith("batch-pending-1");
    [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")]
      .find((b) => b.textContent === t("common.close"))?.click();

    // Uncertain outcome displays commitUncertain, never commitSuccess.
    await f.controller.openDesk(deskAId);
    f.controller.bindTarget("ref:Drafts/Out.md");
    f.plugin.cite.commitBatch = vi.fn(async () => ({
      batchId: "batch-uncertain-1",
      planId: "plan-2",
      status: "uncertain",
      effect: "unknown",
      recording: "not-attempted",
      code: "COMMIT_STATE_UNCERTAIN",
      targetPath: "Drafts/Out.md",
      includedItemCount: 1,
      hasSkeleton: false,
      sourceResults: [],
      items: [],
    })) as never;
    f.controller.openPreview({ kind: "all" });
    await vi.waitFor(() => {
      const btn = document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active");
      expect(btn && !btn.disabled).toBe(true);
    });
    document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active")!.click();
    await vi.waitFor(() => {
      const fb = f.root.querySelector(".slipstream-operation-feedback")!;
      expect(fb.textContent).toContain(t("outline.commitUncertain", { path: "Drafts/Out.md" }));
      expect(fb.textContent).not.toContain("Inserted into");
    });
    [...document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")]
      .find((b) => b.textContent === t("common.close"))?.click();

    // Partial source anchor modification after closing modal surfaces modified source path & IDs in controller feedback.
    const { OutlineInsertModal } = await import("../src/view/OutlineInsertModal");
    let openedPartialModal: InstanceType<typeof OutlineInsertModal> | undefined;
    const openSpy = vi.spyOn(OutlineInsertModal.prototype, "open").mockImplementation(function (this: InstanceType<typeof OutlineInsertModal>) {
      openedPartialModal = this;
      return OutlineInsertModal.prototype.onOpen ? (() => { document.body.appendChild(this.contentEl); this.onOpen(); })() : undefined;
    });
    let resolvePartial!: (v: unknown) => void;
    f.plugin.cite.commitBatch = vi.fn(() => new Promise((r) => { resolvePartial = r; })) as never;
    f.controller.openPreview({ kind: "all" });
    openSpy.mockRestore();
    await vi.waitFor(() => {
      const btn = document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active");
      expect(btn && !btn.disabled).toBe(true);
    });
    document.body.querySelector<HTMLButtonElement>(".slipstream-outline-modal-actions button.is-active")!.click();
    await vi.waitFor(() => expect(openedPartialModal).toBeDefined());
    openedPartialModal!.close();
    resolvePartial({
      batchId: "batch-partial-src",
      planId: "plan-3",
      status: "partial",
      effect: "none",
      recording: "not-attempted",
      code: "OPERATION_CANCELLED",
      targetPath: "Drafts/Out.md",
      includedItemCount: 1,
      hasSkeleton: false,
      sourceResults: [{ sourceRef: "ref:Sources/1.md", sourcePath: "Sources/1.md", kind: "created", createdIds: ["^id1"], reusedIds: [] }],
      items: [],
    });
    await vi.waitFor(() => {
      const fb = f.root.querySelector(".slipstream-operation-feedback")!;
      expect(fb.textContent).toContain(t("outline.commitPartialSources"));
      expect(fb.textContent).toContain("Sources/1.md");
      expect(fb.textContent).toContain("^id1");
    });
    f.plugin.cite.commitBatch = origCommit;
  });

  it("detects duplicate when a partial selection inserted normally is later collected to outline and previewed (Bug 4)", async () => {
    const bodies: Record<string, string> = { "Sources/1.md": "Alpha beta gamma delta. ^b1", "Drafts/Out.md": "Draft" };
    const f = fixture({}, ["Sources/1.md", "Drafts/Out.md"], bodies);
    f.store.data.consent.blockIdExplanationAccepted = true;
    await f.store.acceptBlockIds();
    (f.plugin.editors as { writeSource?: unknown }).writeSource = () => false;
    (f.plugin.app.vault as { process?: unknown }).process = async (file: TFile, fn: (c: string) => string) => {
      bodies[file.path] = fn(bodies[file.path] ?? "");
      f.plugin.searchReader.invalidate("ref:" + file.path);
      return bodies[file.path];
    };
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    await f.controller.createDesk("Desk Dup", "Drafts/Out.md", "op-bug4");
    f.controller.bindTarget("ref:Drafts/Out.md");

    // Use real CitationEngine.execute so inserted duplicate keys are tracked.
    f.plugin.cite.execute = f.realEngine.execute.bind(f.realEngine);
    f.controller.setQuery("beta");
    await vi.waitFor(() => expect(f.controller.hasResults()).toBe(true));
    const result = focusResults(f.controller)[0];
    // 1. Insert partial fragment via normal focus citation.
    await f.controller.cite(result, "insert", { selection: "beta", selectedRanges: [{ from: 6, to: 10 }] });
    // 2. Collect the exact same selection to outline and open preview -> BATCH_DUPLICATE detected!
    await f.controller.collectToOutline(result, { selection: "beta", selectedRanges: [{ from: 6, to: 10 }] });
    f.controller.openPreview({ kind: "all" });
    await vi.waitFor(() => {
      const text = document.body.querySelector(".slipstream-outline-modal")?.textContent ?? "";
      expect(text, `focus-dup modal: ${text}`).toContain(t("outline.issueDuplicate"));
    });
    document.body.querySelectorAll<HTMLButtonElement>(".slipstream-outline-modal button")
      .forEach((b) => { if (b.textContent === t("common.cancel")) b.click(); });

    // Also verify normal card selection (CitationSelection.captureSelection -> CitationEngine.execute) -> outline selection duplicate.
    bodies["Sources/1.md"] = "First word second word.";
    f.plugin.searchReader.invalidate("ref:Sources/1.md");
    const snapBefore = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    const captureCardSelection = async (snap: typeof snapBefore) => {
      const span = snap.spans[0];
      const cardBody = document.createElement("div");
      const p = cardBody.createEl("p", { text: "First word second word." });
      document.body.appendChild(cardBody);
      const { captureSelection } = await import("../src/view/CitationSelection");
      const units = new Map([[p, { origin: span, content: p.textContent!, mode: "block" as const, key: "u1" }]]);
      const range = document.createRange();
      range.setStart(p.firstChild!, 6);
      range.setEnd(p.firstChild!, 17);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      const captured = captureSelection(cardBody, units)!;
      sel.removeAllRanges();
      cardBody.remove();
      return captured;
    };
    const captured1 = await captureCardSelection(snapBefore);
    const ticket = f.plugin.editors.ticket(f.controller.getTarget());
    const execRes = await f.realEngine.execute({
      operationId: "op-normal-sel",
      action: "insert",
      snapshot: snapBefore,
      spans: captured1.spans,
      mode: captured1.mode,
      content: captured1.content,
      selectionKey: captured1.selectionKey,
      templateId: "A",
      date: "2026-11-27",
    }, { ticket });
    expect(execRes.effect).toBe("inserted");
    const snapAfter = f.plugin.blockIds.capture(f.files[0] as never, bodies["Sources/1.md"], "1");
    const captured2 = await captureCardSelection(snapAfter);
    await f.controller.collectToOutline(snapAfter, captured2);
    f.controller.openPreview({ kind: "all" });
    await vi.waitFor(() => {
      const modalText = document.body.querySelector(".slipstream-outline-modal")?.textContent ?? "";
      expect(modalText, `card-dup modal: ${modalText}`).toContain(t("outline.issueDuplicate"));
    });
  });
});
