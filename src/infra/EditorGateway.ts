import { MarkdownView, editorInfoField } from "obsidian";
import type { App, Editor, TFile } from "obsidian";
import { Prec, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { CitationError, validRange } from "../domain/citationTypes";
import type { CommitReceipt, TargetBinding, TargetTicket, TextRange } from "../domain/citationTypes";
import { MIME_SLIPSTREAM } from "../constants";

interface RegisteredEditor {
  id: string;
  cm: EditorView;
  file: TFile;
  editor: Editor;
  view: MarkdownView;
  revision: number;
}
export interface TargetOption { editorId: string; fileRef: string; path: string; label: string }

export function insertionPlan(text: string, range: TextRange, citation: string, block = true): { range: TextRange; text: string } {
  if (!block) return { range, text: citation };
  const before = text.slice(0, range.from);
  const after = text.slice(range.to);
  const prefix = before && !before.endsWith("\n\n") ? before.endsWith("\n") ? "\n" : "\n\n" : "";
  const suffix = after && !after.startsWith("\n\n") ? after.startsWith("\n") ? "\n" : "\n\n" : "";
  return { range, text: prefix + citation + suffix };
}

/** All editor access goes through public CM6 extensions and the registered Markdown view. */
export class EditorGateway {
  private ids = new WeakMap<TFile, string>();
  private files = new Map<string, TFile>();
  private entries = new Map<string, RegisteredEditor>();
  private cms = new WeakMap<EditorView, RegisteredEditor>();
  private bindings = new Set<TargetBinding>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  onDrop?: (token: string, ticket?: TargetTicket, error?: CitationError) => void;
  constructor(private app: App, private selectionBehavior: () => "replace" | "append", private acceptsDrag: (token?: string) => boolean = () => true) {}

  fileRef(file: TFile): string {
    let id = this.ids.get(file);
    if (!id) { id = `file-${++this.sequence}`; this.ids.set(file, id); this.files.set(id, file); }
    return id;
  }
  file(ref: string): TFile {
    const file = this.files.get(ref);
    if (!file || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new CitationError("SOURCE_MISSING");
    return file;
  }
  path(ref: string): string { return this.file(ref).path; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { this.listeners.forEach((listener) => listener()); }

  extension(): Extension {
    return [ViewPlugin.define((cm) => {
      this.register(cm);
      return { update: (update: ViewUpdate) => { this.update(update); }, destroy: () => { this.remove(cm); } };
    }), Prec.highest(EditorView.domEventHandlers({
      dragover: (event, cm) => {
        if (event.defaultPrevented || !event.dataTransfer?.types.includes(MIME_SLIPSTREAM) || !this.cms.has(cm) || !this.acceptsDrag()) return false;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        return true;
      },
      drop: (event, cm) => {
        if (event.defaultPrevented || !event.dataTransfer?.types.includes(MIME_SLIPSTREAM)) return false;
        const token = event.dataTransfer.getData(MIME_SLIPSTREAM);
        if (!token || !this.cms.has(cm) || !this.acceptsDrag(token)) return false;
        event.preventDefault(); event.stopPropagation();
        try {
          const entry = this.cms.get(cm)!;
          const offset = cm.posAtCoords({ x: event.clientX, y: event.clientY });
          if (offset === null) throw new CitationError("DROP_POSITION_UNAVAILABLE");
          this.onDrop?.(token, this.capture(entry.id, 0, offset));
        } catch (error) { this.onDrop?.(token, undefined, error instanceof CitationError ? error : new CitationError("DROP_POSITION_UNAVAILABLE")); }
        return true;
      },
    }))];
  }
  private register(cm: EditorView): void {
    const info = cm.state.field(editorInfoField, false);
    if (!(info instanceof MarkdownView) || !info.file || !info.editor || cm.dom.ownerDocument !== document) return;
    const entry: RegisteredEditor = { id: `editor-${++this.sequence}`, cm, file: info.file, editor: info.editor, view: info, revision: 0 };
    this.entries.set(entry.id, entry); this.cms.set(cm, entry); this.fileRef(entry.file); this.notify();
  }
  private update(update: ViewUpdate): void {
    let entry = this.cms.get(update.view);
    const info = update.state.field(editorInfoField, false);
    if (entry && (!(info instanceof MarkdownView) || info.file !== entry.file || info.editor !== entry.editor)) { this.remove(update.view); entry = undefined; }
    if (!entry) { this.register(update.view); entry = this.cms.get(update.view); }
    if (!entry) return;
    if (update.docChanged) entry.revision++;
    if ((update.selectionSet || update.focusChanged) && update.view.hasFocus) {
      for (const binding of this.bindings) if (binding.editorId === entry.id) {
        try { binding.ticket = this.capture(entry.id, binding.generation); } catch { binding.ticket = undefined; }
      }
    }
    if (update.docChanged || update.selectionSet || update.focusChanged) this.notify();
  }
  private remove(cm: EditorView): void {
    const entry = this.cms.get(cm);
    if (entry) this.entries.delete(entry.id);
    this.cms.delete(cm); this.notify();
  }
  private editable(entry: RegisteredEditor): boolean {
    return entry.cm.dom.isConnected && entry.view.file === entry.file && entry.view.getMode() === "source" &&
      !entry.cm.state.readOnly && entry.cm.state.facet(EditorView.editable) &&
      this.app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === entry.view) &&
      this.app.vault.getAbstractFileByPath(entry.file.path) === entry.file;
  }
  options(): TargetOption[] {
    return [...this.entries.values()].filter((entry) => this.editable(entry)).map((entry, index) => ({
      editorId: entry.id, fileRef: this.fileRef(entry.file), path: entry.file.path, label: `${entry.file.path} · ${index + 1}`,
    }));
  }
  editorId(editor: Editor): string | undefined { return [...this.entries.values()].find((entry) => entry.editor === editor && this.editable(entry))?.id; }
  bind(editorId: string, previous?: TargetBinding): TargetBinding {
    const entry = this.entries.get(editorId);
    if (!entry) throw new CitationError("TARGET_MISSING");
    const binding: TargetBinding = { path: entry.file.path, fileRef: this.fileRef(entry.file), editorId, generation: (previous?.generation ?? 0) + 1 };
    binding.ticket = this.capture(editorId, binding.generation);
    if (previous) this.release(previous);
    this.bindings.add(binding); this.notify();
    return binding;
  }
  release(binding: TargetBinding): void { binding.generation++; binding.ticket = undefined; this.bindings.delete(binding); }
  ticket(binding?: TargetBinding): TargetTicket {
    if (!binding) throw new CitationError("TARGET_MISSING");
    if (!binding.ticket) {
      const entry = this.entries.get(binding.editorId);
      if (entry && entry.cm.state.selection.ranges.length !== 1) throw new CitationError("TARGET_MULTIPLE_SELECTIONS");
      throw new CitationError("TARGET_STALE");
    }
    this.validate(binding.ticket);
    binding.path = this.path(binding.fileRef);
    return { ...binding.ticket, range: { ...binding.ticket.range } };
  }
  capture(editorId: string, generation: number, dropOffset?: number): TargetTicket {
    const entry = this.entries.get(editorId);
    if (!entry) throw new CitationError("TARGET_MISSING");
    if (!this.editable(entry)) throw new CitationError("TARGET_READONLY");
    if (entry.cm.state.selection.ranges.length !== 1) throw new CitationError("TARGET_MULTIPLE_SELECTIONS");
    const selected = entry.cm.state.selection.main;
    let range: TextRange = { from: selected.from, to: selected.to };
    if (dropOffset !== undefined && (dropOffset < range.from || dropOffset > range.to)) range = { from: dropOffset, to: dropOffset };
    if (this.selectionBehavior() === "append") range = { from: range.to, to: range.to };
    return { fileRef: this.fileRef(entry.file), editorId, revision: entry.revision, range,
      baselineText: entry.editor.getValue(), bindingGeneration: generation };
  }
  validate(ticket: TargetTicket): void {
    const entry = this.entries.get(ticket.editorId);
    if (!entry || this.fileRef(entry.file) !== ticket.fileRef || this.app.vault.getAbstractFileByPath(entry.file.path) !== entry.file) throw new CitationError("TARGET_MISSING");
    if (!this.editable(entry)) throw new CitationError("TARGET_READONLY");
    if (ticket.bindingGeneration !== 0 && ![...this.bindings].some((b) => b.editorId === entry.id && b.generation === ticket.bindingGeneration)) throw new CitationError("OPERATION_CANCELLED");
    if (entry.cm.state.selection.ranges.length !== 1) throw new CitationError("TARGET_MULTIPLE_SELECTIONS");
    if (entry.revision !== ticket.revision || entry.editor.getValue() !== ticket.baselineText || !validRange(ticket.range, ticket.baselineText.length)) throw new CitationError("TARGET_STALE");
  }
  commit(ticket: TargetTicket, citation: string, block = true): CommitReceipt {
    this.validate(ticket);
    const entry = this.entries.get(ticket.editorId)!;
    const plan = insertionPlan(ticket.baselineText, ticket.range, citation.replace(/\r\n/g, "\n"), block);
    this.dispatch(entry, ticket.baselineText, plan.range, plan.text);
    for (const binding of this.bindings) if (binding.editorId === entry.id) {
      try { binding.ticket = this.capture(entry.id, binding.generation); } catch { binding.ticket = undefined; }
    }
    this.notify();
    return { targetPath: entry.file.path, range: { from: plan.range.from, to: plan.range.from + plan.text.length }, text: plan.text,
      before: ticket.baselineText.slice(Math.max(0, plan.range.from - 80), plan.range.from), after: ticket.baselineText.slice(plan.range.to, plan.range.to + 80) };
  }
  private dispatch(entry: RegisteredEditor, baseline: string, range: TextRange, text: string): void {
    const expected = baseline.slice(0, range.from) + text + baseline.slice(range.to);
    try {
      entry.cm.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length },
        annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.slipstream")] });
    } catch {
      const actual = entry.editor.getValue();
      if (actual === expected) return;
      throw new CitationError(actual === baseline ? "TARGET_COMMIT_FAILED" : "COMMIT_STATE_UNCERTAIN");
    }
    if (entry.editor.getValue() !== expected) throw new CitationError("COMMIT_STATE_UNCERTAIN");
  }
  async copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); } catch { throw new CitationError("CLIPBOARD_DENIED"); }
  }
  async readSource(ref: string): Promise<string> {
    const file = this.file(ref);
    const views = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file && view.getMode() === "source");
    const buffers = views.map((view) => view.editor.getValue());
    if (new Set(buffers).size > 1) throw new CitationError("SOURCE_AMBIGUOUS");
    if (buffers.length) return buffers[0];
    try { return await this.app.vault.read(file); } catch { throw new CitationError("SOURCE_READ_FAILED"); }
  }
  writeSource(ref: string, baseline: string, range: TextRange, text: string): boolean {
    const file = this.file(ref);
    const views = this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view).filter((view): view is MarkdownView => view instanceof MarkdownView && view.file === file && view.getMode() === "source");
    if (!views.length) return false;
    if (views.some((view) => view.editor.getValue() !== baseline)) throw new CitationError("SOURCE_AMBIGUOUS");
    if (views.length !== 1) throw new CitationError("SOURCE_AMBIGUOUS");
    const entry = [...this.entries.values()].find((item) => item.view === views[0]);
    if (!entry || !this.editable(entry)) throw new CitationError("ANCHOR_WRITE_FAILED");
    try { this.dispatch(entry, baseline, range, text); }
    catch (error) {
      if (error instanceof CitationError && error.code === "TARGET_COMMIT_FAILED") throw new CitationError("ANCHOR_WRITE_FAILED");
      throw error;
    }
    return true;
  }
  show(binding: TargetBinding): void {
    const entry = this.entries.get(binding.editorId);
    const leaf = entry && this.app.workspace.getLeavesOfType("markdown").find((item) => item.view === entry.view);
    if (!leaf) throw new CitationError("TARGET_MISSING");
    void this.app.workspace.revealLeaf(leaf); entry.editor.focus();
  }
}
