import type { App, TFile } from "obsidian";
import { TFolder } from "obsidian";
import type { VaultGateway } from "../infra/VaultGateway";
import type { CollectionIssue, CollectionItem, CollectionSnapshot, CollectionSource, DeskReadingState } from "./deskTypes";
import { createResolver } from "./sources/SourceResolver";
import { isExcluded } from "./sources/FolderSource";
import { buildCardModel } from "./CardModel";

export interface CollectionDeps {
  app: App;
  gateway: VaultGateway;
  fileRef(file: TFile): string;
  globalExcludeGlobs(): string[];
}

/** 元数据过滤：标题／标签／路径的字面包含匹配，不读取正文。 */
export function metadataFilter(items: readonly CollectionItem[], filter: string): CollectionItem[] {
  const keyword = filter.trim().toLowerCase();
  if (!keyword) return [...items];
  return items.filter((item) => `${item.title} ${item.tags.join(" ")} ${item.path}`.toLowerCase().includes(keyword));
}

/** 普通阅读的隐藏策略：默认排除隐藏项。 */
export function applyHidden(items: readonly CollectionItem[], dismissed: readonly string[], showHidden: boolean): CollectionItem[] {
  if (showHidden) return [...items];
  const hidden = new Set(dismissed);
  return items.filter((item) => !hidden.has(item.path));
}

function compare(a: CollectionItem, b: CollectionItem, state: DeskReadingState): number {
  let result = 0;
  if (state.sort === "name") result = a.title.localeCompare(b.title);
  else if (state.sort === "ctime") result = a.ctime - b.ctime;
  else result = a.mtime - b.mtime;
  if (result === 0) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return state.sortAsc ? result : -result;
}

/** 稳定排序：先按指定键与方向，再按完整路径升序打破同值；置顶分区在前。 */
export function stableSort(items: readonly CollectionItem[], state: DeskReadingState): CollectionItem[] {
  const pinned = new Set(state.pinned);
  const pinnedItems = items.filter((item) => pinned.has(item.path));
  const rest = items.filter((item) => !pinned.has(item.path));
  if (state.sort === "custom") {
    const rank = new Map<string, number>();
    state.customOrder.forEach((path, index) => { if (!rank.has(path)) rank.set(path, index); });
    const order = (a: CollectionItem, b: CollectionItem) => (rank.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.path) ?? Number.MAX_SAFE_INTEGER) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return [...pinnedItems.sort(order), ...rest.sort(order)];
  }
  return [...pinnedItems.sort((a, b) => compare(a, b, state)), ...rest.sort((a, b) => compare(a, b, state))];
}

/** 从完整集合派生普通阅读可见成员：过滤 → 隐藏 → 稳定排序。 */
export function deriveVisible(items: readonly CollectionItem[], state: DeskReadingState): CollectionItem[] {
  return stableSort(applyHidden(metadataFilter(items, state.filter), state.dismissed, state.showHidden), state);
}

function isMarkdown(file: TFile): boolean { return file.extension === "md"; }

function legalPath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
  return !path.split("/").some((part) => part === "..");
}

/** 合并全部有效来源与手动笔记，产出去重后的完整成员集合。 */
export class CollectionService {
  constructor(private deps: CollectionDeps) {}

  async resolve(source: CollectionSource, generation: number): Promise<CollectionSnapshot> {
    const issues: CollectionIssue[] = [];
    const globals = this.deps.globalExcludeGlobs();
    const merged = new Map<string, { file: TFile; ruleIds: Set<string>; manual: boolean }>();
    let ruleFailed = false;

    const add = (file: TFile, ruleId?: string, manual = false): void => {
      if (!(file instanceof Object) || !isMarkdown(file) || !legalPath(file.path)) return;
      if (isExcluded(file.path, globals)) return;
      if (source.targetPath && file.path === source.targetPath && !manual) return;
      const entry = merged.get(file.path) ?? { file, ruleIds: new Set<string>(), manual: false };
      if (ruleId) entry.ruleIds.add(ruleId);
      if (manual) entry.manual = true;
      merged.set(file.path, entry);
    };

    for (const rule of source.rules) {
      const validation = this.validateRule(rule.spec);
      if (validation) { issues.push({ ...validation, ruleId: rule.id }); ruleFailed = true; continue; }
      let resolver;
      try { resolver = createResolver(rule.spec.kind); } catch {
        issues.push({ category: "RULE_UNSUPPORTED", path: rule.spec.value, ruleId: rule.id }); ruleFailed = true; continue;
      }
      try {
        const anchor = rule.spec.anchorFile ? this.deps.gateway.getAbstractFileByPath(rule.spec.anchorFile) as TFile | null ?? undefined : undefined;
        const files = await resolver.resolve(rule.spec, {
          app: this.deps.app, gateway: this.deps.gateway, anchorFile: anchor ?? undefined, excludeGlobs: globals,
        });
        for (const file of files) add(file, rule.id);
      } catch {
        issues.push({ category: "RULE_INVALID", path: rule.spec.value, ruleId: rule.id }); ruleFailed = true;
      }
    }

    const blockedManual = new Set(source.blockedManualPaths ?? []);
    for (const rawPath of source.manualPaths) {
      if (blockedManual.has(rawPath)) {
        // 已观察到失效的手动项：同路径出现新文件也不自动承接。
        issues.push({ category: "IDENTITY_UNCONFIRMED", path: rawPath }); continue;
      }
      if (!legalPath(rawPath) || !rawPath.toLowerCase().endsWith(".md")) {
        issues.push({ category: "FILE_MISSING", path: rawPath }); continue;
      }
      const file = this.deps.gateway.getAbstractFileByPath(rawPath);
      if (file instanceof Object && isMarkdown(file as TFile)) add(file as TFile, undefined, true);
      else issues.push({ category: "FILE_MISSING", path: rawPath });
    }

    const items: CollectionItem[] = [];
    for (const entry of merged.values()) {
      const model = buildCardModel(this.deps.gateway, entry.file);
      items.push({
        fileRef: this.deps.fileRef(entry.file),
        path: entry.file.path,
        title: model.title,
        tags: model.tags,
        mtime: model.mtime,
        ctime: model.ctime,
        matchedRuleIds: [...entry.ruleIds],
        manual: entry.manual,
        file: entry.file,
      });
    }
    items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { generation, items, completeness: ruleFailed || issues.some((issue) => issue.category === "RULE_INVALID" || issue.category === "RULE_MISSING" || issue.category === "RULE_UNSUPPORTED") ? "partial" : "complete", issues };
  }

  private validateRule(spec: CollectionSource["rules"][number]["spec"]): Omit<CollectionIssue, "ruleId"> | undefined {
    if (spec.kind === "folder") {
      if (!spec.value.trim()) return { category: "RULE_INVALID", path: spec.value };
      if (spec.value.trim() !== "/") {
        const folder = this.deps.gateway.getAbstractFileByPath(spec.value.trim());
        // 无法查到路径时仍交给解析器按前缀解析，避免把宿主暂未加载的目录误判为缺失。
        if (folder !== null && folder !== undefined && !(folder instanceof TFolder)) return { category: "RULE_MISSING", path: spec.value };
      }
      return undefined;
    }
    if (spec.kind === "tag") return spec.value.trim() ? undefined : { category: "RULE_INVALID", path: spec.value };
    const anchorPath = spec.anchorFile ?? spec.value;
    if (!anchorPath) return { category: "RULE_MISSING", path: spec.value };
    const anchor = this.deps.gateway.getAbstractFileByPath(anchorPath);
    if (!(anchor instanceof Object) || !isMarkdown(anchor as TFile)) return { category: "RULE_MISSING", path: anchorPath };
    return undefined;
  }
}
