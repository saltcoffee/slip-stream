import type { TFile } from "obsidian";
import type { VaultGateway } from "../infra/VaultGateway";

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

/** 摘要抽取：前 N 字 + 高亮 + Callout。 */
export function extractSnippet(
  source: string,
  excerptLength: number,
  includeHighlights: boolean,
  includeCallouts: boolean,
  calloutLimit: number
): { excerpt: string; highlights: string[]; callouts: string[]; wordCount: number } {
  const lines = source.split("\n");
  const plain = source
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

  const highlights: string[] = [];
  if (includeHighlights) {
    const re = /==([^=\n]+)==/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) highlights.push(m[1].trim());
  }

  const callouts: string[] = [];
  if (includeCallouts) {
    for (let i = 0; i < lines.length; i++) {
      const start = /^>\s*\[![^\]]+\][+-]?\s*(.*)$/.exec(lines[i]);
      if (!start) continue;
      const parts = [start[1]];
      let j = i + 1;
      while (j < lines.length && /^>/.test(lines[j])) {
        parts.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text) callouts.push(text.slice(0, calloutLimit));
      i = j - 1;
    }
  }

  const firstParagraph =
    plain.split(/\n\s*\n/).find((part) => part.trim().length > 0) ?? plain;
  const excerpt = firstParagraph.slice(0, excerptLength);
  const wordCount = plain.replace(/\s+/g, "").length;
  return { excerpt, highlights, callouts, wordCount };
}
