// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { CardStreamController } from "../src/domain/CardStreamController";
import { CitationError } from "../src/domain/citationTypes";
import { BlockIdService } from "../src/infra/BlockIdService";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { installObsidianDom } from "./support/dom";

installObsidianDom();
const controllers: CardStreamController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.destroy();
  controllers.length = 0;
});

function fixture(overrides = {}, paths = ["Sources/Note.md"]) {
  const files = paths.map((path) => new TFile(path));
  const settings = { ...DEFAULT_SETTINGS, virtualScroll: false, ...overrides };
  const read = vi.fn(async () => "Full body");
  const plugin = {
    settings,
    store: { readOnly: false },
    editors: { subscribe: () => () => {}, fileRef: () => "src", readSource: () => read() },
    blockIds: undefined as unknown as BlockIdService,
    dragTokens: new Map(),
    app: { vault: { getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => null } },
    gateway: { getMarkdownFiles: () => files, getFileCache: () => null, read },
    renderService: { renderUnit: async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; } },
    history: { list: () => [] }, logger: { error: vi.fn() },
  };
  plugin.blockIds = new BlockIdService(plugin.app as never, plugin.editors as never);
  const controller = new CardStreamController(plugin as never, { requestSaveState() {} } as never);
  controllers.push(controller);
  const root = document.createElement("div");
  return { controller, root, read, plugin };
}

describe("CardStreamController", () => {
  it("applies configured exclusions as well as per-source exclusions", async () => {
    const f = fixture({ excludeGlobs: "Sources/hidden.md, Other/**" }, [
      "Sources/hidden.md", "Sources/manual.md", "Sources/keep.md",
    ]);
    await f.controller.restore({ source: { kind: "folder", value: "Sources", options: { excludeGlobs: ["Sources/manual.md"] } } });
    await f.controller.mount(f.root);
    expect([...f.root.querySelectorAll(".slipstream-card-title")].map((el) => el.textContent)).toEqual(["keep"]);
  });

  it("uses exclusions when switching sources without explicit source options", async () => {
    const f = fixture({ excludeGlobs: "Sources/**" });
    await f.controller.restore({});
    await f.controller.mount(f.root);
    f.controller.setSource({ kind: "folder", value: "Sources" });
    await vi.waitFor(() => expect(f.root.querySelector(".slipstream-state")?.textContent).toBe("No notes found"));
    expect(f.root.querySelectorAll(".slipstream-card")).toHaveLength(0);
  });

  it("defaults compact cards to collapsed, then persists explicit expansion", async () => {
    const f = fixture();
    await f.controller.restore({ source: { kind: "folder", value: "Sources" }, density: "compact" });
    await f.controller.mount(f.root);
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(1);
    expect(f.read).not.toHaveBeenCalled();
    (f.root.querySelector(".slipstream-card-header") as HTMLElement).click();
    await vi.waitFor(() => expect(f.root.querySelector(".slipstream-card-body")?.textContent).toContain("Full body"));
    const state = f.controller.serializeViewState();
    await f.controller.restore(state);
    await f.controller.mount(f.root);
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(0);
  });

  it("applies compact defaults when switching from another density", async () => {
    const f = fixture();
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } });
    await f.controller.mount(f.root);
    f.controller.setDensity("compact");
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(1);
    f.controller.expandAll();
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(0);
    f.controller.setSort("name");
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(0);
    f.controller.setDensity("full");
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(0);
  });

  it("honors disabling compact's default collapse", async () => {
    const f = fixture({ compactDefaultCollapsed: false });
    await f.controller.restore({ source: { kind: "folder", value: "Sources" }, density: "compact" });
    await f.controller.mount(f.root);
    expect(f.root.querySelectorAll(".slipstream-card.is-collapsed")).toHaveLength(0);
    await vi.waitFor(() => expect(f.root.querySelector(".slipstream-card-body")?.textContent).toContain("Full body"));
  });
  it("refreshes action labels without losing a frozen selection when the target changes", async () => {
    const f = fixture();
    Object.assign(f.plugin.editors, {
      path: (ref: string) => `Drafts/${ref}.md`,
      bind: (editorId: string) => ({ fileRef: editorId, editorId, generation: 1, path: `Drafts/${editorId}.md` }),
      ticket: () => ({ baselineText: "Draft", range: { from: 0, to: 0 } }),
      release() {},
    });
    document.body.appendChild(f.root);
    await f.controller.restore({ source: { kind: "folder", value: "Sources" } }); await f.controller.mount(f.root);
    await vi.waitFor(() => expect(f.root.querySelector(".slipstream-excerpt")).not.toBeNull());
    f.controller.bindTarget("A");
    const node = f.root.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 4); document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(f.root.querySelector(".slipstream-citation-actions")?.textContent).toContain("Drafts/A.md");
    f.controller.bindTarget("B");
    expect(f.root.querySelector(".slipstream-citation-actions")?.textContent).toContain("Drafts/B.md");
    expect(document.getSelection()?.toString()).toBe("Full");
    document.getSelection()?.removeAllRanges(); f.root.remove();
  });
  it("shows the actual binding failure instead of always requesting a single cursor", async () => {
    const f = fixture(); await f.controller.restore({}); await f.controller.mount(f.root);
    Object.assign(f.plugin.editors, { bind: () => { throw new CitationError("TARGET_READONLY"); } });
    f.controller.bindTarget("readonly");
    expect(f.root.querySelector(".slipstream-operation-feedback")?.textContent).toContain("reading/read-only");
  });

});
