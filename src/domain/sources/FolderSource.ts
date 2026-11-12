import type { TFile } from "obsidian";
import type { SourceSpec } from "../types";
import type { SourceContext, SourceResolver } from "./SourceResolver";
import { getLang } from "../../util/i18n";

function normalizeBase(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "/" : trimmed;
}

export function isExcluded(path: string, globs: string[]): boolean {
  for (const raw of globs) {
    const g = raw.trim();
    if (!g) continue;
    if (g.endsWith("/**")) {
      if (path.startsWith(g.slice(0, -3) + "/")) return true;
    } else if (g.startsWith("*.")) {
      if (path.endsWith(g.slice(1))) return true;
    } else if (g.includes("*")) {
      const re = new RegExp(
        "^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
      );
      if (re.test(path)) return true;
    } else if (path === g || path.startsWith(g + "/")) {
      return true;
    }
  }
  return false;
}

/** 文件夹数据源：该文件夹下所有 .md；可选含子文件夹 + 排除 glob。 */
export class FolderSource implements SourceResolver {
  readonly kind = "folder" as const;

  async resolve(spec: SourceSpec, ctx: SourceContext): Promise<TFile[]> {
    const base = normalizeBase(spec.value);
    // 双语示例/资料库约定：同时存在 zh/ 与 en/ 子目录时，按界面语言自动选择
    let effectiveBase = base;
    if (base !== "/") {
      const hasZh = !!ctx.app.vault.getAbstractFileByPath(`${base}/zh`);
      const hasEn = !!ctx.app.vault.getAbstractFileByPath(`${base}/en`);
      if (hasZh && hasEn) {
        effectiveBase = `${base}/${getLang()}`;
      }
    }
    const includeSub = spec.options?.includeSubfolders ?? true;
    const globs = spec.options?.excludeGlobs ?? [];
    return ctx.gateway.getMarkdownFiles().filter((f) => {
      if (effectiveBase !== "/" && !f.path.startsWith(effectiveBase + "/")) return false;
      if (!includeSub) {
        const parent = f.parent?.path ?? "/";
        if (parent !== effectiveBase) return false;
      }
      return !isExcluded(f.path, globs);
    });
  }
}
