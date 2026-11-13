import type { TFile } from "obsidian";
import type { VaultGateway } from "../infra/VaultGateway";
import type { SourceBlock } from "./types";

export interface CardModel {
  file: TFile;
  title: string;
  path: string;
  mtime: number;
  ctime: number;
  wordCount: number;
  tags: string[];
  excerpt: string;
  highlights: string[];
  callouts: string[];
  frontmatter: Record<string, unknown>;
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

function collectTags(gateway: VaultGateway, file: TFile): string[] {
  const cache = gateway.getFileCache(file);
  if (!cache) return [];
  const out: string[] = [];
  for (const t of cache.tags ?? []) out.push(normalizeTag(t.tag));
  const fmTags = cache.frontmatter?.tags;
  if (typeof fmTags === "string") out.push(normalizeTag(fmTags));
  else if (Array.isArray(fmTags)) {
    for (const v of fmTags) if (typeof v === "string") out.push(normalizeTag(v));
  }
  return Array.from(new Set(out));
}

export function buildCardModel(gateway: VaultGateway, file: TFile): CardModel {
  const cache = gateway.getFileCache(file);
  const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  const title = typeof fm.title === "string" && fm.title ? fm.title : file.basename;
  return {
    file,
    title,
    path: file.path,
    mtime: file.stat.mtime,
    ctime: file.stat.ctime,
    wordCount: 0,
    tags: collectTags(gateway, file),
    excerpt: "",
    highlights: [],
    callouts: [],
    frontmatter: fm,
  };
}

export interface Snippet {
  text: string;
  block: SourceBlock;
}

function snippetText(source: string): string {
  return source
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, "")
    .replace(/^>\s*\[![^\]]+\][+-]?\s*.*$/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/==/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s*\^[A-Za-z0-9-]{4,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 摘要在抽取时保留原始块，避免用清理后的展示文本反查源码。 */
export function extractSnippet(
  source: string,
  blocks: SourceBlock[],
  excerptLength: number,
  includeHighlights: boolean,
  includeCallouts: boolean,
  calloutLimit: number
): { excerpt?: Snippet; highlights: Snippet[]; callouts: Snippet[]; wordCount: number } {
  const lines = source.split("\n");
  const blockAt = (line: number) => blocks.find((b) => b.startLine <= line && line < b.endLine);
  const highlights: Snippet[] = [];
  if (includeHighlights) {
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/==([^=\n]+)==/g)) {
        const block = blockAt(index);
        if (block) highlights.push({ text: match[1].trim(), block });
      }
    });
  }

  const callouts: Snippet[] = [];
  if (includeCallouts) {
    for (let i = 0; i < lines.length; i++) {
      const start = /^>\s*\[![^\]]+\][+-]?\s*(.*)$/.exec(lines[i]);
      if (!start) continue;
      const block = blockAt(i);
      if (!block) continue;
      const parts = [start[1]];
      let j = i + 1;
      while (j < lines.length && /^>/.test(lines[j])) {
        parts.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text) callouts.push({ text: text.slice(0, calloutLimit), block });
      i = j - 1;
    }
  }

  let excerpt: Snippet | undefined;
  for (const block of blocks) {
    const text = snippetText(block.content).split(/\n\s*\n/)[0].slice(0, excerptLength);
    if (text) {
      excerpt = { text, block };
      break;
    }
  }
  const wordCount = snippetText(source).replace(/\s+/g, "").length;
  return { excerpt, highlights, callouts, wordCount };
}
