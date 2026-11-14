// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardView } from "../src/view/CardView";
import { MIME_SLIPSTREAM } from "../src/constants";
import type { CitationIntent } from "../src/domain/citationTypes";
import { installObsidianDom } from "./support/dom";
import { citationFixture } from "./support/citations";

installObsidianDom();
const views: CardView[] = [];
beforeEach(() => { window.getSelection()?.removeAllRanges(); });
afterEach(() => { views.forEach((view) => view.destroy()); views.length = 0; document.body.replaceChildren(); });

function fixture(source: string, density: "snippet" | "compact" | "full" = "snippet", collapsed = false) {
  const f = citationFixture(source);
  const execute = vi.fn(async (intent: CitationIntent) => ({ operationId: intent.operationId, status: "success", sourceAnchor: "unchanged", effect: intent.action === "copy" ? "copied" : "inserted", precision: "fragment", recording: "disabled" }));
  const readSource = vi.fn(async () => source);
  const renderUnit = vi.fn(async (el: HTMLElement, unit: { content: string }) => { el.textContent = unit.content; });
  const feedback = document.createElement("div");
  const plugin = { settings: f.store.data.settings, store: f.store, app: f.app, editors: f.editors, blockIds: f.sources,
    renderService: { renderUnit }, logger: { error: vi.fn() }, cite: { execute }, dragTokens: new Map<string, (...args: any[]) => void>(), citationBusy: 0 };
  let binding: any;
  const view = new CardView({ plugin: plugin as never,
    card: { file: f.sourceFile, path: f.sourceFile.path, title: "Note", wordCount: 0 } as never,
    density, collapsed, pinned: false, host: { readSource, toggleCollapse() {}, togglePin() {}, dismiss() {},
      getTarget: () => binding, getCitationFeedback: () => feedback, reselectSource() {} } });
  document.body.append(view.el, feedback); views.push(view);
  return { ...f, plugin, view, readSource, renderUnit, execute, feedback, setBinding: (value: any) => { binding = value; } };
}
function drag(f: ReturnType<typeof fixture>, selector: string, collapseBeforeDrag = false): CitationIntent | undefined {
  const block = f.view.el.querySelector(selector)!;
  block.dispatchEvent(new Event("mouseenter"));
  if (collapseBeforeDrag) {
    f.view.el.querySelector(".slipstream-drag-handle")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange"));
  }
  const values = new Map<string, string>();
  const event = new Event("dragstart", { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => values.set(type, value) } });
  f.view.el.querySelector(".slipstream-drag-handle")!.dispatchEvent(event);
  const token = values.get(MIME_SLIPSTREAM);
  if (!token) return;
  expect(token).not.toContain("Original"); expect(() => JSON.parse(token)).toThrow();
  f.plugin.dragTokens.get(token)!(f.ticket());
  return f.execute.mock.calls.at(-1)![0];
}

describe("CardView", () => {
  it("cites exactly the displayed excerpt, with its raw paragraph separately frozen", async () => {
    const f = fixture("# Heading\n\nFirst **bold** paragraph."); await f.view.ensureRendered();
    const intent = drag(f, ".slipstream-excerpt")!;
    expect(intent).toMatchObject({ mode: "fragment", content: "First bold paragraph." });
    expect(intent.spans[0]).toMatchObject({ rawText: "First **bold** paragraph.", kind: "paragraph", rawRange: { from: 11 } });
  });
  it("keeps the displayed multiline callout and the complete source span", async () => {
    const callout = "> [!note] Summary\n> Evidence one.\n> Evidence two.";
    const f = fixture("Paragraph.\n\n" + callout); await f.view.ensureRendered();
    expect(drag(f, ".slipstream-callout")).toMatchObject({ content: "Summary\nEvidence one.\nEvidence two.", mode: "fragment", spans: [{ rawText: callout, kind: "callout" }] });
  });
  it("uses the second highlit instance rather than an earlier matching sentence", async () => {
    const f = fixture("Repeated.\n\n==Repeated.==\n\n==Repeated.=="); await f.view.ensureRendered();
    const highlights = f.view.el.querySelectorAll(".slipstream-highlight");
    highlights[1].classList.add("second-highlight");
    const intent = drag(f, ".second-highlight")!;
    expect(intent.content).toBe("Repeated."); expect(intent.spans[0].rawRange.from).toBe(26);
  });
  it("freezes the selection across button focus and preserves its whitespace", async () => {
    const f = fixture("First **bold** paragraph."); await f.view.ensureRendered();
    const text = f.view.el.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange(); range.setStart(text, 5); range.setEnd(text, 11);
    window.getSelection()!.addRange(range); document.dispatchEvent(new Event("selectionchange"));
    const copy = f.view.el.querySelector(".slipstream-citation-actions button:nth-child(2)") as HTMLButtonElement;
    copy.focus(); window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event("selectionchange")); copy.click();
    expect(f.execute.mock.calls[0][0]).toMatchObject({ action: "copy", mode: "selection", content: " bold " });
  });
  it("loads compact cards only after expansion, and header copy never guesses a first block", async () => {
    const f = fixture("Full body", "compact", true); await f.view.ensureRendered();
    expect(f.readSource).not.toHaveBeenCalled();
    (f.view.el.querySelector('[aria-label="Copy citation"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(f.view.el.textContent).toContain("Full body"));
    expect(f.execute).not.toHaveBeenCalled(); expect(f.feedback.textContent).toContain("select");
  });
  it("retains all selected blocks rather than truncating a cross-block selection", async () => {
    const f = fixture("First paragraph.\n\n> [!note] Summary\n> Evidence."); await f.view.ensureRendered();
    const range = document.createRange(); range.setStart(f.view.el.querySelector(".slipstream-excerpt")!.firstChild!, 6);
    range.setEnd(f.view.el.querySelector(".slipstream-callout")!.firstChild!, 7); window.getSelection()!.addRange(range);
    const intent = drag(f, ".slipstream-callout")!;
    expect(intent.content).toBe("paragraph.\n\nSummary"); expect(intent.spans).toHaveLength(2);
  });
  it("rejects selection crossing cards rather than falling back to a whole block", async () => {
    const f = fixture("First"); const g = fixture("Second"); await f.view.ensureRendered(); await g.view.ensureRendered();
    const range = document.createRange(); range.setStart(f.view.el.querySelector(".slipstream-excerpt")!.firstChild!, 0);
    range.setEnd(g.view.el.querySelector(".slipstream-excerpt")!.firstChild!, 3); window.getSelection()!.addRange(range);
    expect(drag(f, ".slipstream-excerpt")).toBeUndefined(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not refill a destroyed card after an asynchronous read finishes", async () => {
    const f = fixture("Original"); let finish!: (text: string) => void;
    f.readSource.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.view.ensureRendered(); f.view.destroy(); finish("Late content"); await pending;
    expect(f.view.el.textContent).toBe("");
  });
  it("keeps a selected fragment when grabbing the drag handle collapses browser selection", async () => {
    const f = fixture("First bold paragraph."); await f.view.ensureRendered();
    const node = f.view.el.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange(); range.setStart(node, 6); range.setEnd(node, 10); window.getSelection()!.addRange(range);
    expect(drag(f, ".slipstream-excerpt", true)).toMatchObject({ content: "bold", mode: "selection" });
  });
  it("uses the frozen selection when header copy takes focus", async () => {
    const f = fixture("First bold paragraph."); await f.view.ensureRendered();
    const node = f.view.el.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 5); window.getSelection()!.addRange(range);
    const button = f.view.el.querySelector('[aria-label="Copy citation"]') as HTMLButtonElement;
    button.dispatchEvent(new Event("pointerdown")); button.focus(); window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange")); button.click();
    expect(f.execute.mock.calls[0][0]).toMatchObject({ content: "First", mode: "selection", action: "copy" });
  });
  it("does not fall back to a whole paragraph when only whitespace is selected", async () => {
    const f = fixture(" A paragraph"); await f.view.ensureRendered();
    const node = f.view.el.querySelector(".slipstream-excerpt")!.firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 1); window.getSelection()!.addRange(range);
    expect(drag(f, ".slipstream-excerpt")).toBeUndefined(); expect(f.execute).not.toHaveBeenCalled();
  });

  it("updates the visible citation target when binding changes", async () => {
    const f = fixture("Source paragraph"); await f.view.ensureRendered();
    f.setBinding({ fileRef: "a" });
    (f.view.el.querySelector(".slipstream-paragraph-action") as HTMLButtonElement).click();
    expect(f.view.el.querySelector(".slipstream-citation-actions")?.textContent).toContain("Drafts/A.md");
    f.setBinding({ fileRef: "b" });
    f.view.refreshCitationContext();
    expect(f.view.el.querySelector(".slipstream-citation-actions")?.textContent).toContain("Drafts/B.md");
    expect(f.view.el.querySelector(".slipstream-citation-actions")?.textContent).not.toContain("Drafts/A.md");
  });
  it("cancels every uncommitted operation when its source card is destroyed", async () => {
    const f = fixture("Source paragraph"); await f.view.ensureRendered();
    f.execute.mockImplementation(() => new Promise(() => {}));
    drag(f, ".slipstream-excerpt"); drag(f, ".slipstream-excerpt");
    const signals = f.execute.mock.calls.map((call) => call[1].signal as AbortSignal);
    expect(signals.length).toBeGreaterThan(0);
    f.view.destroy();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("cancels a retry as well as a newer action when its card closes", async () => {
    const f = fixture("Source paragraph"); await f.view.ensureRendered();
    f.execute.mockResolvedValueOnce({ operationId: "failed", status: "failed", sourceAnchor: "unchanged", effect: "none", precision: "file", recording: "not-attempted", code: "CLIPBOARD_DENIED" });
    (f.view.el.querySelector(".slipstream-paragraph-action") as HTMLButtonElement).click();
    (f.view.el.querySelector(".slipstream-citation-actions button:nth-child(2)") as HTMLButtonElement).click();
    await vi.waitFor(() => expect([...f.feedback.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true));
    f.execute.mockImplementation(() => new Promise(() => {}));
    [...f.feedback.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
    (f.view.el.querySelector(".slipstream-citation-actions button:nth-child(2)") as HTMLButtonElement).click();
    expect(f.execute).toHaveBeenCalledTimes(3);
    const signals = f.execute.mock.calls.map((call) => call[1].signal as AbortSignal);
    f.view.destroy(); expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

});
