import type { App, TFile } from "obsidian";
import MarkdownIt from "markdown-it";
import type { BlockKind, RenderUnit, SourceBlock } from "./types";

const md = new MarkdownIt();

export function frontmatterEndLine(app: App, file: TFile): number {
  const cache = app.metadataCache.getFileCache(file);
  const pos = cache?.frontmatterPosition;
  if (pos && pos.end) return pos.end.line + 1;
  return 0;
}

function kindOf(t: { type: string }, raw: string): BlockKind {
  switch (t.type) {
    case "list_item_open":
      return "list_item";
    case "blockquote_open":
      return /^\s*>\s*\[!/.test(raw) ? "callout" : "blockquote";
    case "paragraph_open":
      return "paragraph";
    case "heading_open":
      return "heading";
    case "fence":
    case "code_block":
      return "code";
    case "table_open":
      return "table";
    default:
      return "other";
  }
}

/**
 * 叶子块：段落 / 列表项 / 引用 / Callout / 代码 / 表格 / 其他。
 * 两步：先用 metadataCache 定 Frontmatter 边界，再用 markdown-it token.map 取细粒度行范围。
 */
export function mapBlocks(app: App, file: TFile, source: string): SourceBlock[] {
  const lines = source.split("\n");
  const fmEnd = frontmatterEndLine(app, file);
  const body = lines.slice(fmEnd).join("\n");
  const tokens = md.parse(body, {});
  const out: SourceBlock[] = [];

  for (const t of tokens) {
    const map = t.map;
    if (!map) continue;
    const isListItem = t.type === "list_item_open";
    const isTopBlock =
      t.level === 0 &&
      [
        "paragraph_open",
        "heading_open",
        "blockquote_open",
        "table_open",
        "fence",
        "code_block",
        "hr",
        "html_block",
      ].includes(t.type);
    if (!isListItem && !isTopBlock) continue;

    const startLine = map[0] + fmEnd;
    const endLine = map[1] + fmEnd;
    const raw = lines.slice(startLine, endLine).join("\n");
    const m = raw.match(/\s\^([A-Za-z0-9-]+)\s*$/);
    out.push({
      startLine,
      endLine,
      content: raw,
      type: kindOf(t, raw),
      hasBlockId: !!m,
      blockId: m?.[1],
    });
  }
  return out;
}

/** 合并连续 list_item 为一个 list 渲染单元，避免有序列表编号被重置。 */
export function groupRenderUnits(blocks: SourceBlock[], lines: string[]): RenderUnit[] {
  const units: RenderUnit[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "list_item") {
      const items: { startLine: number; endLine: number }[] = [];
      const start = b.startLine;
      let end = b.endLine;
      while (i < blocks.length && blocks[i].type === "list_item") {
        items.push({ startLine: blocks[i].startLine, endLine: blocks[i].endLine });
        end = blocks[i].endLine;
        i++;
      }
      units.push({
        startLine: start,
        endLine: end,
        content: lines.slice(start, end).join("\n"),
        type: "list",
        items,
      });
    } else {
      units.push({ ...b });
      i++;
    }
  }
  return units;
}
