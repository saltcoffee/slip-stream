import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { lineOffsets } from "./BlockMapper";
import type { TextRange } from "./citationTypes";

export type CitationLayoutPart =
  | { kind: "heading"; id: string; text: string; groupId: string | null }
  | { kind: "citation"; id: string; itemId: string; operationId: string; text: string }
  | { kind: "note"; id: string; itemId?: string; text: string }
  | { kind: "placeholder"; id: string; text: string; reason: "empty-group" | "all-skipped"; groupId?: string | null };

export interface CitationSlice {
  itemId: string;
  operationId: string;
  range: TextRange;
}

export interface LayoutSlice {
  id: string;
  kind: CitationLayoutPart["kind"];
  range: TextRange;
  itemId?: string;
  operationId?: string;
  groupId?: string | null;
}

export interface CitationDocumentLabels {
  collectionHeading: string;
  notePrefix: string;
  emptyGroupPlaceholder: string;
  allSkippedPlaceholder: string;
}

export const DEFAULT_DOCUMENT_LABELS: CitationDocumentLabels = {
  collectionHeading: "收集区",
  notePrefix: "个人备注：",
  emptyGroupPlaceholder: "待补材料",
  allSkippedPlaceholder: "本次未输出摘录",
};

export interface CompiledCitationDocument {
  markdown: string;
  isEmpty: boolean;
  includedItemCount: number;
  hasSkeleton: boolean;
  citationSlices: readonly CitationSlice[];
  layoutSlices: readonly LayoutSlice[];
}

export interface OutlineLayoutItem {
  itemId: string;
  operationId: string;
  groupId: string | null;
  citationText?: string;
  note?: string;
  skipped?: boolean;
}

export interface OutlineLayoutInput {
  scope: "single" | "group" | "all";
  groups: readonly { id: string; name: string }[];
  items: readonly OutlineLayoutItem[];
  labels?: Partial<CitationDocumentLabels>;
}

export interface BoundaryIssue {
  code: "MARKDOWN_BOUNDARY_UNSAFE";
  itemId?: string;
  sliceId?: string;
  scope: "internal" | "target-context";
  reason: string;
}

const mdHtml = new MarkdownIt({ html: true });

const VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escapes Markdown/HTML control syntax so headings and notes stay plain text. */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/([\\[\]<>#`*_~!|])/g, "\\$1");
}

export function escapeSingleLineHeading(text: string): string {
  const singleLine = text.replace(/[\r\n]+/g, " ").trim();
  return escapeMarkdownText(singleLine);
}

export function formatNoteBlock(note: string, notePrefix = DEFAULT_DOCUMENT_LABELS.notePrefix): string {
  const lines = note
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.map((line) => `${notePrefix}${escapeMarkdownText(line)}`).join("\n");
}

function appendItemParts(parts: CitationLayoutPart[], item: OutlineLayoutItem): void {
  const text = item.citationText?.replace(/\r\n/g, "\n") ?? "";
  if (!text.trim()) return;
  parts.push({
    kind: "citation",
    id: `citation:${item.itemId}`,
    itemId: item.itemId,
    operationId: item.operationId,
    text,
  });
  if (item.note && item.note.trim()) {
    parts.push({
      kind: "note",
      id: `note:${item.itemId}`,
      itemId: item.itemId,
      text: item.note,
    });
  }
}

export function buildOutlineLayout(input: OutlineLayoutInput): CitationLayoutPart[] {
  const labels = { ...DEFAULT_DOCUMENT_LABELS, ...input.labels };
  const parts: CitationLayoutPart[] = [];

  if (input.scope === "single") {
    for (const item of input.items) {
      if (!item.skipped) appendItemParts(parts, item);
    }
    return parts;
  }

  if (input.scope === "group") {
    const group = input.groups[0];
    if (!group) return parts;
    const groupItems = input.items.filter((item) => item.groupId === group.id);
    const activeItems = groupItems.filter((item) => !item.skipped && item.citationText?.trim());
    parts.push({ kind: "heading", id: `heading:${group.id}`, text: group.name, groupId: group.id });
    if (groupItems.length === 0) {
      parts.push({
        kind: "placeholder",
        id: `placeholder:${group.id}`,
        text: labels.emptyGroupPlaceholder,
        reason: "empty-group",
        groupId: group.id,
      });
    } else if (activeItems.length === 0) {
      parts.push({
        kind: "placeholder",
        id: `placeholder:${group.id}`,
        text: labels.allSkippedPlaceholder,
        reason: "all-skipped",
        groupId: group.id,
      });
    } else {
      for (const item of activeItems) appendItemParts(parts, item);
    }
    return parts;
  }

  // "all" scope: non-empty collection area first, then all groups in saved order.
  const collectionActive = input.items.filter(
    (item) => item.groupId === null && !item.skipped && item.citationText?.trim(),
  );
  if (collectionActive.length > 0) {
    parts.push({ kind: "heading", id: "heading:collection", text: labels.collectionHeading, groupId: null });
    for (const item of collectionActive) appendItemParts(parts, item);
  }

  for (const group of input.groups) {
    const groupItems = input.items.filter((item) => item.groupId === group.id);
    const activeItems = groupItems.filter((item) => !item.skipped && item.citationText?.trim());
    parts.push({ kind: "heading", id: `heading:${group.id}`, text: group.name, groupId: group.id });
    if (groupItems.length === 0) {
      parts.push({
        kind: "placeholder",
        id: `placeholder:${group.id}`,
        text: labels.emptyGroupPlaceholder,
        reason: "empty-group",
        groupId: group.id,
      });
    } else if (activeItems.length === 0) {
      parts.push({
        kind: "placeholder",
        id: `placeholder:${group.id}`,
        text: labels.allSkippedPlaceholder,
        reason: "all-skipped",
        groupId: group.id,
      });
    } else {
      for (const item of activeItems) appendItemParts(parts, item);
    }
  }
  return parts;
}

export function compileCitationDocument(
  layout: readonly CitationLayoutPart[],
  labels?: Partial<CitationDocumentLabels>,
): CompiledCitationDocument {
  const notePrefix = labels?.notePrefix ?? DEFAULT_DOCUMENT_LABELS.notePrefix;
  const segments: string[] = [];
  const citationSlices: CitationSlice[] = [];
  const layoutSlices: LayoutSlice[] = [];
  let includedItemCount = 0;
  let hasSkeleton = false;
  let cursor = 0;

  for (const part of layout) {
    let rendered = "";
    if (part.kind === "heading") {
      const escaped = escapeSingleLineHeading(part.text);
      if (!escaped) continue;
      rendered = `## ${escaped}`;
      hasSkeleton = true;
    } else if (part.kind === "citation") {
      rendered = part.text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
      if (!rendered.trim()) continue;
      includedItemCount++;
    } else if (part.kind === "note") {
      rendered = formatNoteBlock(part.text, notePrefix);
      if (!rendered.trim()) continue;
    } else if (part.kind === "placeholder") {
      const escaped = escapeMarkdownText(part.text.replace(/[\r\n]+/g, " ").trim());
      if (!escaped) continue;
      rendered = escaped;
      hasSkeleton = true;
    }

    if (segments.length > 0) cursor += 2; // "\n\n" separator
    const from = cursor;
    const to = from + rendered.length;
    segments.push(rendered);
    cursor = to;

    if (part.kind === "citation") {
      citationSlices.push({ itemId: part.itemId, operationId: part.operationId, range: { from, to } });
      layoutSlices.push({ id: part.id, kind: part.kind, range: { from, to }, itemId: part.itemId, operationId: part.operationId });
    } else if (part.kind === "note") {
      layoutSlices.push({ id: part.id, kind: part.kind, range: { from, to }, itemId: part.itemId });
    } else {
      layoutSlices.push({ id: part.id, kind: part.kind, range: { from, to }, groupId: part.groupId });
    }
  }

  const markdown = segments.join("\n\n");
  return {
    markdown,
    isEmpty: !markdown.trim(),
    includedItemCount,
    hasSkeleton,
    citationSlices,
    layoutSlices,
  };
}

function tokenRange(source: string, offsets: readonly number[], map: [number, number]): TextRange {
  const startLine = map[0];
  let endLine = map[1];
  while (endLine > startLine + 1 && !source.slice(offsets[endLine - 1], offsets[endLine] ?? source.length).trim()) {
    endLine--;
  }
  const from = offsets[startLine];
  let to = offsets[endLine] ?? source.length;
  if (source[to - 1] === "\n") to--;
  if (source[to - 1] === "\r") to--;
  return { from, to };
}

function isClosedFence(rawSlice: string, markup: string): boolean {
  const lines = rawSlice.split("\n");
  if (lines.length < 2) return false;
  const char = escapeRegExp(markup[0]);
  const pattern = new RegExp(`^ {0,3}${char}{${markup.length},}[ \\t]*$`);
  return pattern.test(lines[lines.length - 1]);
}

function scanHtmlBalance(
  htmlChunks: readonly string[],
  ignoreUnclosedTags = false,
): { ok: boolean; unclosedComment: boolean; unclosedTags: string[] } {
  const combined = htmlChunks.join("\n");
  // Check HTML comments outside tag scanning first.
  let pos = 0;
  let stripped = "";
  while (pos < combined.length) {
    const commentStart = combined.indexOf("<!--", pos);
    if (commentStart < 0) {
      stripped += combined.slice(pos);
      break;
    }
    stripped += combined.slice(pos, commentStart);
    const commentEnd = combined.indexOf("-->", commentStart + 4);
    if (commentEnd < 0) {
      return { ok: false, unclosedComment: true, unclosedTags: [] };
    }
    pos = commentEnd + 3;
  }

  if (ignoreUnclosedTags) {
    return { ok: true, unclosedComment: false, unclosedTags: [] };
  }

  const stack: string[] = [];
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9-]*)(\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = tagRe.exec(stripped)) !== null) {
    // Reject incomplete opening `<tag` before a matched tag.
    if (stripped.slice(lastEnd, match.index).includes("<")) {
      return { ok: false, unclosedComment: false, unclosedTags: ["<incomplete>"] };
    }
    lastEnd = match.index + match[0].length;
    const full = match[0];
    const name = match[1].toLowerCase();
    if (full.startsWith("</")) {
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.splice(idx);
      else return { ok: false, unclosedComment: false, unclosedTags: [`</${name}>`] };
    } else if (!full.endsWith("/>") && !VOID_HTML_TAGS.has(name)) {
      stack.push(name);
    }
  }
  if (/<[A-Za-z][^>]*$/.test(stripped.slice(lastEnd))) {
    return { ok: false, unclosedComment: false, unclosedTags: ["<incomplete>"] };
  }
  return { ok: stack.length === 0, unclosedComment: false, unclosedTags: stack };
}

function collectHtmlChunks(
  tokens: readonly Token[],
  source: string,
  offsets: readonly number[],
  fromBound: number,
  toBound: number,
): { outsideBlockquote: string[]; insideBlockquote: string[]; plainLines: string[] } {
  const outsideBlockquote: string[] = [];
  const insideBlockquote: string[] = [];
  const plainLines: string[] = [];
  let blockquoteDepth = 0;

  for (const token of tokens) {
    if (token.type === "blockquote_open") blockquoteDepth++;
    if (token.type === "blockquote_close") blockquoteDepth = Math.max(0, blockquoteDepth - 1);
    if (!token.map) continue;
    const range = tokenRange(source, offsets, token.map);
    if (range.to <= fromBound || range.from >= toBound) continue;

    if (token.type === "html_block") {
      if (blockquoteDepth > 0) insideBlockquote.push(token.content);
      else outsideBlockquote.push(token.content);
    } else if (token.type === "inline" && token.children) {
      const target = blockquoteDepth > 0 ? insideBlockquote : outsideBlockquote;
      for (const child of token.children) {
        if (child.type === "html_inline") target.push(child.content);
        else if (child.type === "text") plainLines.push(child.content);
      }
    }
  }
  return { outsideBlockquote, insideBlockquote, plainLines };
}

function validateSlicesInDocument(
  fullText: string,
  shiftedSlices: readonly LayoutSlice[],
  contentFrom: number,
  contentTo: number,
  scope: "internal" | "target-context",
): BoundaryIssue[] {
  const issues: BoundaryIssue[] = [];
  const offsets = lineOffsets(fullText);
  const tokens = mdHtml.parse(fullText, {});
  const seen = new Set<string>();
  const pushIssue = (issue: BoundaryIssue) => {
    const key = `${issue.scope}:${issue.sliceId ?? ""}:${issue.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  // 1. Verify no block token crosses out of its owning slice or across insertion boundaries.
  let blockquoteDepth = 0;
  for (const token of tokens) {
    if (token.type === "blockquote_open") blockquoteDepth++;
    if (token.type === "blockquote_close") blockquoteDepth = Math.max(0, blockquoteDepth - 1);
    if (!token.map) continue;
    const range = tokenRange(fullText, offsets, token.map);

    // Check target-context boundary crossings.
    if (scope === "target-context") {
      if (range.from < contentFrom && range.to > contentFrom) {
        pushIssue({ code: "MARKDOWN_BOUNDARY_UNSAFE", scope, reason: "Target prefix block swallows inserted content" });
      }
      if (range.from >= contentFrom && range.from < contentTo && range.to > contentTo) {
        const owner = shiftedSlices.find((s) => range.from >= s.range.from && range.from < s.range.to);
        pushIssue({
          code: "MARKDOWN_BOUNDARY_UNSAFE",
          scope,
          itemId: owner?.itemId,
          sliceId: owner?.id,
          reason: "Inserted block swallows target after-text",
        });
      }
    }

    // Only inspect non-container tokens or container tokens other than outer citation-only blockquotes.
    const isOuterBlockquote = token.type === "blockquote_open" && token.level === 0;
    if (isOuterBlockquote) {
      const covered = shiftedSlices.filter((s) => s.range.to > range.from && s.range.from < range.to);
      if (covered.some((s) => s.kind !== "citation")) {
        const owner = covered.find((s) => s.kind === "citation") ?? covered[0];
        pushIssue({
          code: "MARKDOWN_BOUNDARY_UNSAFE",
          scope,
          itemId: owner?.itemId,
          sliceId: owner?.id,
          reason: "Blockquote container swallows heading, note, or placeholder",
        });
      }
      continue;
    }

    if (token.level === 0 || ["fence", "code_block", "html_block", "table_open", "heading_open", "paragraph_open"].includes(token.type)) {
      if (range.from >= contentFrom && range.to <= contentTo) {
        const overlapping = shiftedSlices.filter((s) => s.range.to > range.from && s.range.from < range.to);
        if (overlapping.length > 1) {
          const owner = overlapping[0];
          pushIssue({
            code: "MARKDOWN_BOUNDARY_UNSAFE",
            scope,
            itemId: owner.itemId,
            sliceId: owner.id,
            reason: `Token ${token.type} spans multiple layout slices`,
          });
        }
      }
    }

    // Top-level fence inside a slice that was never closed (runs to end of slice/EOF).
    if (token.type === "fence" && blockquoteDepth === 0 && range.from >= contentFrom && range.to <= contentTo) {
      const owner = shiftedSlices.find((s) => range.from >= s.range.from && range.to <= s.range.to);
      if (owner && !isClosedFence(fullText.slice(range.from, range.to), token.markup)) {
        pushIssue({
          code: "MARKDOWN_BOUNDARY_UNSAFE",
          scope,
          itemId: owner.itemId,
          sliceId: owner.id,
          reason: "Unclosed code fence",
        });
      }
    }
  }

  // 2. Verify each heading, note, and placeholder kept its expected top-level Markdown role.
  for (const slice of shiftedSlices) {
    if (slice.kind === "heading") {
      const matched = tokens.some((token) => {
        if (token.type !== "heading_open" || token.level !== 0 || !token.map) return false;
        const r = tokenRange(fullText, offsets, token.map);
        return r.from >= slice.range.from && r.to <= slice.range.to && token.tag === "h2";
      });
      if (!matched) {
        pushIssue({ code: "MARKDOWN_BOUNDARY_UNSAFE", scope, sliceId: slice.id, reason: "Heading swallowed by preceding block" });
      }
    } else if (slice.kind === "note" || slice.kind === "placeholder") {
      const matched = tokens.some((token) => {
        if (token.type !== "paragraph_open" || token.level !== 0 || !token.map) return false;
        const r = tokenRange(fullText, offsets, token.map);
        return r.from >= slice.range.from && r.to <= slice.range.to;
      });
      if (!matched) {
        pushIssue({
          code: "MARKDOWN_BOUNDARY_UNSAFE",
          scope,
          itemId: slice.itemId,
          sliceId: slice.id,
          reason: `${slice.kind} swallowed by preceding block`,
        });
      }
    }
  }

  // 3. Check raw HTML tags & comments per slice (and target prefix in target-context mode).
  if (scope === "target-context" && contentFrom > 0) {
    const prefixHtml = collectHtmlChunks(tokens, fullText, offsets, 0, contentFrom);
    const prefixCheck = scanHtmlBalance(prefixHtml.outsideBlockquote, false);
    const prefixComment = scanHtmlBalance([...prefixHtml.insideBlockquote, ...prefixHtml.plainLines], true);
    if (!prefixCheck.ok || !prefixComment.ok) {
      pushIssue({ code: "MARKDOWN_BOUNDARY_UNSAFE", scope, reason: "Target cursor sits inside unclosed HTML" });
    }
  }

  for (const slice of shiftedSlices) {
    if (slice.kind !== "citation") continue;
    const html = collectHtmlChunks(tokens, fullText, offsets, slice.range.from, slice.range.to);
    const outCheck = scanHtmlBalance(html.outsideBlockquote, false);
    const inCommentCheck = scanHtmlBalance(html.insideBlockquote, true);
    const plainCommentCheck = scanHtmlBalance(html.plainLines, true);
    if (!outCheck.ok || !inCommentCheck.ok || !plainCommentCheck.ok) {
      pushIssue({
        code: "MARKDOWN_BOUNDARY_UNSAFE",
        scope,
        itemId: slice.itemId,
        sliceId: slice.id,
        reason: outCheck.unclosedComment || inCommentCheck.unclosedComment || plainCommentCheck.unclosedComment
          ? "Unclosed HTML comment"
          : `Unclosed HTML tag (${outCheck.unclosedTags.join(", ")})`,
      });
    }
  }

  return issues;
}

export function checkMarkdownBoundaries(compiled: CompiledCitationDocument): readonly BoundaryIssue[] {
  if (compiled.isEmpty) return [];
  return validateSlicesInDocument(compiled.markdown, compiled.layoutSlices, 0, compiled.markdown.length, "internal");
}

export function computeTargetInsertion(
  baselineText: string,
  ticketRange: TextRange,
  markdown: string,
  block = true,
): { range: TextRange; text: string; prefixLength: number; suffixLength: number; contentRange: TextRange } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!block) {
    return {
      range: ticketRange,
      text: normalized,
      prefixLength: 0,
      suffixLength: 0,
      contentRange: { from: ticketRange.from, to: ticketRange.from + normalized.length },
    };
  }
  const before = baselineText.slice(0, ticketRange.from);
  const after = baselineText.slice(ticketRange.to);
  const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  return {
    range: ticketRange,
    text: prefix + normalized + suffix,
    prefixLength: prefix.length,
    suffixLength: suffix.length,
    contentRange: {
      from: ticketRange.from + prefix.length,
      to: ticketRange.from + prefix.length + normalized.length,
    },
  };
}

export function checkTargetInsertionBoundaries(
  baselineText: string,
  ticketRange: TextRange,
  compiled: CompiledCitationDocument,
  block = true,
): readonly BoundaryIssue[] {
  if (compiled.isEmpty) return [];
  const plan = computeTargetInsertion(baselineText, ticketRange, compiled.markdown, block);
  const predicted = baselineText.slice(0, plan.range.from) + plan.text + baselineText.slice(plan.range.to);
  const contentFrom = plan.contentRange.from;
  const contentTo = plan.contentRange.to;
  const shiftedSlices: LayoutSlice[] = compiled.layoutSlices.map((slice) => ({
    ...slice,
    range: { from: contentFrom + slice.range.from, to: contentFrom + slice.range.to },
  }));
  return validateSlicesInDocument(predicted, shiftedSlices, contentFrom, contentTo, "target-context");
}
