import { DEFAULT_SETTINGS } from "../settings/settings";
import type { Settings } from "../settings/settings";
import type { CitationHistoryEntry, CitationRelation } from "../domain/citationTypes";
import { validRange } from "../domain/citationTypes";
import type { Desk, DeskReadingState, DeskRule, ReadingAnchor, UnresolvedRef } from "../domain/deskTypes";
import { defaultReadingState, isSupportedSourceKind, isValidDeskName, normalizeDeskName } from "../domain/deskTypes";

export interface PersistedDataV2 extends Record<string, unknown> {
  schemaVersion: 2;
  settings: Settings;
  history: CitationHistoryEntry[];
  relations: CitationRelation[];
  consent: { blockIdExplanationAccepted: boolean };
  desks: Desk[];
}

/** 兼容旧类型名，外部只依赖“根状态对象”。 */
export type PersistedData = PersistedDataV2;

export interface SaveReceipt {
  persistedRevision: number;
}

interface DataPort {
  load(): Promise<unknown>;
  save(data: PersistedDataV2): Promise<void>;
  backup(raw: unknown): Promise<void>;
}

export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const enums: Partial<Record<keyof Settings, readonly string[]>> = {
  language: ["auto", "zh", "en"], defaultDensity: ["full", "snippet", "compact"],
  defaultPlacement: ["right-sidebar", "split"], defaultTemplate: ["A", "B", "C", "D"],
  selectionBehavior: ["replace", "append"], renderMode: ["block", "whole"], cardWidth: ["narrow", "medium", "wide", "auto"],
};
const bounds: Partial<Record<keyof Settings, [number, number]>> = {
  collectionPageSize: [1, 100000], excerptLength: [20, 100000], snippetCalloutLimit: [40, 100000],
  historyLimit: [1, 100000], renderConcurrency: [1, 8], fontScale: [0.8, 1.6],
};

/** 校验并规范化设置；兼容旧版 collectionLimit → collectionPageSize。 */
export function validateSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!object(raw)) return out;
  const source = { ...raw } as Record<string, unknown>;
  if (source.collectionPageSize === undefined && typeof source.collectionLimit === "number") {
    source.collectionPageSize = source.collectionLimit;
  }
  for (const key of Object.keys(out) as Array<keyof Settings>) {
    const value = source[key];
    if (typeof value !== typeof out[key]) continue;
    const options = enums[key];
    if (options && (typeof value !== "string" || !options.includes(value))) continue;
    const range = bounds[key];
    if (typeof value === "number" && (!Number.isFinite(value) || range && (value < range[0] || value > range[1]) || key !== "fontScale" && !Number.isInteger(value))) continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

function settingsNormalized(raw: unknown): boolean {
  if (!object(raw)) return raw !== undefined;
  const validated = validateSettings(raw);
  const merged = { ...raw } as Record<string, unknown>;
  if (merged.collectionPageSize === undefined && typeof merged.collectionLimit === "number") return true;
  return Object.keys(validated).some((key) => merged[key] !== undefined && merged[key] !== (validated as unknown as Record<string, unknown>)[key]) ||
    Object.keys(merged).some((key) => key !== "collectionLimit" && !Object.hasOwn(validated, key) && merged[key] !== undefined);
}

function historyEntry(raw: unknown, legacy: boolean): CitationHistoryEntry | undefined {
  if (!object(raw) || typeof raw.id !== "string" || typeof raw.at !== "number" || !Number.isFinite(raw.at) ||
    typeof raw.sourcePath !== "string" || typeof raw.template !== "string" || typeof raw.snippet !== "string") return;
  const entry: CitationHistoryEntry = { id: raw.id, operationId: typeof raw.operationId === "string" ? raw.operationId : `legacy:${raw.id}`,
    at: raw.at, action: legacy ? "legacy-unknown" : ["insert", "copy", "legacy-unknown"].includes(String(raw.action)) ? raw.action as CitationHistoryEntry["action"] : "legacy-unknown",
    sourcePath: raw.sourcePath, template: raw.template, snippet: raw.snippet };
  for (const key of ["targetPath", "blockId", "heading", "text", "relationId"] as const) if (typeof raw[key] === "string") entry[key] = raw[key];
  if (entry.action === "copy") delete entry.targetPath;
  if (["block", "fragment", "multi-block-start", "heading", "file"].includes(String(raw.precision))) entry.precision = raw.precision as CitationHistoryEntry["precision"];
  return entry;
}
function relation(raw: unknown): raw is CitationRelation {
  if (!object(raw) || !["id", "operationId", "sourcePath", "targetPath", "content", "insertedText"].every((k) => typeof raw[k] === "string") ||
    typeof raw.at !== "number" || !Number.isFinite(raw.at) || !["A", "B", "C", "D"].includes(String(raw.template)) ||
    !["verified", "stale-snapshot"].includes(String(raw.sourceState)) || !["block", "fragment", "multi-block-start", "heading", "file"].includes(String(raw.precision))) return false;
  if (!Array.isArray(raw.sourceSpans) || !raw.sourceSpans.every((s) => object(s) && typeof s.rawText === "string" && object(s.range) &&
    validRange(s.range as unknown as { from: number; to: number }, Number.MAX_SAFE_INTEGER) &&
    ["paragraph", "list", "list_item", "heading", "callout", "blockquote", "code", "table", "other"].includes(String(s.kind)))) return false;
  return object(raw.targetHint) && object(raw.targetHint.range) && validRange(raw.targetHint.range as unknown as { from: number; to: number }, Number.MAX_SAFE_INTEGER) &&
    typeof raw.targetHint.before === "string" && typeof raw.targetHint.after === "string";
}

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

function finiteTime(raw: unknown, fallback = 0): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

interface DeskParse { desk?: Desk; changed: boolean; invalid?: string }

function parseReading(raw: unknown): { reading: DeskReadingState; changed: boolean } {
  const base = defaultReadingState();
  if (!object(raw)) return { reading: base, changed: true };
  const reading: DeskReadingState = {
    density: ["full", "snippet", "compact"].includes(String(raw.density)) ? raw.density as DeskReadingState["density"] : base.density,
    filter: typeof raw.filter === "string" ? raw.filter : base.filter,
    sort: ["mtime", "ctime", "name", "custom"].includes(String(raw.sort)) ? raw.sort as DeskReadingState["sort"] : base.sort,
    sortAsc: typeof raw.sortAsc === "boolean" ? raw.sortAsc : base.sortAsc,
    showHidden: typeof raw.showHidden === "boolean" ? raw.showHidden : base.showHidden,
    pinned: [...new Set(stringArray(raw.pinned))],
    collapsed: [...new Set(stringArray(raw.collapsed))],
    compactExpanded: [...new Set(stringArray(raw.compactExpanded))],
    dismissed: [...new Set(stringArray(raw.dismissed))],
    customOrder: stringArray(raw.customOrder),
  };
  const changed = JSON.stringify(reading) !== JSON.stringify(raw);
  return { reading, changed };
}

function parseRule(raw: unknown): { rule?: DeskRule; changed: boolean; invalid: boolean } {
  if (!object(raw) || typeof raw.id !== "string" || !raw.id || !object(raw.spec) ||
    !isSupportedSourceKind(String(raw.spec.kind)) || typeof raw.spec.value !== "string") return { changed: false, invalid: true };
  const spec = raw.spec;
  const options = object(spec.options) ? spec.options : undefined;
  const rule: DeskRule = {
    id: raw.id,
    spec: {
      kind: spec.kind as DeskRule["spec"]["kind"],
      value: spec.value as string,
      ...(typeof spec.anchorFile === "string" ? { anchorFile: spec.anchorFile } : {}),
      ...(options ? {
        options: {
          ...(typeof options.includeSubfolders === "boolean" ? { includeSubfolders: options.includeSubfolders } : {}),
          ...(typeof options.matchChildren === "boolean" ? { matchChildren: options.matchChildren } : {}),
          ...(Array.isArray(options.excludeGlobs) ? { excludeGlobs: stringArray(options.excludeGlobs) } : {}),
        },
      } : {}),
    },
  };
  return { rule, changed: false, invalid: false };
}

function parseAnchor(raw: unknown): { anchor?: ReadingAnchor; changed: boolean } {
  if (!object(raw) || typeof raw.filePath !== "string" || !raw.filePath) return { changed: raw !== undefined };
  const before = typeof raw.before === "string" ? raw.before : "";
  const after = typeof raw.after === "string" ? raw.after : "";
  const hintRaw = object(raw.blockHint) ? raw.blockHint : undefined;
  const hint = hintRaw ? {
    ...(typeof hintRaw.blockId === "string" ? { blockId: hintRaw.blockId } : {}),
    ...(typeof hintRaw.heading === "string" ? { heading: hintRaw.heading } : {}),
    rawOffset: Math.max(0, finiteTime(hintRaw.rawOffset)),
    before: before.slice(0, 80),
    after: after.slice(0, 80),
  } : undefined;
  const ratio = typeof raw.cardRatio === "number" && Number.isFinite(raw.cardRatio) ? Math.min(1, Math.max(0, raw.cardRatio)) : 0;
  const offset = finiteTime(raw.viewportOffset);
  const anchor: ReadingAnchor = {
    filePath: raw.filePath,
    ...(hint ? { blockHint: hint } : {}),
    cardRatio: ratio,
    viewportOffset: offset,
    neighborPaths: stringArray(raw.neighborPaths).slice(0, 2),
  };
  return { anchor, changed: false };
}

const SCOPES = ["target", "rule", "manual", "card-state", "reading-anchor"] as const;

function parseUnresolved(raw: unknown): UnresolvedRef | undefined {
  if (!object(raw) || typeof raw.path !== "string" || !SCOPES.includes(String(raw.scope) as UnresolvedRef["scope"])) return;
  if (raw.kind !== "file" && raw.kind !== "folder") return;
  if (raw.reason !== "missing" && raw.reason !== "identity-unconfirmed") return;
  const ref: UnresolvedRef = { path: raw.path, kind: raw.kind, scope: raw.scope as UnresolvedRef["scope"], reason: raw.reason };
  if (typeof raw.ruleId === "string") ref.ruleId = raw.ruleId;
  return ref;
}

function parseDesk(raw: unknown, seen: Set<string>): DeskParse {
  if (!object(raw)) return { changed: false, invalid: "data.invalidDesks" };
  if (typeof raw.id !== "string" || !raw.id) return { changed: false, invalid: "data.invalidDesks" };
  if (seen.has(raw.id)) return { changed: false, invalid: "data.invalidDesks" };
  seen.add(raw.id);
  if (typeof raw.name !== "string" || !isValidDeskName(raw.name)) return { changed: false, invalid: "data.invalidDesks" };
  if (typeof raw.targetPath !== "string") return { changed: false, invalid: "data.invalidDesks" };
  if (!Array.isArray(raw.rules) || !Array.isArray(raw.manualPaths)) return { changed: false, invalid: "data.invalidDesks" };
  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt) ||
    typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt) ||
    typeof raw.lastOpenedAt !== "number" || !Number.isFinite(raw.lastOpenedAt)) return { changed: false, invalid: "data.invalidDesks" };
  const rules: DeskRule[] = [];
  let changed = false;
  for (const rawRule of raw.rules) {
    const parsed = parseRule(rawRule);
    if (parsed.invalid) return { changed: false, invalid: "data.invalidDesks" };
    if (parsed.rule) rules.push(parsed.rule);
    changed = changed || parsed.changed;
  }
  const manualPaths = stringArray(raw.manualPaths);
  if (manualPaths.length !== raw.manualPaths.length) changed = true;
  const { reading, changed: readingChanged } = parseReading(raw.reading);
  changed = changed || readingChanged;
  const { anchor, changed: anchorChanged } = parseAnchor(raw.anchor);
  changed = changed || anchorChanged;
  const unresolvedRefs = Array.isArray(raw.unresolvedRefs)
    ? raw.unresolvedRefs.map(parseUnresolved).filter((value): value is UnresolvedRef => !!value) : [];
  if (Array.isArray(raw.unresolvedRefs) && unresolvedRefs.length !== raw.unresolvedRefs.length) changed = true;
  const desk: Desk = {
    id: raw.id,
    name: normalizeDeskName(raw.name),
    targetPath: raw.targetPath,
    rules,
    manualPaths,
    reading,
    ...(anchor ? { anchor } : {}),
    unresolvedRefs,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastOpenedAt: raw.lastOpenedAt,
  };
  if (desk.name !== raw.name) changed = true;
  return { desk, changed };
}

interface V2Parse {
  data: PersistedDataV2;
  changed: boolean;
  invalid?: string;
}

function parseV2(raw: Record<string, unknown>): V2Parse {
  const legacy = false;
  const history = Array.isArray(raw.history) ? raw.history.map((r) => historyEntry(r, legacy)).filter((r): r is CitationHistoryEntry => !!r) : [];
  const relations = Array.isArray(raw.relations) ? raw.relations.filter(relation) : [];
  let changed = false;
  if (raw.history !== undefined && (!Array.isArray(raw.history) || history.length !== raw.history.length)) changed = true;
  if (raw.relations !== undefined && (!Array.isArray(raw.relations) || relations.length !== raw.relations.length)) changed = true;
  if (settingsNormalized(raw.settings)) changed = true;
  const desks: Desk[] = [];
  if (raw.desks !== undefined) {
    if (!Array.isArray(raw.desks)) return { data: emptyV2(), changed: false, invalid: "data.invalidDesks" };
    const seen = new Set<string>();
    for (const rawDesk of raw.desks) {
      const parsed = parseDesk(rawDesk, seen);
      if (parsed.invalid) return { data: emptyV2(), changed: false, invalid: parsed.invalid };
      if (parsed.desk) desks.push(parsed.desk);
      changed = changed || parsed.changed;
    }
  }
  const data: PersistedDataV2 = {
    ...raw,
    schemaVersion: 2,
    settings: validateSettings(raw.settings),
    history,
    relations,
    consent: { blockIdExplanationAccepted: object(raw.consent) && raw.consent.blockIdExplanationAccepted === true },
    desks,
  };
  return { data, changed };
}

function emptyV2(): PersistedDataV2 {
  return { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, history: [], relations: [], consent: { blockIdExplanationAccepted: false }, desks: [] };
}

/** Owns the only root state and obtains a fresh immutable snapshot when each save starts. */
export class PluginDataStore {
  data: PersistedDataV2 = { schemaVersion: 2, settings: { ...DEFAULT_SETTINGS }, history: [], relations: [], consent: { blockIdExplanationAccepted: false }, desks: [] };
  readOnly = false;
  warning = "";
  /** 运行时单调根修订号；不作为跨启动必须恢复的业务数据。 */
  private rootRevision = 0;
  private persisted = 0;
  private consentSaved = false;
  get blockIdConsentAccepted(): boolean { return this.consentSaved && !this.readOnly; }
  get revision(): number { return this.rootRevision; }
  get persistedRevision(): number { return this.persisted; }
  private tail: Promise<SaveReceipt> = Promise.resolve({ persistedRevision: 0 });
  constructor(private port: DataPort) {}

  /** 任何根数据修改都应调用，以便保存回执识别“是否已覆盖最新修改”。 */
  touch(): number { return ++this.rootRevision; }

  isPersisted(revision: number): boolean { return this.persisted >= revision && !this.readOnly; }

  async load(): Promise<void> {
    let raw: unknown;
    try { raw = await this.port.load(); } catch { this.readOnly = true; this.warning = "data.readonly"; return; }
    if (raw == null) return;
    if (!object(raw)) { this.readOnly = true; this.warning = "data.readonly"; return; }

    if (raw.schemaVersion === 2) {
      const parsed = parseV2(raw);
      if (parsed.invalid) {
        this.readOnly = true;
        this.warning = parsed.invalid;
        this.data.settings = validateSettings(raw.settings);
        return;
      }
      this.data = parsed.data;
      this.consentSaved = this.data.consent.blockIdExplanationAccepted;
      if (parsed.changed) {
        try { await this.port.backup(raw); } catch { this.readOnly = true; this.warning = "data.backupFailed"; return; }
        try { await this.save(); } catch { this.warning = "data.migrationFailed"; }
      }
      return;
    }

    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) { this.readOnly = true; this.warning = "data.readonly"; return; }

    // v0 (no schemaVersion) / v1 → v2，一次性备份后写入。
    const legacy = raw.schemaVersion === undefined;
    const history = Array.isArray(raw.history) ? raw.history.map((r) => historyEntry(r, legacy)).filter((r): r is CitationHistoryEntry => !!r) : [];
    const relations = !legacy && Array.isArray(raw.relations) ? raw.relations.filter(relation) : [];
    const invalid = raw.history !== undefined && (!Array.isArray(raw.history) || history.length !== raw.history.length) ||
      !legacy && raw.relations !== undefined && (!Array.isArray(raw.relations) || relations.length !== raw.relations.length);
    this.data = {
      ...raw,
      schemaVersion: 2,
      settings: validateSettings(raw.settings),
      history,
      relations,
      consent: { blockIdExplanationAccepted: !legacy && object(raw.consent) && raw.consent.blockIdExplanationAccepted === true },
      desks: [],
    };
    this.consentSaved = this.data.consent.blockIdExplanationAccepted;
    try { await this.port.backup(raw); } catch { this.readOnly = true; this.warning = "data.backupFailed"; return; }
    this.warning = invalid ? "data.invalidEntries" : "";
    try { await this.save(); } catch { this.warning = "data.migrationFailed"; }
  }

  save(): Promise<SaveReceipt> {
    const job = this.tail.catch(() => ({ persistedRevision: this.persisted })).then(async (): Promise<SaveReceipt> => {
      if (this.readOnly) throw new Error("DATA_READONLY");
      const frozen = this.rootRevision;
      const snapshot = JSON.parse(JSON.stringify(this.data)) as PersistedDataV2;
      await this.port.save(snapshot);
      this.persisted = Math.max(this.persisted, frozen);
      return { persistedRevision: this.persisted };
    });
    this.tail = job;
    return job;
  }
  async acceptBlockIds(): Promise<void> {
    if (this.blockIdConsentAccepted) return;
    this.data.consent.blockIdExplanationAccepted = true;
    this.touch();
    try { await this.save(); this.consentSaved = true; } catch (error) { this.data.consent.blockIdExplanationAccepted = false; throw error; }
  }
  flush(): Promise<SaveReceipt> { return this.save(); }
  get desks(): Desk[] { return this.data.desks; }
}
