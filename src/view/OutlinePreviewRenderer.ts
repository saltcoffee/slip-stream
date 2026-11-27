import MarkdownIt from "markdown-it";
import type { Component } from "obsidian";

const mdParser = new MarkdownIt("commonmark", { html: true });
const PREVIEW_CHUNK_SIZE = 20;

export type MarkdownRenderer = (
  markdown: string,
  container: HTMLElement,
  sourcePath: string,
  component: Component,
) => Promise<void>;

export interface BatchedPreviewOptions {
  container: HTMLElement;
  markdown: string;
  targetPath: string;
  component: Component;
  renderer?: MarkdownRenderer;
  isStale: () => boolean;
}

/** Splits Markdown into complete top-level CommonMark blocks so fences, quotes, lists, and HTML stay intact. */
export function splitMarkdownBlocks(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return [];
  const lines = normalized.split("\n");
  const tokens = mdParser.parse(normalized, {});
  const blocks: string[] = [];
  let cursor = 0;

  for (const token of tokens) {
    if (token.level !== 0 || !token.map) continue;
    const start = Math.max(cursor, token.map[0]);
    const end = Math.max(start, token.map[1]);
    if (start > cursor) {
      const gap = lines.slice(cursor, start).join("\n").trim();
      if (gap) blocks.push(gap);
    }
    const block = lines.slice(start, end).join("\n").replace(/\n+$/, "");
    if (block.trim()) blocks.push(block);
    cursor = Math.max(cursor, end);
  }

  if (cursor < lines.length) {
    const tail = lines.slice(cursor).join("\n").trim();
    if (tail) blocks.push(tail);
  }
  return blocks;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\[\]<>#`*_~!|])/g, "$1");
}

function renderFallbackSingleBlock(container: HTMLElement, block: string): void {
  if (block.startsWith("## ")) {
    container.createEl("h2", { text: unescapeMarkdown(block.slice(3)) });
    return;
  }
  const fenceMatch = block.match(/^\s*(`{3,}|~{3,})/);
  if (fenceMatch) {
    const lines = block.split("\n");
    const marker = fenceMatch[1];
    const lastLine = lines.length > 1 ? lines[lines.length - 1].trim() : "";
    const hasClosing =
      lastLine.startsWith(marker[0].repeat(marker.length)) &&
      /^(?:`+|~+)\s*$/.test(lastLine);
    const code = lines.slice(1, hasClosing ? lines.length - 1 : lines.length).join("\n");
    container.createEl("pre").createEl("code", { text: code });
    return;
  }
  if (block.startsWith("> ")) {
    container.createEl("blockquote").createEl("p", {
      text: block.split("\n").map((line) => line.replace(/^>\s?/, "")).join("\n"),
    });
    return;
  }
  if (block.trim()) {
    container.createEl("p", { text: unescapeMarkdown(block) });
  }
}

/** Renders complete top-level Markdown blocks in batches without splitting syntax blocks across chunks. */
export function renderFallbackBlocks(container: HTMLElement, markdown: string): void {
  const blocks = splitMarkdownBlocks(markdown);
  for (let i = 0; i < blocks.length; i += PREVIEW_CHUNK_SIZE) {
    const chunkEl = container.createDiv({ cls: "slipstream-outline-rendered-chunk" });
    for (const block of blocks.slice(i, i + PREVIEW_CHUNK_SIZE)) {
      renderFallbackSingleBlock(chunkEl, block);
    }
  }
}

/** Renders Markdown preview by rendering full context once (preserving document-level definitions) and mounting DOM in batches. */
export async function renderPreviewBatched(options: BatchedPreviewOptions): Promise<void> {
  const { container, markdown, targetPath, component, renderer, isStale } = options;
  if (renderer) {
    const staging = container.ownerDocument.createElement("div");
    try {
      await renderer(markdown, staging, targetPath, component);
    } catch {
      if (!isStale()) {
        container.empty();
        renderFallbackBlocks(container, markdown);
      }
      return;
    }
    if (isStale()) return;
    const nodes = Array.from(staging.childNodes);
    for (let i = 0; i < nodes.length; i += PREVIEW_CHUNK_SIZE) {
      if (isStale()) return;
      const frag = container.ownerDocument.createDocumentFragment();
      for (const node of nodes.slice(i, i + PREVIEW_CHUNK_SIZE)) frag.appendChild(node);
      container.appendChild(frag);
      if (i + PREVIEW_CHUNK_SIZE < nodes.length) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
    return;
  }

  const blocks = splitMarkdownBlocks(markdown);
  for (let i = 0; i < blocks.length; i += PREVIEW_CHUNK_SIZE) {
    if (isStale()) return;
    const chunkEl = container.createDiv({ cls: "slipstream-outline-rendered-chunk" });
    for (const block of blocks.slice(i, i + PREVIEW_CHUNK_SIZE)) {
      renderFallbackSingleBlock(chunkEl, block);
    }
    if (i + PREVIEW_CHUNK_SIZE < blocks.length) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
}
