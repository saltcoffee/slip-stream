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
  const fmTags: unknown = cache.frontmatter?.tags;
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
