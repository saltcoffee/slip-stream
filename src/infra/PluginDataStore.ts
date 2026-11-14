import { DEFAULT_SETTINGS } from "../settings/settings";
import type { Settings } from "../settings/settings";
import type { CitationHistoryEntry, CitationRelation } from "../domain/citationTypes";
import { validRange } from "../domain/citationTypes";

export interface PersistedDataV1 extends Record<string, unknown> {
  schemaVersion: 1;
  settings: Settings;
  history: CitationHistoryEntry[];
  relations: CitationRelation[];
  consent: { blockIdExplanationAccepted: boolean };
}
interface DataPort {
  load(): Promise<unknown>;
  save(data: PersistedDataV1): Promise<void>;
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
  collectionLimit: [1, 100000], excerptLength: [20, 100000], snippetCalloutLimit: [40, 100000],
  historyLimit: [1, 100000], renderConcurrency: [1, 8], fontScale: [0.8, 1.6],
};
export function validateSettings(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!object(raw)) return out;
  for (const key of Object.keys(out) as Array<keyof Settings>) {
    const value = raw[key];
    if (typeof value !== typeof out[key]) continue;
    const options = enums[key];
    if (options && (typeof value !== "string" || !options.includes(value))) continue;
    const range = bounds[key];
    if (typeof value === "number" && (!Number.isFinite(value) || range && (value < range[0] || value > range[1]) || key !== "fontScale" && !Number.isInteger(value))) continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
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

/** Owns the only root state and obtains a fresh immutable snapshot when each save starts. */
export class PluginDataStore {
  data: PersistedDataV1 = { schemaVersion: 1, settings: { ...DEFAULT_SETTINGS }, history: [], relations: [], consent: { blockIdExplanationAccepted: false } };
  readOnly = false;
  warning = "";
  private consentSaved = false;
  get blockIdConsentAccepted(): boolean { return this.consentSaved && !this.readOnly; }
  private tail: Promise<void> = Promise.resolve();
  constructor(private port: DataPort) {}

  async load(): Promise<void> {
    let raw: unknown;
    try { raw = await this.port.load(); } catch { this.readOnly = true; this.warning = "data.readonly"; return; }
    if (raw == null) return;
    if (!object(raw) || raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
      this.readOnly = true; this.warning = "data.readonly";
      if (object(raw)) this.data.settings = validateSettings(raw.settings);
      return;
    }
    const legacy = raw.schemaVersion === undefined;
    const history = Array.isArray(raw.history) ? raw.history.map((r) => historyEntry(r, legacy)).filter((r): r is CitationHistoryEntry => !!r) : [];
    const relations = !legacy && Array.isArray(raw.relations) ? raw.relations.filter(relation) : [];
    const invalid = raw.history !== undefined && (!Array.isArray(raw.history) || history.length !== raw.history.length) ||
      !legacy && raw.relations !== undefined && (!Array.isArray(raw.relations) || relations.length !== raw.relations.length);
    this.data = { ...raw, schemaVersion: 1, settings: validateSettings(raw.settings), history, relations,
      consent: { blockIdExplanationAccepted: !legacy && object(raw.consent) && raw.consent.blockIdExplanationAccepted === true } };
    this.consentSaved = !legacy && this.data.consent.blockIdExplanationAccepted;
    if (legacy || invalid) {
      try { await this.port.backup(raw); } catch { this.readOnly = true; this.warning = "data.backupFailed"; return; }
      this.warning = invalid ? "data.invalidEntries" : "";
      try { await this.save(); } catch { this.warning = "data.migrationFailed"; }
    }
  }
  save(): Promise<void> {
    const job = this.tail.catch(() => {}).then(async () => {
      if (this.readOnly) throw new Error("DATA_READONLY");
      const snapshot = JSON.parse(JSON.stringify(this.data)) as PersistedDataV1;
      await this.port.save(snapshot);
    });
    this.tail = job;
    return job;
  }
  async acceptBlockIds(): Promise<void> {
    if (this.blockIdConsentAccepted) return;
    this.data.consent.blockIdExplanationAccepted = true;
    try { await this.save(); this.consentSaved = true; } catch (error) { this.data.consent.blockIdExplanationAccepted = false; throw error; }
  }
  flush(): Promise<void> { return this.save(); }
}
