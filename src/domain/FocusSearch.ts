import type { CollectionItem } from "./deskTypes";
import type { OriginSpan, TextRange } from "./citationTypes";
import { CitationError } from "./citationTypes";
import type { SearchDocument, SearchDocumentReader } from "../infra/SearchDocumentReader";
import { findMatches, previewWindow, projectDocument } from "./SourceProjection";
import type { ProjectedCallout, ProjectedHighlight, ProjectedSegment } from "./SourceProjection";

export type FocusKind = "all" | "highlight" | "callout" | "either";

export interface FocusRequest {
  sessionId: string;
  deskId?: string;
  scopeRevision: number;
  collectionGeneration: number;
  query: string;
  kind: FocusKind;
  includeHidden: boolean;
}

export type SearchPhase = "running" | "complete" | "partial" | "cancelled" | "failed";

export interface FocusPreview {
  text: string;
  sourceOffsets: number[];
  truncated: boolean;
}

/** 稳定文本指纹，用于确认引用仍指向检索时的同一原文块。 */
export function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${value.length}`;
}

export interface FocusResult {
  key: string;
  sourceRef: string;
  sourceVersion: number;
  filePath: string;
  title: string;
  originRange: TextRange;
  unitRange: TextRange;
  kind: "body" | "highlight" | "callout";
  heading?: string;
  matches: TextRange[];
  /** 检索时原文块的指纹；引用前用于防止静默引用已变化的代码块或整块。 */
  originHash?: string;
  preview?: FocusPreview;
  /** 每个命中位置的预览窗口，用于逐处导航。 */
  occurrences?: FocusPreview[];
  order: number;
}

export interface FocusProgress {
  total: number;
  scanned: number;
  failed: number;
  files: number;
  units: number;
  keywords: number;
  phase: SearchPhase;
}

export interface SearchRun {
  request: FocusRequest;
  phase: SearchPhase;
  total: number;
  scanned: number;
  failed: number;
  results: FocusResult[];
  progress: FocusProgress;
  error?: string;
}

function result(kind: FocusResult["kind"], doc: SearchDocument, item: CollectionItem, order: number,
  origin: OriginSpan, unitRange: TextRange, matches: TextRange[], occurrences: FocusPreview[]): FocusResult {
  return {
    key: `${doc.fileRef}:${kind}:${unitRange.from}:${unitRange.to}`,
    sourceRef: doc.fileRef,
    sourceVersion: doc.version,
    filePath: item.path,
    title: item.title,
    originRange: origin.rawRange,
    unitRange,
    kind,
    ...(origin.heading ? { heading: origin.heading } : {}),
    matches,
    originHash: hashText(origin.rawText),
    ...(occurrences.length ? { preview: occurrences[0], occurrences } : {}),
    order,
  };
}

function previewFor(text: string, offsets: number[], match: TextRange | undefined): FocusPreview {
  if (!match) return previewWindow(text, offsets, 0, Math.min(text.length, 240));
  const start = Math.max(0, offsets.indexOf(match.from));
  const lastIndex = offsets.indexOf(Math.max(match.from, match.to - 1));
  const end = lastIndex < 0 ? start + 1 : lastIndex + 1;
  return previewWindow(text, offsets, start, end);
}

function bodyResults(query: string, doc: SearchDocument, item: CollectionItem, order: number, segments: ProjectedSegment[]): FocusResult[] {
  const grouped = new Map<string, { origin: OriginSpan; matches: TextRange[]; occurrences: FocusPreview[] }>();
  for (const segment of segments) {
    const matches = findMatches(segment.text, segment.sourceOffsets, query);
    if (!matches.length) continue;
    const entry = grouped.get(segment.origin.blockKey) ?? { origin: segment.origin, matches: [], occurrences: [] };
    entry.matches.push(...matches);
    for (const match of matches) entry.occurrences.push(previewFor(segment.text, segment.sourceOffsets, match));
    grouped.set(segment.origin.blockKey, entry);
  }
  return [...grouped.values()].map((entry) => result("body", doc, item, order, entry.origin, entry.origin.rawRange, entry.matches, entry.occurrences));
}

function highlightResults(query: string, doc: SearchDocument, item: CollectionItem, order: number, highlights: ProjectedHighlight[]): FocusResult[] {
  const out: FocusResult[] = [];
  for (const highlight of highlights) {
    const matches = query ? findMatches(highlight.text, highlight.sourceOffsets, query) : [];
    if (query && !matches.length) continue;
    const occurrences = matches.length ? matches.map((match) => previewFor(highlight.text, highlight.sourceOffsets, match)) : [previewFor(highlight.text, highlight.sourceOffsets, undefined)];
    out.push(result("highlight", doc, item, order, highlight.origin, highlight.unitRange, matches, occurrences));
  }
  return out;
}

function calloutResults(query: string, doc: SearchDocument, item: CollectionItem, order: number, callouts: ProjectedCallout[]): FocusResult[] {
  const out: FocusResult[] = [];
  for (const callout of callouts) {
    const matches = query ? findMatches(callout.text, callout.sourceOffsets, query) : [];
    if (query && !matches.length) continue;
    const occurrences = matches.length ? matches.map((match) => previewFor(callout.text, callout.sourceOffsets, match)) : [previewFor(callout.text, callout.sourceOffsets, undefined)];
    out.push(result("callout", doc, item, order, callout.origin, callout.unitRange, matches, occurrences));
  }
  return out;
}

function matchDocument(request: FocusRequest, doc: SearchDocument, item: CollectionItem, order: number): FocusResult[] {
  const query = request.query.trim();
  const projection = projectDocument(doc.text, doc.bodyStart);
  if (!query && request.kind === "all") return [];
  if (request.kind === "all") return bodyResults(query, doc, item, order, projection.segments);
  if (request.kind === "highlight") return highlightResults(query, doc, item, order, projection.highlights);
  if (request.kind === "callout") return calloutResults(query, doc, item, order, projection.callouts);
  const callouts = calloutResults(query, doc, item, order, projection.callouts);
  const calloutBlocks = new Set(callouts.map((entry) => entry.originRange.from));
  const highlights = highlightResults(query, doc, item, order, projection.highlights)
    .filter((entry) => !calloutBlocks.has(entry.originRange.from));
  return [...callouts, ...highlights];
}

/** 对完整候选列表做有限并发扫描；取消是合作式终止，迟到结果不发布。 */
export class FocusSearch {
  constructor(private reader: SearchDocumentReader) {}

  async run(request: FocusRequest, candidates: readonly CollectionItem[], signal: AbortSignal, collectionComplete: boolean,
    onProgress: (progress: FocusProgress, results: readonly FocusResult[]) => void): Promise<SearchRun> {
    const results: FocusResult[] = [];
    let scanned = 0;
    let failed = 0;
    let failure: unknown;
    let cursor = 0;
    let lastYield = Date.now();

    const progress = (phase: SearchPhase): FocusProgress => ({
      total: candidates.length, scanned, failed,
      files: new Set(results.map((entry) => entry.sourceRef)).size,
      units: results.length,
      keywords: results.reduce((count, entry) => count + (entry.kind === "body" || request.query.trim() ? entry.matches.length : 0), 0),
      phase,
    });
    onProgress(progress("running"), results);

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const item = candidates[index];
        try {
          const doc = await this.reader.read(item.fileRef, signal);
          if (signal.aborted) return;
          // 读取期间正文已变化：本次结果按旧版本返回，交由上层判定待刷新。
          results.push(...matchDocument(request, doc, item, index));
          scanned++;
        } catch (error) {
          if (signal.aborted) return;
          failed++;
          failure = error;
        }
        onProgress(progress("running"), results);
        if (Date.now() - lastYield >= 8) {
          lastYield = Date.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);

    results.sort((a, b) => a.order - b.order || a.unitRange.from - b.unitRange.from || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    const phase = this.phase(signal.aborted, candidates.length, scanned, failed, collectionComplete, failure);
    const finalProgress = progress(phase);
    onProgress(finalProgress, results);
    return {
      request, phase, total: candidates.length, scanned, failed, results, progress: finalProgress,
      ...(phase === "failed" ? { error: failure instanceof CitationError ? failure.code : "SEARCH_FAILED" } : {}),
    };
  }

  private phase(aborted: boolean, total: number, scanned: number, failed: number, complete: boolean, failure: unknown): SearchPhase {
    if (aborted) return "cancelled";
    if (failure instanceof CitationError && failure.code === "OPERATION_CANCELLED") return "cancelled";
    if (total > 0 && scanned === 0 && failed === total) return "failed";
    if (scanned + failed >= total) {
      if (failed > 0 || !complete) return "partial";
      return "complete";
    }
    return "running";
  }
}
