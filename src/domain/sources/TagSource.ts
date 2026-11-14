import type { CachedMetadata, TFile } from "obsidian";
import type { SourceSpec } from "../types";
import type { SourceContext, SourceResolver } from "./SourceResolver";

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

function collectTags(cache: CachedMetadata | null): string[] {
  if (!cache) return [];
  const out: string[] = [];
  for (const t of cache.tags ?? []) {
    out.push(normalizeTag(t.tag));
  }
  const fmTags: unknown = cache.frontmatter?.tags;
  if (typeof fmTags === "string") {
    out.push(normalizeTag(fmTags));
  } else if (Array.isArray(fmTags)) {
    for (const v of fmTags) if (typeof v === "string") out.push(normalizeTag(v));
  }
  return out;
}

/** 标签数据源：命中 #tag 的所有笔记（含子标签）。 */
export class TagSource implements SourceResolver {
  readonly kind = "tag" as const;

  async resolve(spec: SourceSpec, ctx: SourceContext): Promise<TFile[]> {
    const wanted = normalizeTag(spec.value);
    if (!wanted) return [];
    const matchChildren = spec.options?.matchChildren ?? true;
    return ctx.gateway.getMarkdownFiles().filter((f) => {
      const tags = collectTags(ctx.gateway.getFileCache(f));
      return tags.some(
        (tag) => tag === wanted || (matchChildren && tag.startsWith(wanted + "/"))
      );
    });
  }
}
