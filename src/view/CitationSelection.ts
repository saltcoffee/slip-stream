import { stripInlineBlockId } from "../domain/BlockReference";
import { visibleCharacters } from "../domain/SnippetExtractor";
import { canonicalSelectionKey, CitationError } from "../domain/citationTypes";
import type { OriginSpan, SourceSnapshot, TextRange } from "../domain/citationTypes";
import { sliceContextAfter, sliceContextBefore } from "../domain/outlineTypes";
import type { EvidenceSnapshot, SavedOrigin } from "../domain/outlineTypes";

export interface CitationUnit {
  origin: OriginSpan;
  content: string;
  mode: "block" | "fragment";
  key: string;
  projection?: readonly number[];
}
export interface CapturedFragment {
  spans: OriginSpan[];
  content: string;
  mode: "block" | "fragment" | "selection";
  selectionKey?: string;
  selectedRanges?: TextRange[];
}
const unsupported = "img,svg,iframe,canvas,.math,.math-block,.math-inline,.internal-embed,.mermaid,[data-cite-unsupported]";

export function rangesFromOffsets(offsets: readonly number[]): TextRange[] {
  if (!offsets.length) return [];
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const ranges: TextRange[] = [];
  let from = sorted[0];
  let to = from + 1;
  for (let i = 1; i < sorted.length; i++) {
    const pos = sorted[i];
    if (pos === to) {
      to = pos + 1;
    } else if (pos > to) {
      ranges.push({ from, to });
      from = pos;
      to = pos + 1;
    }
  }
  ranges.push({ from, to });
  return ranges;
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TextRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const last = merged[merged.length - 1];
    if (next.from <= last.to) {
      last.to = Math.max(last.to, next.to);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

export function defaultOriginContentRange(origin: OriginSpan): TextRange {
  const stripped = stripInlineBlockId(origin.rawText, origin.kind, origin.existingBlockId);
  if (stripped.length > 0) {
    return { from: origin.rawRange.from, to: origin.rawRange.from + stripped.length };
  }
  return { ...origin.rawRange };
}

function projectOriginChars(origin: OriginSpan): Array<{ value: string; offset: number }> {
  const stripped = stripInlineBlockId(origin.rawText, origin.kind, origin.existingBlockId);
  if (origin.kind === "code") {
    const lines: Array<{ text: string; start: number }> = [];
    let offset = origin.rawRange.from;
    for (const line of origin.rawText.split("\n")) {
      lines.push({ text: line, start: offset });
      offset += line.length + 1;
    }
    let first = 0;
    let last = lines.length;
    if (lines.length && /^\s*(```|~~~)/.test(lines[0].text)) first = 1;
    if (last > first && /^\s*(```|~~~)\s*$/.test(lines[last - 1].text)) last -= 1;
    const chars: Array<{ value: string; offset: number }> = [];
    for (let i = first; i < last; i++) {
      if (i > first) chars.push({ value: "\n", offset: lines[i].start - 1 });
      const line = lines[i].text.replace(/\r$/, "").replace(/^(?: {4}|\t)/, "");
      const removed = lines[i].text.replace(/\r$/, "").length - line.length;
      for (let j = 0; j < line.length; j++) {
        chars.push({ value: line[j], offset: lines[i].start + removed + j });
      }
    }
    return chars;
  }
  if (origin.kind === "heading") {
    const lead = stripped.match(/^\s*#{1,6}\s+/)?.[0].length ?? 0;
    const body = stripped.slice(lead).replace(/\s+#+\s*$/, "");
    return visibleCharacters(body, origin.rawRange.from + lead);
  }
  return visibleCharacters(stripped, origin.rawRange.from);
}

function mapUnitSelectionToRanges(
  unit: CitationUnit,
  renderedText: string,
  intervals: ReadonlyArray<readonly [number, number]>,
): TextRange[] {
  const out: TextRange[] = [];
  if (unit.projection && unit.projection.length > 0) {
    for (const [start, end] of intervals) {
      const slice = unit.projection.slice(start, Math.min(end, unit.projection.length));
      if (slice.length > 0) out.push(...rangesFromOffsets(slice));
    }
    return out;
  }

  const totalLen = renderedText.length;
  const fullSelected = intervals.length === 1 && intervals[0][0] === 0 && intervals[0][1] === totalLen;
  if (fullSelected) {
    return [defaultOriginContentRange(unit.origin)];
  }

  const projected = projectOriginChars(unit.origin);
  const projText = projected.map((c) => c.value).join("");
  for (const [start, end] of intervals) {
    if (end <= projected.length && projText.slice(start, end) === renderedText.slice(start, end)) {
      out.push(...rangesFromOffsets(projected.slice(start, end).map((c) => c.offset)));
      continue;
    }
    const sub = renderedText.slice(start, end);
    const first = sub.length > 0 ? projText.indexOf(sub) : -1;
    const last = sub.length > 0 ? projText.lastIndexOf(sub) : -1;
    if (first >= 0 && first === last) {
      out.push(...rangesFromOffsets(projected.slice(first, first + sub.length).map((c) => c.offset)));
    } else {
      out.push(defaultOriginContentRange(unit.origin));
    }
  }
  return out;
}

/** Converts any captured card/focus fragment plus live SourceSnapshot into a serializable EvidenceSnapshot. */
export function buildEvidenceSnapshot(params: {
  sourcePath: string;
  sourceSnapshot: SourceSnapshot;
  fragment: CapturedFragment;
  capturedAt?: number;
}): EvidenceSnapshot {
  const { sourcePath, sourceSnapshot, fragment } = params;
  const ordered = [...fragment.spans].sort((a, b) => a.rawRange.from - b.rawRange.from || b.rawRange.to - a.rawRange.to);
  const origins: SavedOrigin[] = [];
  let prevTo = 0;
  for (const span of ordered) {
    if (span.rawRange.from < prevTo) continue;
    prevTo = span.rawRange.to;
    origins.push({
      range: { ...span.rawRange },
      rawText: span.rawText,
      kind: span.kind,
      ...(span.existingBlockId ? { blockId: span.existingBlockId } : {}),
      ...(span.heading ? { heading: span.heading } : {}),
      before: sliceContextBefore(sourceSnapshot.text, span.rawRange.from),
      after: sliceContextAfter(sourceSnapshot.text, span.rawRange.to),
    });
  }

  const validCandidateRanges = (fragment.selectedRanges ?? []).filter((sr) =>
    sr.to > sr.from && origins.some((origin) => sr.from >= origin.range.from && sr.to <= origin.range.to),
  );
  const selectedRanges = validCandidateRanges.length > 0
    ? mergeRanges(validCandidateRanges)
    : ordered.map(defaultOriginContentRange);

  return {
    content: fragment.content,
    mode: fragment.mode,
    source: {
      path: sourcePath,
      capturedPath: sourcePath,
      title: sourceSnapshot.title ?? sourcePath.split("/").pop()?.replace(/\.md$/, "") ?? sourcePath,
      capturedAt: params.capturedAt ?? Date.now(),
      sourceLength: sourceSnapshot.text.length,
      identity: "path-reference",
    },
    origins,
    selectedRanges,
  };
}

/** Uses the ordered DOM Range, so reverse selections follow exactly the same path. */
export function captureSelection(body: HTMLElement, units: ReadonlyMap<HTMLElement, CitationUnit>, selection = body.ownerDocument.getSelection()): CapturedFragment | undefined {
  if (!selection || !selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  if (selection.rangeCount !== 1) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  for (const node of Array.from(body.querySelectorAll(`${unsupported},[data-no-cite]`))) if (range.intersectsNode(node)) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  const nearest = (node: Node): { element: HTMLElement; unit: CitationUnit } | undefined => {
    let el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
    while (el && body.contains(el)) {
      const unit = units.get(el);
      if (unit) return { element: el, unit };
      el = el.parentElement;
    }
    return;
  };
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  const offsets = new Map<HTMLElement, number>();
  const unitChunks = new Map<HTMLElement, string[]>();
  const unitIntervals = new Map<HTMLElement, Array<[number, number]>>();
  const parts: string[] = [];
  const selected: OriginSpan[] = [];
  let previousBlock: Element | null | undefined;
  while ((node = walker.nextNode())) {
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR";
    if (node.nodeType !== Node.TEXT_NODE && !isBreak) continue;
    const mapped = nearest(node);
    const text = isBreak ? "\n" : node.textContent ?? "";
    // Ignore renderer indentation between semantic blocks; whitespace inside prose remains intact.
    if (node.nodeType === Node.TEXT_NODE && !text.trim() && node.parentElement?.children.length &&
      !node.parentElement.matches("p,li,pre,h1,h2,h3,h4,h5,h6")) continue;
    const offset = mapped ? offsets.get(mapped.element) ?? 0 : 0;
    if (mapped) {
      offsets.set(mapped.element, offset + text.length);
      const chunks = unitChunks.get(mapped.element) ?? [];
      chunks.push(text);
      unitChunks.set(mapped.element, chunks);
    }
    if (!range.intersectsNode(node)) continue;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : text.length;
    if (end <= start) continue;
    if (!mapped) { if (text.trim()) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED"); continue; }
    const paragraph = (node.parentElement)?.closest("p,li,h1,h2,h3,h4,h5,h6,pre,.slipstream-citation-content");
    if (parts.length && paragraph !== previousBlock && !parts.at(-1)?.endsWith("\n\n")) parts.push("\n\n");
    parts.push(text.slice(start, end));
    previousBlock = paragraph;
    selected.push(mapped.unit.origin);
    const list = unitIntervals.get(mapped.element) ?? [];
    list.push([offset + start, offset + end]);
    unitIntervals.set(mapped.element, list);
  }
  const content = parts.join("");
  if (!content.trim()) return;
  const ordered = [...new Map(selected.map((span) => [span.blockKey, span])).values()].sort((a, b) => a.rawRange.from - b.rawRange.from || b.rawRange.to - a.rawRange.to);
  const spans = ordered.filter((span, index) => !ordered.slice(0, index).some((parent) => parent.rawRange.from <= span.rawRange.from && parent.rawRange.to >= span.rawRange.to));
  if (!spans.length) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");

  const rawSelectedRanges: TextRange[] = [];
  for (const [el, intervals] of unitIntervals) {
    const unit = units.get(el)!;
    const renderedText = (unitChunks.get(el) ?? []).join("");
    rawSelectedRanges.push(...mapUnitSelectionToRanges(unit, renderedText, intervals));
  }
  const selectedRanges = mergeRanges(
    rawSelectedRanges.filter((sr) => sr.to > sr.from && spans.some((span) => sr.from >= span.rawRange.from && sr.to <= span.rawRange.to)),
  );

  const selectionKey = canonicalSelectionKey(spans, selectedRanges);
  return {
    spans,
    content,
    mode: "selection",
    ...(selectionKey ? { selectionKey } : {}),
    ...(selectedRanges.length > 0 ? { selectedRanges } : {}),
  };
}
