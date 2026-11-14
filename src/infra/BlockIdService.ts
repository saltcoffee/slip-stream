import { getFrontMatterInfo } from "obsidian";
import type { App, TFile } from "obsidian";
import { mapBlocks, groupRenderUnits, originOf, standaloneId } from "../domain/BlockMapper";
import { canCreateBlockId, inlineBlockId, stripInlineBlockId } from "../domain/BlockReference";
import { CitationError, validRange } from "../domain/citationTypes";
import type { OriginSpan, SourceSnapshot, TextRange } from "../domain/citationTypes";
import type { EditorGateway } from "./EditorGateway";

interface KnownEdit { before: string; after: string; range: TextRange; text: string }
export interface SourceInspection { text: string; spans: OriginSpan[]; id?: string; canCreate: boolean; heading?: string }
export interface AnchorResult extends SourceInspection { kind: "reused" | "created" | "unavailable"; sourceAfter: string }

export class BlockIdService {
  private queues = new Map<string, Promise<unknown>>();
  private snapshots = new Map<string, Set<WeakRef<SourceSnapshot>>>();
  private resolved = new WeakMap<SourceSnapshot, { text: string; spans: Map<string, OriginSpan> }>();
  constructor(private app: App, private editors: EditorGateway, private onWritten?: (path: string) => void) {}

  capture(file: TFile, text: string, title = file.basename): SourceSnapshot {
    const bodyStart = getFrontMatterInfo(text).contentStart;
    const blocks = mapBlocks(text, bodyStart);
    const units = groupRenderUnits(blocks, text.split("\n"));
    const spans = [...blocks.map(originOf), ...units.filter((unit) => unit.type === "list").map((unit) => {
      const origin = originOf(unit);
      origin.rawText = text.slice(origin.rawRange.from, origin.rawRange.to);
      origin.existingBlockId = standaloneId(text, origin.rawRange.to);
      return origin;
    })];
    for (const span of spans) {
      span.existingBlockId = this.existingId(text, span, file);
      if (span.heading && blocks.filter((block) => block.type === "heading" && block.heading === span.heading).length !== 1) span.heading = undefined;
    }
    const snapshot = { sourceRef: this.editors.fileRef(file), title, text, bodyStart, spans };
    const refs = this.snapshots.get(snapshot.sourceRef) ?? new Set<WeakRef<SourceSnapshot>>();
    for (const ref of refs) if (!ref.deref()) refs.delete(ref);
    refs.add(new WeakRef(snapshot)); this.snapshots.set(snapshot.sourceRef, refs);
    this.resolved.set(snapshot, { text, spans: new Map(spans.map((span) => [span.blockKey, span])) });
    return snapshot;
  }
  async inspect(snapshot: SourceSnapshot, selected: readonly OriginSpan[]): Promise<SourceInspection> {
    if (!selected.length || selected.some((span) => !validRange(span.rawRange, snapshot.text.length) || span.rawRange.from < snapshot.bodyStart ||
      snapshot.text.slice(span.rawRange.from, span.rawRange.to) !== span.rawText || !snapshot.spans.some((item) => item.blockKey === span.blockKey && item.rawText === span.rawText && item.rawRange.from === span.rawRange.from && item.rawRange.to === span.rawRange.to))) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
    for (let i = 1; i < selected.length; i++) if (selected[i].rawRange.from < selected[i - 1].rawRange.to) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
    const resolved = this.resolved.get(snapshot);
    const text = resolved?.text ?? snapshot.text;
    const spans = selected.map((span) => ({ ...(resolved?.spans.get(span.blockKey) ?? span), rawRange: { ...(resolved?.spans.get(span.blockKey) ?? span).rawRange } }));
    const current = await this.editors.readSource(snapshot.sourceRef);
    if (text !== current) throw new CitationError("SOURCE_STALE");
    const first = spans[0];
    const id = this.existingId(text, first, this.editors.file(snapshot.sourceRef));
    const marker = inlineBlockId(first.rawText, first.kind) ?? (first.kind !== "list_item" ? standaloneId(text, first.rawRange.to) : undefined);
    const canCreate = canCreateBlockId(first.kind, first.rawText) && !marker;
    return { text, spans, id, canCreate, heading: first.heading };
  }
  private existingId(text: string, span: OriginSpan, file: TFile): string | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    const cachedId = span.kind === "list_item" ? Object.values(cache?.blocks ?? {}).find((block) =>
      (block.position.start.offset === span.rawRange.from || block.position.start.line === text.slice(0, span.rawRange.from).split("\n").length - 1) &&
      span.rawText.split(/\r?\n/).some((line) => line.match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/)?.[1] === block.id))?.id : undefined;
    const id = inlineBlockId(span.rawText, span.kind) ?? (span.kind !== "list_item" ? standaloneId(text, span.rawRange.to) : undefined) ?? cachedId;
    if (!id) return;
    const markers = [...text.matchAll(/(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*(?=\r?$)/gm)];
    return markers.filter((marker) => marker[1] === id).length === 1 ? id : undefined;
  }
  async ensure(snapshot: SourceSnapshot, selected: readonly OriginSpan[], allowNew: boolean, cancelled: () => boolean): Promise<AnchorResult> {
    const previous = this.queues.get(snapshot.sourceRef) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async (): Promise<AnchorResult> => {
      const inspected = await this.inspect(snapshot, selected);
      if (cancelled()) throw new CitationError("OPERATION_CANCELLED");
      if (inspected.id) return { ...inspected, kind: "reused", sourceAfter: inspected.text };
      if (!allowNew || !inspected.canCreate) return { ...inspected, kind: "unavailable", sourceAfter: inspected.text };
      const span = inspected.spans[0];
      const id = this.uniqueId(inspected.text);
      const newline = inspected.text.includes("\r\n") ? "\r\n" : "\n";
      const suffix = inspected.text.slice(span.rawRange.to);
      const padding = suffix.startsWith(newline + newline) ? "" : suffix.startsWith(newline) ? newline : newline + newline;
      const text = span.kind === "paragraph" || span.kind === "list_item" ? ` ^${id}` : `${newline}${newline}^${id}${padding}`;
      const range = { from: span.rawRange.to, to: span.rawRange.to };
      const expected = inspected.text.slice(0, range.from) + text + inspected.text.slice(range.to);
      let failure: unknown;
      try {
        if (!this.editors.writeSource(snapshot.sourceRef, inspected.text, range, text)) {
          await this.app.vault.process(this.editors.file(snapshot.sourceRef), (current) => {
            if (cancelled()) throw new CitationError("OPERATION_CANCELLED");
            if (current !== inspected.text || getFrontMatterInfo(current).contentStart !== snapshot.bodyStart) throw new CitationError("SOURCE_STALE");
            return expected;
          });
        }
      } catch (error) { failure = error; }
      let actual: string;
      try { actual = await this.editors.readSource(snapshot.sourceRef); }
      catch { throw new CitationError("COMMIT_STATE_UNCERTAIN"); }
      if (actual !== expected) {
        if (failure instanceof CitationError && ["SOURCE_STALE", "SOURCE_AMBIGUOUS", "SOURCE_MISSING", "OPERATION_CANCELLED"].includes(failure.code)) throw failure;
        if (actual !== inspected.text) throw new CitationError("COMMIT_STATE_UNCERTAIN");
        if (failure instanceof CitationError) throw failure;
        throw new CitationError("ANCHOR_WRITE_FAILED");
      }
      this.remapSnapshots(snapshot.sourceRef, { before: inspected.text, after: expected, range, text });
      this.onWritten?.(this.editors.path(snapshot.sourceRef));
      return { ...inspected, kind: "created", id, sourceAfter: expected };
    });
    this.queues.set(snapshot.sourceRef, job);
    try { return await job; } finally { if (this.queues.get(snapshot.sourceRef) === job) this.queues.delete(snapshot.sourceRef); }
  }
  private remapSnapshots(sourceRef: string, edit: KnownEdit): void {
    const refs = this.snapshots.get(sourceRef);
    for (const ref of refs ?? []) {
      const snapshot = ref.deref();
      if (!snapshot) { refs?.delete(ref); continue; }
      const resolved = this.resolved.get(snapshot)!;
      if (resolved.text !== edit.before) continue;
      resolved.spans = new Map([...resolved.spans].map(([key, span]) => {
        const from = span.rawRange.from >= edit.range.from ? span.rawRange.from + edit.text.length : span.rawRange.from;
        const to = span.rawRange.to > edit.range.from || span.rawRange.to === edit.range.from && edit.text.startsWith(" ^") ? span.rawRange.to + edit.text.length : span.rawRange.to;
        return [key, { ...span, rawRange: { from, to }, rawText: edit.after.slice(from, to) }];
      }));
      resolved.text = edit.after;
    }
  }
  private uniqueId(source: string): string {
    const used = new Set([...source.matchAll(/\^([A-Za-z0-9-]+)/g)].map((match) => match[1]));
    let id: string;
    do { id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36]).join(""); } while (used.has(id));
    return id;
  }
  content(span: OriginSpan): string { return stripInlineBlockId(span.rawText, span.kind, span.existingBlockId); }
}
