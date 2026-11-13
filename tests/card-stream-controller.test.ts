// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { CardStreamController } from "../src/domain/CardStreamController";
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
    app: { vault: { getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => null } },
    gateway: { getMarkdownFiles: () => files, getFileCache: () => null, read },
    renderService: { renderUnit: async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; } },
    history: { list: () => [] }, logger: { error: vi.fn() },
  };
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
});
