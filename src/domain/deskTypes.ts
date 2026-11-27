import type { TFile } from "obsidian";
import type { Density, SortKey, SourceSpec } from "./types";
import type { EvidenceOutline } from "./outlineTypes";
import { cloneOutline, emptyOutline } from "./outlineTypes";

/** 0.1.5 书桌与完整集合的中立领域类型；除运行期 file 句柄外均为可序列化值。 */

export type SupportedSourceKind = "folder" | "tag" | "backlinks" | "outlinks";
export const SUPPORTED_SOURCE_KINDS: readonly SupportedSourceKind[] = ["folder", "tag", "backlinks", "outlinks"];

export function isSupportedSourceKind(kind: string): kind is SupportedSourceKind {
  return (SUPPORTED_SOURCE_KINDS as readonly string[]).includes(kind);
}

export interface DeskRule {
  id: string;
  spec: Omit<SourceSpec, "kind"> & { kind: SupportedSourceKind };
}

export interface DeskReadingState {
  density: Density;
  filter: string;
  sort: SortKey;
  sortAsc: boolean;
  showHidden: boolean;
  pinned: string[];
  collapsed: string[];
  compactExpanded: string[];
  dismissed: string[];
  customOrder: string[];
}

export interface ReadingBlockHint {
  blockId?: string;
  heading?: string;
  rawOffset: number;
  before: string;
  after: string;
}

/** 尽力恢复阅读区域；不是写入位置，也绝不作为引用锚点。 */
export interface ReadingAnchor {
  filePath: string;
  blockHint?: ReadingBlockHint;
  cardRatio: number;
  viewportOffset: number;
  neighborPaths: string[];
}

export type UnresolvedScope = "target" | "rule" | "manual" | "card-state" | "reading-anchor";

export interface UnresolvedRef {
  path: string;
  kind: "file" | "folder";
  scope: UnresolvedScope;
  /** scope=rule 时必填，其他 scope 不填写。 */
  ruleId?: string;
  reason: "missing" | "identity-unconfirmed";
}

export interface Desk {
  id: string;
  name: string;
  targetPath: string;
  rules: DeskRule[];
  manualPaths: string[];
  reading: DeskReadingState;
  anchor?: ReadingAnchor;
  unresolvedRefs: UnresolvedRef[];
  outline: EvidenceOutline;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export type DeskV3 = Desk;

export const MAX_DESK_NAME = 80;

export function defaultReadingState(overrides: Partial<DeskReadingState> = {}): DeskReadingState {
  return {
    density: "snippet",
    filter: "",
    sort: "mtime",
    sortAsc: false,
    showHidden: false,
    pinned: [],
    collapsed: [],
    compactExpanded: [],
    dismissed: [],
    customOrder: [],
    ...overrides,
  };
}

/** 去首尾空白后的书桌名称；空或超长视为无效。 */
export function normalizeDeskName(raw: string): string {
  return raw.trim();
}

export function isValidDeskName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_DESK_NAME;
}

/** 判定两条来源规则是否完全相同（用于去重，不修改原文）。 */
export function ruleSignature(spec: DeskRule["spec"]): string {
  const options = spec.options ?? {};
  return JSON.stringify([spec.kind, spec.value.trim(), spec.anchorFile ?? "", options.includeSubfolders ?? true,
    options.matchChildren ?? true, [...(options.excludeGlobs ?? [])].sort()]);
}

export function createDeskRule(spec: DeskRule["spec"]): DeskRule {
  return { id: `rule-${crypto.randomUUID()}`, spec };
}

export interface CreateDeskInput {
  id?: string;
  name: string;
  targetPath: string;
  rules?: DeskRule[];
  manualPaths?: string[];
  reading?: Partial<DeskReadingState>;
  outline?: EvidenceOutline;
}

export function createDesk(input: CreateDeskInput, now = Date.now()): Desk {
  return {
    id: input.id ?? `desk-${crypto.randomUUID()}`,
    name: normalizeDeskName(input.name),
    targetPath: input.targetPath,
    rules: input.rules ? [...input.rules] : [],
    manualPaths: input.manualPaths ? [...input.manualPaths] : [],
    reading: defaultReadingState(input.reading),
    unresolvedRefs: [],
    outline: input.outline ? cloneOutline(input.outline) : emptyOutline(),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 完整集合的运行期模型：完整成员描述，不包含文件正文。
// ---------------------------------------------------------------------------

export interface CollectionItem {
  fileRef: string;
  path: string;
  title: string;
  tags: readonly string[];
  mtime: number;
  ctime: number;
  matchedRuleIds: readonly string[];
  manual: boolean;
  /** 运行期文件句柄，不写入持久化数据。 */
  file: TFile;
}

export type CollectionIssueCategory =
  | "RULE_INVALID"
  | "RULE_MISSING"
  | "RULE_UNSUPPORTED"
  | "FILE_MISSING"
  | "IDENTITY_UNCONFIRMED";

export interface CollectionIssue {
  category: CollectionIssueCategory;
  path: string;
  ruleId?: string;
}

export interface CollectionSnapshot {
  generation: number;
  items: readonly CollectionItem[];
  completeness: "complete" | "partial";
  issues: readonly CollectionIssue[];
}

/** 临时浏览使用与书桌相同的来源组合与阅读模型，但没有目标、不写入 desks。 */
export interface CollectionSource {
  rules: DeskRule[];
  manualPaths: string[];
  targetPath?: string;
  /** 身份待确认或已知失效的手动项，不得被同路径新文件自动承接。 */
  blockedManualPaths?: string[];
}

export interface CollectionResult {
  snapshot: CollectionSnapshot;
}

export function cloneReadingState(state: DeskReadingState): DeskReadingState {
  return {
    density: state.density,
    filter: state.filter,
    sort: state.sort,
    sortAsc: state.sortAsc,
    showHidden: state.showHidden,
    pinned: [...state.pinned],
    collapsed: [...state.collapsed],
    compactExpanded: [...state.compactExpanded],
    dismissed: [...state.dismissed],
    customOrder: [...state.customOrder],
  };
}

export function cloneDesk(desk: Desk): Desk {
  return {
    ...desk,
    rules: desk.rules.map((rule) => ({ id: rule.id, spec: { ...rule.spec, options: rule.spec.options ? { ...rule.spec.options, excludeGlobs: rule.spec.options.excludeGlobs ? [...rule.spec.options.excludeGlobs] : undefined } : undefined } })),
    manualPaths: [...desk.manualPaths],
    reading: cloneReadingState(desk.reading),
    anchor: desk.anchor ? { ...desk.anchor, blockHint: desk.anchor.blockHint ? { ...desk.anchor.blockHint } : undefined, neighborPaths: [...desk.anchor.neighborPaths] } : undefined,
    unresolvedRefs: desk.unresolvedRefs.map((ref) => ({ ...ref })),
    outline: cloneOutline(desk.outline),
  };
}
