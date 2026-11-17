// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusResults } from "../src/view/FocusResults";
import type { FocusResult, SearchRun } from "../src/domain/FocusSearch";
import { installObsidianDom } from "./support/dom";

installObsidianDom();
const views: FocusResults[] = [];
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const view of views) { view.destroy(); view.el.remove(); }
  views.length = 0;
});

function preview(text: string) {
  return { text, sourceOffsets: Array.from({ length: text.length }, (_v, index) => index), truncated: false };
}

function result(key: string, order: number, occurrences = [preview("needle here")]): FocusResult {
  return {
    key, sourceRef: "ref:a.md", sourceVersion: 0, filePath: "a.md", title: "a", originRange: { from: 0, to: 20 },
    unitRange: { from: 0, to: 20 }, kind: "body", matches: [{ from: 0, to: 6 }], preview: occurrences[0], occurrences, order,
  };
}

function run(results: FocusResult[]): SearchRun {
  return {
    request: { sessionId: "s", scopeRevision: 0, collectionGeneration: 0, query: "needle", kind: "all", includeHidden: false },
    phase: "complete", total: results.length, scanned: results.length, failed: 0, results,
    progress: { total: results.length, scanned: results.length, failed: 0, files: 1, units: results.length, keywords: 1, phase: "complete" },
  };
}

function host() {
  return { cite: vi.fn(), drag: vi.fn(() => "token"), expandSection: vi.fn(), openSource: vi.fn(), targetLabel: () => "" };
}

function createView(h = host()) {
  const view = new FocusResults(h);
  views.push(view);
  return view;
}

function select(start: Node, from: number, end = start, to = from + 3): Selection {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  return selection;
}

describe("FocusResults", () => {
  it("loads the batch containing a later result during navigation", () => {
    const view = createView();
    const results = Array.from({ length: 25 }, (_v, index) => result(`r${index}`, index));
    view.setRun(run(results));
    expect(view.el.querySelectorAll(".slipstream-focus-result")).toHaveLength(20);
    view.focusMatch("r24", 0);
    expect(view.el.querySelectorAll(".slipstream-focus-result")).toHaveLength(25);
    expect(view.el.querySelector('.slipstream-focus-result[data-focus-key="r24"]')).toBeTruthy();
  });

  it("shows the preview window for the selected occurrence", () => {
    const view = createView();
    const two = result("r0", 0, [preview("first needle"), preview("second needle window")]);
    view.setRun(run([two]));
    view.focusMatch("r0", 1);
    expect(view.el.querySelector(".slipstream-focus-preview")?.textContent).toContain("second needle window");
  });

  it("uses the live selection when a cite button is activated without pointerdown", () => {
    const h = host();
    const view = createView(h);
    view.setRun(run([result("r0", 0)]));
    document.body.appendChild(view.el);
    const previewEl = view.el.querySelector(".slipstream-focus-preview")!;
    const textNode = previewEl.querySelector("mark")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    (view.el.querySelector(".slipstream-focus-actions button") as HTMLButtonElement).click();
    expect(h.cite).toHaveBeenCalledWith(expect.objectContaining({ key: "r0" }), "insert", expect.objectContaining({ selection: "needle" }));
  });

  it("clears previous results when a new query starts", () => {
    const view = createView();
    view.setRun(run([result("r0", 0), result("r1", 1)]));
    expect(view.el.querySelectorAll(".slipstream-focus-result")).toHaveLength(2);
    view.setPartial([], "running", 5);
    expect(view.el.querySelectorAll(".slipstream-focus-result")).toHaveLength(0);
  });

  it.each([[0, "insert"], [2, "copy"]] as const)("retains a valid selection after keyboard focus for button %s", (index, action) => {
    const h = host();
    const view = createView(h);
    view.setRun(run([result("r0", 0)]));
    document.body.append(view.el);
    const selection = select(view.el.querySelector("mark")!.firstChild!, 0);
    const button = view.el.querySelectorAll<HTMLButtonElement>(".slipstream-focus-actions button")[index];
    button.focus();
    if (selection.rangeCount) selection.collapseToEnd();
    document.dispatchEvent(new Event("selectionchange"));
    expect(selection.toString()).toBe("");
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    button.click();
    expect(h.cite).toHaveBeenCalledWith(expect.anything(), action, expect.objectContaining({ selection: "nee" }));
  });

  it.each([false, true])("rejects cross-source selections even after focus collapses them (%s)", (collapse) => {
    const h = host();
    const view = createView(h);
    view.setRun(run([result("a", 0), { ...result("b", 1), sourceRef: "ref:b.md", filePath: "b.md" }]));
    document.body.append(view.el);
    const nodes = view.el.querySelectorAll("mark");
    const selection = select(nodes[0].firstChild!, 0, nodes[1].firstChild!, 3);
    const button = view.el.querySelector<HTMLButtonElement>(".slipstream-focus-actions button")!;
    if (collapse) { button.focus(); if (selection.rangeCount) selection.collapseToEnd(); document.dispatchEvent(new Event("selectionchange")); }
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button.click();
    expect(h.cite).toHaveBeenCalledWith(expect.anything(), "insert", expect.objectContaining({ selectionInvalid: true }));
    expect(h.cite.mock.calls[0][2].selection).toBeUndefined();
  });

  it("does not reuse a cached selection after an outside click", () => {
    const h = host();
    const view = createView(h);
    view.setRun(run([result("r0", 0)]));
    document.body.append(view.el);
    const selection = select(view.el.querySelector("mark")!.firstChild!, 0);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    selection.removeAllRanges();
    view.el.querySelector<HTMLButtonElement>(".slipstream-focus-actions button")!.click();
    expect(h.cite.mock.calls[0][2].selection).toBeUndefined();
  });

  it("invalidates a cached selection when a new partial result replaces its DOM", () => {
    const h = host();
    const view = createView(h);
    view.setRun(run([result("r0", 0)]));
    document.body.append(view.el);
    const selection = select(view.el.querySelector("mark")!.firstChild!, 0);
    view.setPartial([result("new", 0)], "running", 2);
    selection.removeAllRanges();
    view.el.querySelector<HTMLButtonElement>(".slipstream-focus-actions button")!.click();
    expect(h.cite.mock.calls[0][2].selection).toBeUndefined();
  });

  it("keeps the current occurrence when existing results are reordered", () => {
    const view = createView();
    const entry = result("a", 0, [preview("first needle"), preview("second needle window")]);
    view.setRun(run([entry, result("b", 1)]));
    view.focusMatch("a", 1);
    view.setRun(run([result("b", 0), entry]), true);
    expect(view.el.querySelector('[data-focus-key="a"] .slipstream-focus-preview')?.textContent).toBe("second needle window");
  });

  it("bounds rendered sources while retaining all results and direct navigation to the last source", () => {
    const view = createView();
    const entries = Array.from({ length: 500 }, (_v, index) => ({ ...result(`r${index}`, index), filePath: `Note-${index}.md` }));
    view.setRun(run(entries));
    expect(view.results()).toHaveLength(500);
    expect(view.el.querySelectorAll(".slipstream-focus-group")).toHaveLength(20);
    expect(view.el.querySelectorAll(".slipstream-focus-result")).toHaveLength(20);
    view.el.querySelector<HTMLButtonElement>(".slipstream-focus-source-pages button")!.click();
    expect(view.el.querySelector(".slipstream-focus-group-title")?.textContent).toBe("Note-20.md");
    view.el.querySelector<HTMLButtonElement>(".slipstream-focus-source-pages button")!.click();
    expect(view.el.querySelector(".slipstream-focus-group-title")?.textContent).toBe("Note-0.md");
    view.focusMatch("r499", 0);
    expect(view.el.querySelectorAll(".slipstream-focus-group")).toHaveLength(20);
    expect(view.el.querySelector('[data-focus-key="r499"]')).toBeTruthy();
    expect(view.el.querySelector('[data-focus-key="r0"]')).toBeNull();
  });
});
