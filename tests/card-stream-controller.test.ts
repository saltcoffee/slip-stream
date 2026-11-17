// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFolder, TFile } from "./support/obsidian";
import { CardStreamController } from "../src/domain/CardStreamController";
import { DeskService } from "../src/domain/DeskService";
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
afterEach(() => { for (const controller of controllers) controller.destroy(); controllers.length = 0; });

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
    bind: (editorId: string) => ({ fileRef: editorId, editorId, generation: 1, path: `Drafts/${editorId}.md` }),
    release: () => {},
    ticket: () => ({ baselineText: "Draft", range: { from: 0, to: 0 } }),
    options: () => [],
    show: () => {},
    editorId: () => undefined,
  };
  const app = { vault: { getAbstractFileByPath: gateway.getAbstractFileByPath, getMarkdownFiles: () => files },
    metadataCache: { getFileCache: () => ({ headings: [], blocks: {} }) }, workspace: { getActiveFile: () => files[0], getLeavesOfType: () => [] } };
  const store = new PluginDataStore({ load: async () => null, save: vi.fn(async () => {}), backup: vi.fn(async () => {}) });
  const desks = new DeskService(store);
  const collections = new CollectionService({ app: app as never, gateway: gateway as never,
    fileRef: (file) => editors.fileRef(file), globalExcludeGlobs: () => String(settings.excludeGlobs).split(",").map((glob) => glob.trim()).filter(Boolean) });
  const searchReader = new SearchDocumentReader(editors as never);
  const focusSearch = new FocusSearch(searchReader);
  const blockIds = new BlockIdService(app as never, editors as never);
  const plugin = {
    settings, store, desks, collections, searchReader, focusSearch, editors, blockIds,
    dragTokens: new Map(), citationBusy: 0,
    app, gateway, renderService: { renderUnit: async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; }, clearCache() {} },
    history: { list: () => [] }, logger: { error: vi.fn() },
    cite: { execute: vi.fn(async (intent: { operationId: string; action: string }) => ({ operationId: intent.operationId, status: "success", sourceAnchor: "unchanged", effect: intent.action === "copy" ? "copied" : "inserted", precision: "fragment", recording: "disabled" })) },
    openCitationSettings: () => {}, scheduleRefresh: () => {}, openHistory: () => {},
  };
  const controller = new CardStreamController(plugin as never, { requestSaveState() {} } as never);
  controllers.push(controller);
  const root = document.createElement("div");
  return { controller, root, plugin, files, store };
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
});
