import type { SourceSpec } from "../types";
import { TFile } from "obsidian";
import type { SourceContext, SourceResolver } from "./SourceResolver";

/** 双链数据源：backlinks（入链）/ outlinks（出链）。 */
export class LinkSource implements SourceResolver {
  constructor(public readonly kind: "backlinks" | "outlinks") {}

  async resolve(spec: SourceSpec, ctx: SourceContext): Promise<TFile[]> {
    const anchor = this.resolveAnchor(spec, ctx);
    if (!anchor) return [];

    if (this.kind === "outlinks") {
      const cache = ctx.gateway.getFileCache(anchor);
      const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
      const result: TFile[] = [];
      const seen = new Set<string>();
      for (const link of links) {
        const dest = ctx.gateway.getFirstLinkpathDest(link.link, anchor.path);
        if (dest && dest.path !== anchor.path && !seen.has(dest.path)) {
          seen.add(dest.path);
          result.push(dest);
        }
      }
      return result;
    }

    const resolved = ctx.gateway.getResolvedLinks();
    const result: TFile[] = [];
    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (sourcePath === anchor.path) continue;
      if (targets[anchor.path]) {
        const file = ctx.gateway.getAbstractFileByPath(sourcePath);
        if (file instanceof TFile) result.push(file);
      }
    }
    return result;
  }

  private resolveAnchor(spec: SourceSpec, ctx: SourceContext): TFile | null {
    if (spec.anchorFile) {
      const file = ctx.gateway.getAbstractFileByPath(spec.anchorFile);
      if (file instanceof TFile) return file;
    }
    return ctx.anchorFile ?? null;
  }
}
