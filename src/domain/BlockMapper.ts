import MarkdownIt from "markdown-it";
import type { BlockKind, RenderUnit, SourceBlock } from "./types";
import type { OriginSpan } from "./citationTypes";
import { inlineBlockId } from "./BlockReference";

const md = new MarkdownIt();

export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") offsets.push(i + 1);
  return offsets;
}

function kindOf(type: string, raw: string): BlockKind {
  switch (type) {
    case "list_item_open": return "list_item";
    case "blockquote_open": return /^\s*>\s*\[!/.test(raw) ? "callout" : "blockquote";
    case "paragraph_open": return "paragraph";
    case "heading_open": return "heading";
    case "fence": case "code_block": return "code";
    case "table_open": return "table";
    default: return "other";
  }
}

/** bodyStart comes from getFrontMatterInfo on the very same source snapshot. */
export function mapBlocks(source: string, bodyStart = 0): SourceBlock[] {
  const offsets = lineOffsets(source);
  const firstLine = offsets.findIndex((offset) => offset >= bodyStart);
  if (firstLine < 0) return [];
  const tokens = md.parse(source.slice(offsets[firstLine]), {});
  const out: SourceBlock[] = [];
  let heading: string | undefined;
  let listRange: { startLine: number; endLine: number } | undefined;
  for (const token of tokens) {
    if (token.level === 0 && /^(bullet|ordered)_list_open$/.test(token.type) && token.map) {
      listRange = { startLine: firstLine + token.map[0], endLine: firstLine + token.map[1] };
    }
    if (token.level === 0 && /^(bullet|ordered)_list_close$/.test(token.type)) listRange = undefined;
    if (!token.map || !(token.type === "list_item_open" || token.level === 0 &&
      ["paragraph_open", "heading_open", "blockquote_open", "table_open", "fence", "code_block", "hr", "html_block"].includes(token.type))) continue;
    const startLine = firstLine + token.map[0];
    let endLine = firstLine + token.map[1];
    while (endLine > startLine + 1 && !source.slice(offsets[endLine - 1], offsets[endLine] ?? source.length).trim()) endLine--;
    const from = offsets[startLine];
    let to = offsets[endLine] ?? source.length;
    if (source[to - 1] === "\n") to--;
    if (source[to - 1] === "\r") to--;
    const raw = source.slice(from, to);
    if (token.type === "paragraph_open" && /^\^[A-Za-z0-9-]+$/.test(raw.trim())) continue;
    const type = kindOf(token.type, raw);
    if (type === "heading") heading = raw.replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "");
    const blockId = inlineBlockId(raw, type) ?? (type !== "list_item" ? standaloneId(source, to) : undefined);
    out.push({ startLine, endLine, content: raw, type, rawRange: { from, to },
      blockKey: `${type}:${from}`, blockId, hasBlockId: !!blockId, heading,
      listRange: type === "list_item" ? listRange : undefined, depth: token.level });
  }
  return out;
}

export function standaloneId(source: string, end: number): string | undefined {
  return source.slice(end).match(/^(?:\r?\n)[ \t]*(?:\r?\n)[ \t\r\n]*\^([A-Za-z0-9-]+)[ \t]*(?=\r?\n|$)/)?.[1];
}

export function groupRenderUnits(blocks: SourceBlock[], lines: string[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  for (const block of blocks) {
    if (!block.listRange) { units.push({ ...block }); continue; }
    const range = block.listRange;
    if (units.some((u) => u.type === "list" && u.startLine === range.startLine)) continue;
    const items = blocks.filter((b) => b.listRange?.startLine === range.startLine);
    const content = lines.slice(range.startLine, range.endLine).join("\n").replace(/\r?\n$/, "");
    const last = items.reduce((a, b) => a.rawRange.to > b.rawRange.to ? a : b);
    units.push({ startLine: range.startLine, endLine: range.endLine, type: "list", content,
      rawRange: { from: block.rawRange.from, to: last.rawRange.to }, blockKey: `list:${block.rawRange.from}`,
      heading: block.heading, items });
  }
  return units;
}

export function originOf(block: RenderUnit | SourceBlock): OriginSpan {
  return { blockKey: block.blockKey, rawRange: { ...block.rawRange }, rawText: block.content,
    kind: block.type, existingBlockId: block.blockId, heading: block.heading };
}
