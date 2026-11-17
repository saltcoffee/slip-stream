import type { SourceBlock } from "./types";
import type { OriginSpan, TextRange } from "./citationTypes";
import { mapBlocks, originOf } from "./BlockMapper";
import { visibleCharacters } from "./SnippetExtractor";

export type SegmentKind = "body" | "heading" | "code" | "table-cell";

export interface ProjectedSegment {
  text: string;
  /** 每个可见字符对应的原文绝对 UTF-16 偏移；长度与 text 相同。 */
  sourceOffsets: number[];
  origin: OriginSpan;
  kind: SegmentKind;
}

export interface ProjectedHighlight {
  origin: OriginSpan;
  unitRange: TextRange;
  text: string;
  sourceOffsets: number[];
}

export interface ProjectedCallout {
  origin: OriginSpan;
  unitRange: TextRange;
  text: string;
  sourceOffsets: number[];
}

export interface DocumentProjection {
  blocks: SourceBlock[];
  segments: ProjectedSegment[];
  highlights: ProjectedHighlight[];
  callouts: ProjectedCallout[];
}

/** 只把 A–Z 映射为 a–z，保持 UTF-16 长度，满足“英文不区分大小写”契约。 */
export function foldAscii(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i];
  }
  return out;
}

/** 在可见文字中查找完整字面短语，返回每处命中的原文 UTF-16 范围。 */
export function findMatches(text: string, offsets: readonly number[], query: string): TextRange[] {
  const needle = foldAscii(query.trim());
  if (!needle || !text || offsets.length !== text.length) return [];
  const haystack = foldAscii(text);
  const ranges: TextRange[] = [];
  let index = 0;
  while (index <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, index);
    if (found < 0) break;
    const end = found + needle.length;
    const from = offsets[found];
    const last = offsets[end - 1];
    if (from !== undefined && last !== undefined) ranges.push({ from, to: last + 1 });
    index = found + Math.max(1, needle.length);
  }
  return ranges;
}

function segment(text: string, offsets: number[], origin: OriginSpan, kind: SegmentKind): ProjectedSegment | undefined {
  if (!text.trim() || text.length !== offsets.length) return undefined;
  return { text, sourceOffsets: offsets, origin, kind };
}

function visibleSegment(raw: string, from: number, origin: OriginSpan, kind: SegmentKind): ProjectedSegment | undefined {
  const chars = visibleCharacters(raw, from);
  return segment(chars.map((c) => c.value).join(""), chars.map((c) => c.offset), origin, kind);
}

function codeSegment(block: SourceBlock, origin: OriginSpan): ProjectedSegment | undefined {
  const raw = block.content;
  const from = block.rawRange.from;
  const lines: Array<{ text: string; start: number }> = [];
  let offset = from;
  for (const line of raw.split("\n")) {
    lines.push({ text: line, start: offset });
    offset += line.length + 1;
  }
  let first = 0;
  let last = lines.length;
  if (lines.length && /^\s*(```|~~~)/.test(lines[0].text)) { first = 1; }
  if (last > first && /^\s*(```|~~~)\s*$/.test(lines[last - 1].text)) { last -= 1; }
  const text: string[] = [];
  const offsets: number[] = [];
  for (let i = first; i < last; i++) {
    if (i > first) { text.push("\n"); offsets.push(lines[i].start); }
    const line = lines[i].text.replace(/^(?: {4}|\t)/, "");
    const removed = lines[i].text.length - line.length;
    for (let j = 0; j < line.length; j++) { text.push(line[j]); offsets.push(lines[i].start + removed + j); }
  }
  return segment(text.join(""), offsets, origin, "code");
}

function tableSegments(block: SourceBlock, origin: OriginSpan): ProjectedSegment[] {
  const out: ProjectedSegment[] = [];
  let lineStart = block.rawRange.from;
  for (const line of block.content.split("\n")) {
    const separator = /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
    if (!separator && line.includes("|")) {
      let cursor = 0;
      for (const cell of line.split("|")) {
        const cellStart = lineStart + cursor;
        const leading = cell.length - cell.trimStart().length;
        const trimmed = cell.trim();
        if (trimmed) {
          const text = trimmed;
          const offsets: number[] = [];
          for (let i = 0; i < trimmed.length; i++) offsets.push(cellStart + leading + i);
          const part = segment(text, offsets, origin, "table-cell");
          if (part) out.push(part);
        }
        cursor += cell.length + 1;
      }
    }
    lineStart += line.length + 1;
  }
  return out;
}

function inlineCodeRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // 支持单反引号与多反引号（如 ``code``）代码跨度。
  for (const match of raw.matchAll(/(`+)([\s\S]*?)\1/g)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

function highlightOccurrences(text: string, blocks: SourceBlock[]): ProjectedHighlight[] {
  const out: ProjectedHighlight[] = [];
  for (const block of blocks) {
    if (block.type === "code") continue;
    const codeRanges = inlineCodeRanges(block.content);
    for (const match of block.content.matchAll(/==([^=\n]+)==/g)) {
      const matchStart = match.index ?? 0;
      // 行内代码中的 == 不是真实高亮。
      if (codeRanges.some(([start, end]) => matchStart >= start && matchStart < end)) continue;
      const inner = match[1];
      const from = block.rawRange.from + matchStart + 2;
      const chars = visibleCharacters(inner, from);
      const projected = chars.map((c) => c.value).join("");
      if (!projected.trim()) continue;
      out.push({
        origin: originOf(block),
        unitRange: { from, to: from + inner.length + 2 },
        text: projected,
        sourceOffsets: chars.map((c) => c.offset),
      });
    }
  }
  return out;
}

function calloutOccurrences(blocks: SourceBlock[]): ProjectedCallout[] {
  const out: ProjectedCallout[] = [];
  for (const block of blocks) {
    if (block.type !== "callout") continue;
    const chars = visibleCharacters(block.content, block.rawRange.from);
    const text = chars.map((c) => c.value).join("");
    if (!text.trim()) continue;
    out.push({ origin: originOf(block), unitRange: { ...block.rawRange }, text, sourceOffsets: chars.map((c) => c.offset) });
  }
  return out;
}

/** 将同一来源快照的原文投影为可检索分段、真实高亮与 Callout。 */
export function projectDocument(text: string, bodyStart = 0): DocumentProjection {
  const blocks = mapBlocks(text, bodyStart);
  const segments: ProjectedSegment[] = [];
  for (const block of blocks) {
    const origin = originOf(block);
    origin.rawText = text.slice(origin.rawRange.from, origin.rawRange.to);
    if (block.type === "code") {
      const part = codeSegment(block, origin);
      if (part) segments.push(part);
      continue;
    }
    if (block.type === "table") {
      segments.push(...tableSegments(block, origin));
      continue;
    }
    const kind: SegmentKind = block.type === "heading" ? "heading" : "body";
    const part = visibleSegment(block.content, block.rawRange.from, origin, kind);
    if (part) segments.push(part);
  }
  return { blocks, segments, highlights: highlightOccurrences(text, blocks), callouts: calloutOccurrences(blocks) };
}

/** 取围绕某个可见位置的窗口，保证至少容纳一次完整命中。 */
export function previewWindow(text: string, offsets: number[], start: number, end: number, budget = 240): { text: string; sourceOffsets: number[]; truncated: boolean } {
  if (text.length <= budget) return { text, sourceOffsets: [...offsets], truncated: false };
  const span = Math.max(end - start, 1);
  const width = Math.max(budget, span);
  let from = Math.max(0, start - Math.floor((width - span) / 2));
  let to = Math.min(text.length, from + width);
  from = Math.max(0, to - width);
  return { text: text.slice(from, to), sourceOffsets: offsets.slice(from, to), truncated: from > 0 || to < text.length };
}
