import type { SourceBlock } from "./types";
import { originOf } from "./BlockMapper";
import type { OriginSpan } from "./citationTypes";

export interface Snippet {
  id: string;
  displayText: string;
  origin: OriginSpan;
  /** Source UTF-16 offsets for the displayed characters, never a reverse text search. */
  projection: readonly number[];
  truncated: boolean;
}

type Character = { value: string; offset: number };
function visible(raw: string, from: number): Character[] {
  let chars = Array.from({ length: raw.length }, (_, i) => ({ value: raw[i], offset: from + i }));
  const remove = (pattern: RegExp, keep?: number) => {
    const text = chars.map((c) => c.value).join("");
    const ranges = [...text.matchAll(pattern)].reverse();
    for (const match of ranges) {
      const start = match.index!;
      const retained = keep === undefined ? [] : chars.slice(start + match[0].indexOf(match[keep]), start + match[0].indexOf(match[keep]) + match[keep].length);
      chars.splice(start, match[0].length, ...retained);
    }
  };
  remove(/\r(?=\n)/g);
  remove(/^>\s*\[![^\]]+\][+-]?\s*/gm);
  remove(/^> ?/gm);
  remove(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm);
  remove(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, 2);
  remove(/\[\[([^\]]+)\]\]/g, 1);
  remove(/\[([^\]]+)\]\([^\n)]*\)/g, 1);
  remove(/==|\*\*|__|~~|`/g);
  remove(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/g);
  return chars;
}

function snippet(id: string, block: SourceBlock, raw: string, offset: number, limit: number): Snippet | undefined {
  const chars = visible(raw, offset);
  if (!chars.map((c) => c.value).join("").trim()) return undefined;
  const clipped = chars.slice(0, limit);
  return { id, displayText: clipped.map((c) => c.value).join(""), origin: originOf(block),
    projection: clipped.map((c) => c.offset), truncated: chars.length > limit };
}

export function extractSnippet(source: string, blocks: SourceBlock[], excerptLength: number,
  includeHighlights: boolean, includeCallouts: boolean, calloutLimit: number
): { excerpt?: Snippet; highlights: Snippet[]; callouts: Snippet[]; wordCount: number } {
  const supported = blocks.filter((b) => !["heading", "code", "table", "other"].includes(b.type));
  let excerpt: Snippet | undefined;
  for (const block of supported) {
    excerpt = snippet(`excerpt:${block.blockKey}`, block, block.content, block.rawRange.from, excerptLength);
    if (excerpt) break;
  }
  const highlights: Snippet[] = [];
  if (includeHighlights) for (const match of source.matchAll(/==([^=\n]+)==/g)) {
    const from = match.index!;
    const block = supported.filter((b) => b.rawRange.from <= from && from + match[0].length <= b.rawRange.to)
      .sort((a, b) => a.rawRange.to - a.rawRange.from - (b.rawRange.to - b.rawRange.from))[0];
    if (!block) continue;
    const part = snippet(`highlight:${from}`, block, match[1], from + 2, Number.MAX_SAFE_INTEGER);
    if (part) highlights.push(part);
  }
  const callouts: Snippet[] = [];
  if (includeCallouts) for (const block of supported.filter((b) => b.type === "callout")) {
    const part = snippet(`callout:${block.blockKey}`, block, block.content, block.rawRange.from, calloutLimit);
    if (part) callouts.push(part);
  }
  return { excerpt, highlights, callouts, wordCount: supported.filter((b) => !b.listRange || b.depth === 1)
    .reduce((count, b) => count + visible(b.content, b.rawRange.from).filter((c) => c.value.trim()).length, 0) };
}
