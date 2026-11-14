// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { EditorGateway } from "../src/infra/EditorGateway";
import { MarkdownView, TFile, editorInfoField } from "./support/obsidian";
import { MIME_SLIPSTREAM } from "../src/constants";

const mounted: EditorView[] = [];
afterEach(() => { mounted.splice(0).forEach((cm) => cm.destroy()); document.body.replaceChildren(); });
function fixture(behavior: "replace" | "append" = "replace", acceptsDrag?: (token?: string) => boolean) {
  const leaves: any[] = []; const files: TFile[] = [];
  const app = { workspace: { getLeavesOfType: () => leaves, revealLeaf: vi.fn() }, vault: { getAbstractFileByPath: (path: string) => files.find((file) => file.path === path), read: vi.fn() } };
  const gateway = new EditorGateway(app as never, () => behavior, acceptsDrag);
  const add = (text = "Draft text", file = new TFile("Draft.md")) => {
    if (!files.includes(file)) files.push(file);
    const parent = document.createElement("div"); document.body.appendChild(parent);
    let cm!: EditorView;
    const editor = { getValue: () => cm.state.doc.toString(), focus: () => cm.focus() };
    const md = new MarkdownView(file, editor, parent); leaves.push({ view: md });
    cm = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [history(), EditorState.allowMultipleSelections.of(true), editorInfoField.init(() => md), gateway.extension()] }) });
    mounted.push(cm);
    return { cm, md, file, editor, id: gateway.editorId(editor as never)! };
  };
  return { gateway, add, leaves, files };
}
describe("EditorGateway", () => {
  it("keeps target binding when a different file gains focus", () => {
    const f = fixture(); const a = f.add(); const binding = f.gateway.bind(a.id); const source = f.add("Source", new TFile("Source.md"));
    source.cm.focus();
    expect(f.gateway.ticket(binding).editorId).toBe(a.id);
    f.gateway.commit(f.gateway.ticket(binding), "Citation"); expect(source.editor.getValue()).toBe("Source");
  });
  it.each(["replace", "append"] as const)("honors %s for a selected range in a single transaction", (behavior) => {
    const f = fixture(behavior); const target = f.add("abc SELECT xyz");
    target.cm.dispatch({ selection: { anchor: 4, head: 10 } });
    const binding = f.gateway.bind(target.id); const receipt = f.gateway.commit(f.gateway.ticket(binding), "Citation");
    expect(target.editor.getValue()).toBe(behavior === "replace" ? "abc \n\nCitation\n\n xyz" : "abc SELECT\n\nCitation\n\n xyz");
    expect(receipt.range.to - receipt.range.from).toBe(receipt.text.length);
    expect(undo(target.cm)).toBe(true); expect(target.editor.getValue()).toBe("abc SELECT xyz");
  });
  it("isolates citation undo from manual input before and after it", () => {
    const f = fixture(); const target = f.add("");
    target.cm.dispatch({ changes: { from: 0, insert: "Before" }, selection: { anchor: 6 }, annotations: Transaction.userEvent.of("input.type") });
    const binding = f.gateway.bind(target.id); f.gateway.commit(f.gateway.ticket(binding), "Quote");
    const citationState = target.editor.getValue();
    target.cm.dispatch({ changes: { from: target.cm.state.doc.length, insert: "After" }, annotations: Transaction.userEvent.of("input.type") });
    undo(target.cm); expect(target.editor.getValue()).toBe(citationState);
    undo(target.cm); expect(target.editor.getValue()).toBe("Before");
    redo(target.cm); expect(target.editor.getValue()).toBe(citationState);
  });
  it("invalidates tickets after document edits even if content is later changed back", () => {
    const f = fixture(); const target = f.add(); const binding = f.gateway.bind(target.id); const ticket = f.gateway.ticket(binding);
    target.cm.dispatch({ changes: { from: 0, insert: "x" } }); target.cm.dispatch({ changes: { from: 0, to: 1, insert: "" } });
    expect(() => f.gateway.commit(ticket, "Quote")).toThrow("TARGET_STALE");
    target.cm.focus(); target.cm.dispatch({ selection: { anchor: 2 } }); expect(f.gateway.ticket(binding).range.from).toBe(2);
  });
  it("rejects closed, reused, read-only and multi-selection editors", () => {
    const f = fixture(); const target = f.add(); const ticket = f.gateway.ticket(f.gateway.bind(target.id));
    target.md.mode = "preview"; expect(() => f.gateway.commit(ticket, "Quote")).toThrow("TARGET_READONLY"); target.md.mode = "source";
    target.cm.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(4)]) });
    expect(() => f.gateway.commit(ticket, "Quote")).toThrow("TARGET_MULTIPLE_SELECTIONS");
    f.leaves.length = 0; expect(() => f.gateway.commit(ticket, "Quote")).toThrow();
    target.cm.destroy(); expect(() => f.gateway.validate(ticket)).toThrow("TARGET_MISSING"); mounted.splice(mounted.indexOf(target.cm), 1);
  });
  it("a rebind invalidates a pending operation’s generation", () => {
    const f = fixture(); const target = f.add(); const binding = f.gateway.bind(target.id); const ticket = f.gateway.ticket(binding);
    f.gateway.bind(target.id, binding); expect(() => f.gateway.commit(ticket, "Quote")).toThrow("OPERATION_CANCELLED");
  });
  it("captures the actual receiving editor and position, without rebinding the click target", () => {
    const f = fixture(); const a = f.add(); const b = f.add("Another draft", new TFile("Other.md")); const binding = f.gateway.bind(a.id);
    const drop = vi.fn(); f.gateway.onDrop = drop;
    vi.spyOn(b.cm, "posAtCoords").mockReturnValue(3);
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: 10 }, clientY: { value: 20 }, dataTransfer: { value: { types: [MIME_SLIPSTREAM], getData: () => "temporary-token" } } });
    b.cm.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(drop.mock.calls[0][1]).toMatchObject({ editorId: b.id, range: { from: 3, to: 3 } });
    expect(f.gateway.ticket(binding).editorId).toBe(a.id);
  });
  it("rejects a drop with unmappable coordinates instead of using the old cursor", () => {
    const f = fixture(); const target = f.add(); const drop = vi.fn(); f.gateway.onDrop = drop; vi.spyOn(target.cm, "posAtCoords").mockReturnValue(null);
    const event = new Event("drop", { bubbles: true, cancelable: true }); Object.defineProperty(event, "dataTransfer", { value: { types: [MIME_SLIPSTREAM], getData: () => "token" } });
    target.cm.contentDOM.dispatchEvent(event); expect(drop.mock.calls[0][2]?.code).toBe("DROP_POSITION_UNAVAILABLE");
  });
  it("detects successful and uncertain effects even when dispatch throws", () => {
    const f = fixture(); const target = f.add(); const ticket = f.gateway.ticket(f.gateway.bind(target.id)); const original = target.cm.dispatch.bind(target.cm);
    vi.spyOn(target.cm, "dispatch").mockImplementationOnce((transaction: any) => { original(transaction); throw new Error("Host failed after accepting"); });
    expect(f.gateway.commit(ticket, "Quote").text).toContain("Quote");
    const next = f.gateway.ticket(f.gateway.bind(target.id));
    vi.spyOn(target.cm, "dispatch").mockImplementationOnce(() => { original({ changes: { from: 0, insert: "Unexpected" } }); throw new Error("Host mutated differently"); });
    expect(() => f.gateway.commit(next, "Again")).toThrow("COMMIT_STATE_UNCERTAIN");
  });
  it("uses unsaved editor content for source validation and blocks conflicting source buffers", async () => {
    const f = fixture(); const target = f.add("Unsaved draft"); const ref = f.gateway.fileRef(target.file as never);
    expect(await f.gateway.readSource(ref)).toBe("Unsaved draft"); f.add("Conflicting version", target.file);
    await expect(f.gateway.readSource(ref)).rejects.toThrow("SOURCE_AMBIGUOUS");
  });
  it.each(["replace", "append"] as const)("applies %s only when the drop is inside the selected range", (behavior) => {
    const f = fixture(behavior); const target = f.add("abcdefghij");
    target.cm.dispatch({ selection: { anchor: 2, head: 5 } });
    expect(f.gateway.capture(target.id, 0, 3).range).toEqual(behavior === "replace" ? { from: 2, to: 5 } : { from: 5, to: 5 });
    expect(f.gateway.capture(target.id, 0, 8).range).toEqual({ from: 8, to: 8 });
  });

  it("retains inline placement for the single-line body-and-source format", () => {
    const f = fixture(); const target = f.add("Before SELECT After");
    target.cm.dispatch({ selection: { anchor: 7, head: 13 } });
    const ticket = f.gateway.ticket(f.gateway.bind(target.id));
    f.gateway.commit(ticket, "Body ([[Source.md]])", false);
    expect(target.editor.getValue()).toBe("Before Body ([[Source.md]]) After");
  });

  it("leaves unknown drag tokens alone even when a local drag is active", () => {
    const accepts = vi.fn((token?: string) => !token || token === "local-token");
    const f = fixture("replace", accepts); const target = f.add(); const drop = vi.fn(); f.gateway.onDrop = drop;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: [MIME_SLIPSTREAM], getData: (type: string) => type === MIME_SLIPSTREAM ? "unknown-token" : "" } });
    target.cm.contentDOM.dispatchEvent(event);
    expect(accepts).toHaveBeenCalledWith("unknown-token"); expect(drop).not.toHaveBeenCalled();
  });
  it("reports source editor write failures as anchor failures", () => {
    const f = fixture(); const source = f.add("Source paragraph"); const ref = f.gateway.fileRef(source.file as never);
    vi.spyOn(source.cm, "dispatch").mockImplementationOnce(() => { throw new Error("Write failed"); });
    expect(() => f.gateway.writeSource(ref, "Source paragraph", { from: 16, to: 16 }, " ^id")).toThrow("ANCHOR_WRITE_FAILED");
  });

});
