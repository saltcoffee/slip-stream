import type { CitationHistoryEntry, CitationRelation } from "./citationTypes";
import type { PluginDataStore } from "../infra/PluginDataStore";

export const RELATION_LIMIT = 1000;
export const RELATION_BYTES = 10 * 1024 * 1024;
export function relationBytes(relations: readonly CitationRelation[]): number {
  return new TextEncoder().encode(JSON.stringify(relations)).byteLength;
}
type Recording = "saved" | "disabled" | "pending" | "capacity-exceeded";

/** Pending receipts already belong to the root; retry only saves, never recreates a cleared collection. */
export class CitationRecordsService {
  private accepted = new Set<string>();
  private pending = new Map<string, { historyId: string; relationId?: string; result: Recording }>();
  constructor(private store: PluginDataStore) {}
  get enabled(): boolean { return this.store.data.settings.historyEnabled && !this.store.readOnly; }
  list(): CitationHistoryEntry[] { return this.store.data.history.slice(); }
  get usage(): { count: number; bytes: number } {
    return { count: this.store.data.relations.length, bytes: relationBytes(this.store.data.relations) };
  }
  async record(history: CitationHistoryEntry, relation?: CitationRelation): Promise<Recording> {
    if (!this.enabled) return "disabled";
    if (this.accepted.has(history.operationId)) return this.pending.has(history.operationId) ? this.retry(history.operationId) : "saved";
    this.accepted.add(history.operationId);
    let result: Recording = "saved";
    if (relation) {
      const candidates = [...this.store.data.relations, relation];
      if (candidates.length > RELATION_LIMIT || relationBytes(candidates) > RELATION_BYTES) result = "capacity-exceeded";
      else { this.store.data.relations.push(relation); history.relationId = relation.id; }
    }
    this.store.data.history.unshift(history);
    this.store.data.history = this.store.data.history.slice(0, this.store.data.settings.historyLimit);
    this.pending.set(history.operationId, { historyId: history.id, relationId: history.relationId, result });
    return this.retry(history.operationId);
  }
  async retry(operationId: string): Promise<Recording> {
    const receipt = this.pending.get(operationId);
    if (!receipt) return this.enabled ? "saved" : "disabled";
    this.settingsChanged();
    try {
      await this.store.save();
      this.pending.delete(operationId);
      return this.enabled ? receipt.result : "disabled";
    } catch { return "pending"; }
  }
  settingsChanged(): void {
    if (this.enabled) return;
    const historyIds = new Set([...this.pending.values()].map((p) => p.historyId));
    const relationIds = new Set([...this.pending.values()].map((p) => p.relationId));
    this.store.data.history = this.store.data.history.filter((r) => !historyIds.has(r.id));
    this.store.data.relations = this.store.data.relations.filter((r) => !relationIds.has(r.id));
  }
  async clearHistory(): Promise<void> { this.store.data.history = []; await this.store.save(); }
  async clearRelations(): Promise<void> { this.store.data.relations = []; await this.store.save(); }
}
