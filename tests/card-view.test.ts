// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { CardView } from "../src/view/CardView";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { MIME_SLIPSTREAM } from "../src/constants";
import type { DragPayload } from "../src/domain/types";
import { installObsidianDom } from "./support/dom";

installObsidianDom();
beforeEach(() => { window.getSelection()?.removeAllRanges(); });
afterEach(() => { document.body.replaceChildren(); });

function fixture(source: string, density: "snippet" | "compact" = "snippet", collapsed = false) {
  const readSource = vi.fn(async () => source);
  const renderUnit = vi.fn(async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; });
  const view = new CardView({
    plugin: {
      settings: { ...DEFAULT_SETTINGS },
      app: { metadataCache: { getFileCache: () => null } },
      renderService: { renderUnit }, logger: { error: vi.fn() },
    } as never,
    card: { file: new TFile("Note.md"), path: "Note.md", title: "Note", wordCount: 0 } as never,
    density, collapsed, pinned: false,
    host: { readSource, toggleCollapse() {}, togglePin() {}, dismiss() {}, copy() {} },
  });
  document.body.appendChild(view.el);
  return { view, readSource, renderUnit };
}

function drag(view: CardView, selector: string): DragPayload {
  const block = view.el.querySelector(selector)!.closest(".slipstream-block")!;
  block.dispatchEvent(new Event("mouseenter"));
  const values = new Map<string, string>();
  const event = new Event("dragstart", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => values.set(type, value) } });
  view.el.querySelector(".slipstream-drag-handle")!.dispatchEvent(event);
  return JSON.parse(values.get(MIME_SLIPSTREAM)!);
}

describe("CardView", () => {
  it("drags a formatted excerpt's actual paragraph instead of the heading", async () => {
    const f = fixture("# Heading\n\nFirst **bold** paragraph.");
    await f.view.ensureRendered();
    expect(drag(f.view, ".slipstream-excerpt")).toMatchObject({
      startLine: 2, endLine: 3, content: "First **bold** paragraph.",
      sourceContent: "First **bold** paragraph.", blockType: "paragraph",
    });
    f.view.destroy();
  });

  it("keeps the complete multi-line callout range and type", async () => {
    const callout = "> [!note] Summary\n> Evidence one.\n> Evidence two.";
    const f = fixture("# Heading\n\nParagraph.\n\n" + callout);
    await f.view.ensureRendered();
    expect(drag(f.view, ".slipstream-callout")).toMatchObject({
      startLine: 4, endLine: 7, content: callout, sourceContent: callout, blockType: "callout",
    });
    f.view.destroy();
  });

  it("locates a highlight even when its text appeared earlier without highlighting", async () => {
    const f = fixture("# Heading\n\nRepeated text.\n\n==Repeated text.==");
    await f.view.ensureRendered();
    expect(drag(f.view, ".slipstream-highlight")).toMatchObject({ startLine: 4, content: "==Repeated text.==" });
    f.view.destroy();
  });

  it("preserves raw source independently of text selected from the rendered excerpt", async () => {
    const f = fixture("First **bold** paragraph.");
    await f.view.ensureRendered();
    const text = f.view.el.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    window.getSelection()!.addRange(range);
    expect(drag(f.view, ".slipstream-excerpt")).toMatchObject({
      mode: "selection", content: "bold", sourceContent: "First **bold** paragraph.",
    });
    f.view.destroy();
  });

  it("loads a compact card only after it is expanded", async () => {
    const f = fixture("Full body", "compact", true);
    await f.view.ensureRendered();
    expect(f.readSource).not.toHaveBeenCalled();
    expect(f.view.el.querySelector(".slipstream-card-meta")!.textContent).toBe("");
    f.view.setCollapsed(false);
    await vi.waitFor(() => expect(f.view.el.textContent).toContain("Full body"));
    expect(f.readSource).toHaveBeenCalledTimes(1);
    f.view.destroy();
  });

  it("does not assign a single block snapshot to a selection crossing blocks", async () => {
    const f = fixture("First paragraph.\n\n> [!note] Summary\n> Evidence.");
    await f.view.ensureRendered();
    const range = document.createRange();
    range.setStart(f.view.el.querySelector(".slipstream-excerpt")!.firstChild!, 0);
    range.setEnd(f.view.el.querySelector(".slipstream-callout")!.firstChild!, 7);
    window.getSelection()!.addRange(range);
    const payload = drag(f.view, ".slipstream-callout");
    expect(payload.mode).toBe("selection");
    expect(payload.sourceContent).toBeUndefined();
    f.view.destroy();
  });
});
