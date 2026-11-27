import type { CitationHistoryEntry, CitationRelation } from "./citationTypes";
import type { EntryLastInsertion } from "./outlineTypes";
import type { PluginDataStore } from "../infra/PluginDataStore";

export const RELATION_LIMIT = 1000;
export const RELATION_BYTES = 10 * 1024 * 1024;

export function relationBytes(relations: readonly CitationRelation[]): number {
  return new TextEncoder().encode(JSON.stringify(relations)).byteLength;
}

export type RecordingResult = "saved" | "disabled" | "pending" | "capacity-exceeded";

export interface BatchCitationRecordItem {
  operationId: string;
  entryId?: string;
  contentRevision?: number;
  history: CitationHistoryEntry;
  relation?: CitationRelation;
}

export interface BatchRecordInput {
  batchId: string;
  deskId?: string;
  targetPath: string;
  at: number;
  commitSequence?: number;
  recordingEligible: boolean;
  skipRelations?: boolean;
  items: readonly BatchCitationRecordItem[];
}

export interface BatchCommitFreeze {
  recordingEligible: boolean;
  commitSequence?: number;
  at: number;
}

interface PendingInsertionTarget {
  deskId: string;
  entryId: string;
  operationId: string;
  insertion: EntryLastInsertion;
}

interface PendingBatchReceipt {
  batchId: string;
  result: RecordingResult;
  rootRevision: number;
  commitSequence: number;
  historyIds: Set<string>;
  relationIds: Set<string>;
  insertionTargets: PendingInsertionTarget[];
}

function insertionKey(deskId: string, entryId: string): string {
  return `${deskId}\0${entryId}`;
}

function mapPath(path: string, oldPath: string, newPath: string, isFolder: boolean): string {
  if (path === oldPath) return newPath;
  if (isFolder && path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
  return path;
}

/** Pending receipts already belong to the root; retry only saves, never recreates a cleared collection. */
export class CitationRecordsService {
  private accepted = new Set<string>();
  private pending = new Map<string, { historyId: string; relationId?: string; result: RecordingResult; rootRevision: number }>();
  private acceptedBatches = new Set<string>();
  private pendingBatches = new Map<string, PendingBatchReceipt>();
  private completedBatches = new Map<string, RecordingResult>();
  private suppressedBatches = new Set<string>();
  private lastAllocatedSequence = 0;
  private confirmedCommitSequence: number | undefined;
  private confirmedInsertions = new Map<string, EntryLastInsertion | undefined>();

  constructor(private store: PluginDataStore) {}

  get enabled(): boolean {
    return this.store.data.settings.historyEnabled && !this.store.readOnly;
  }

  list(): CitationHistoryEntry[] {
    return this.store.data.history.slice();
  }

  get usage(): { count: number; bytes: number } {
    return { count: this.store.data.relations.length, bytes: relationBytes(this.store.data.relations) };
  }

  canFitRelations(additionalRelations: readonly CitationRelation[]): boolean {
    if (!additionalRelations.length) return true;
    const candidates = [...this.store.data.relations, ...additionalRelations];
    return candidates.length <= RELATION_LIMIT && relationBytes(candidates) <= RELATION_BYTES;
  }

  /** Synchronously assigns the next monotonic commit sequence in this window without advancing persisted state. */
  allocateCommitSequence(): number {
    const base = Math.max(this.lastAllocatedSequence, this.store.data.lastCommitSequence);
    this.lastAllocatedSequence = base + 1;
    return this.lastAllocatedSequence;
  }

  /** Synchronously freezes recording eligibility and sequence right after target commit succeeds. */
  freezeBatchCommit(hasCitations: boolean): BatchCommitFreeze {
    const at = Date.now();
    if (!this.enabled || !hasCitations) return { recordingEligible: false, at };
    return { recordingEligible: true, commitSequence: this.allocateCommitSequence(), at };
  }

  pendingBatchIds(): string[] {
    this.syncPersisted();
    return [...this.pendingBatches.keys()];
  }

  hasPending(): boolean {
    this.syncPersisted();
    return this.pending.size > 0 || this.pendingBatches.size > 0;
  }

  async record(history: CitationHistoryEntry, relation?: CitationRelation): Promise<RecordingResult> {
    if (!this.enabled) return "disabled";
    if (this.accepted.has(history.operationId)) return this.pending.has(history.operationId) ? this.retry(history.operationId) : "saved";
    this.accepted.add(history.operationId);
    let result: RecordingResult = "saved";
    if (relation) {
      if (!this.canFitRelations([relation])) result = "capacity-exceeded";
      else {
        this.store.data.relations.push(relation);
        history.relationId = relation.id;
      }
    }
    this.store.data.history.unshift(history);
    this.store.data.history = this.store.data.history.slice(0, this.store.data.settings.historyLimit);
    const rootRevision = this.store.touch();
    this.pending.set(history.operationId, { historyId: history.id, relationId: history.relationId, result, rootRevision });
    return this.retry(history.operationId);
  }

  async retry(operationId: string): Promise<RecordingResult> {
    this.syncPersisted();
    const receipt = this.pending.get(operationId);
    if (!receipt) return this.enabled ? "saved" : "disabled";
    this.settingsChanged();
    if (this.store.isPersisted(receipt.rootRevision)) {
      this.pending.delete(operationId);
      return this.enabled ? receipt.result : "disabled";
    }
    try {
      await this.store.save();
      this.pending.delete(operationId);
      return this.enabled ? receipt.result : "disabled";
    } catch {
      if (this.store.isPersisted(receipt.rootRevision)) {
        this.pending.delete(operationId);
        return this.enabled ? receipt.result : "disabled";
      }
      return "pending";
    }
  }

  /** Applies an entire batch in one root mutation, enforcing all-or-nothing relation capacity and sequence-ordered lastInsertion. */
  async recordBatch(input: BatchRecordInput): Promise<RecordingResult> {
    this.syncPersisted();
    if (this.suppressedBatches.has(input.batchId)) return "disabled";
    if (this.acceptedBatches.has(input.batchId)) {
      if (this.pendingBatches.has(input.batchId)) return this.retryBatch(input.batchId);
      return this.completedBatches.get(input.batchId) ?? (this.enabled ? "saved" : "disabled");
    }
    if (!input.recordingEligible || !this.enabled || !input.items.length) return "disabled";

    this.acceptedBatches.add(input.batchId);
    if (this.confirmedCommitSequence === undefined && this.pendingBatches.size === 0) {
      this.confirmedCommitSequence = this.store.data.lastCommitSequence;
    }

    const seq = input.commitSequence ?? this.allocateCommitSequence();
    this.lastAllocatedSequence = Math.max(this.lastAllocatedSequence, seq);

    let result: RecordingResult = "saved";
    const batchRelations: CitationRelation[] = [];
    if (!input.skipRelations) {
      for (const item of input.items) {
        if (item.relation) batchRelations.push(item.relation);
      }
      if (batchRelations.length > 0) {
        if (!this.canFitRelations(batchRelations)) {
          result = "capacity-exceeded";
        } else {
          for (const item of input.items) {
            if (item.relation) {
              this.store.data.relations.push(item.relation);
              item.history.relationId = item.relation.id;
            }
          }
        }
      }
    }

    const historyLimit = this.store.data.settings.historyLimit;
    const histories = input.items.map((item) => item.history);
    this.store.data.history.unshift(...histories);
    this.store.data.history = this.store.data.history.slice(0, historyLimit);
    this.store.data.lastCommitSequence = Math.max(this.store.data.lastCommitSequence, seq);

    const insertionTargets: PendingInsertionTarget[] = [];
    if (input.deskId) {
      const desk = this.store.data.desks.find((candidate) => candidate.id === input.deskId);
      if (desk) {
        for (const item of input.items) {
          if (!item.entryId || item.contentRevision === undefined) continue;
          const entry = desk.outline.entries.find((candidate) => candidate.id === item.entryId);
          if (!entry) continue;
          const key = insertionKey(input.deskId, entry.id);
          if (!this.confirmedInsertions.has(key)) {
            this.confirmedInsertions.set(key, entry.lastInsertion ? { ...entry.lastInsertion } : undefined);
          }
          if (!entry.lastInsertion || seq > entry.lastInsertion.commitSequence) {
            const insertion: EntryLastInsertion = {
              batchId: input.batchId,
              operationId: item.operationId,
              targetPath: input.targetPath,
              at: input.at,
              contentRevision: item.contentRevision,
              commitSequence: seq,
            };
            entry.lastInsertion = insertion;
            insertionTargets.push({ deskId: input.deskId, entryId: entry.id, operationId: item.operationId, insertion: { ...insertion } });
          }
        }
      }
    }

    const rootRevision = this.store.touch();
    const receipt: PendingBatchReceipt = {
      batchId: input.batchId,
      result,
      rootRevision,
      commitSequence: seq,
      historyIds: new Set(histories.map((entry) => entry.id)),
      relationIds: new Set(result === "saved" ? batchRelations.map((rel) => rel.id) : []),
      insertionTargets,
    };
    this.pendingBatches.set(input.batchId, receipt);
    return this.retryBatch(input.batchId);
  }

  /** Retries persisting a pending batch receipt without re-appending history, relations, or re-writing body text. */
  async retryBatch(batchId: string): Promise<RecordingResult> {
    this.syncPersisted();
    if (this.suppressedBatches.has(batchId)) return "disabled";
    const receipt = this.pendingBatches.get(batchId);
    if (!receipt) {
      if (this.acceptedBatches.has(batchId)) {
        return this.completedBatches.get(batchId) ?? (this.enabled ? "saved" : "disabled");
      }
      return this.enabled ? "saved" : "disabled";
    }
    this.settingsChanged();
    if (this.suppressedBatches.has(batchId)) return "disabled";
    if (this.store.isPersisted(receipt.rootRevision)) {
      this.confirmBatchReceipt(receipt);
      return receipt.result;
    }
    try {
      await this.store.save();
      this.confirmBatchReceipt(receipt);
      return this.enabled ? receipt.result : "disabled";
    } catch {
      if (this.store.isPersisted(receipt.rootRevision)) {
        this.confirmBatchReceipt(receipt);
        return receipt.result;
      }
      return "pending";
    }
  }

  settingsChanged(): void {
    this.syncPersisted();
    if (this.enabled) return;
    let mutated = false;

    if (this.pending.size > 0) {
      const historyIds = new Set([...this.pending.values()].map((p) => p.historyId).filter(Boolean));
      const relationIds = new Set([...this.pending.values()].map((p) => p.relationId).filter((id): id is string => !!id));
      if (historyIds.size > 0) {
        const before = this.store.data.history.length;
        this.store.data.history = this.store.data.history.filter((r) => !historyIds.has(r.id));
        if (this.store.data.history.length !== before) mutated = true;
      }
      if (relationIds.size > 0) {
        const before = this.store.data.relations.length;
        this.store.data.relations = this.store.data.relations.filter((r) => !relationIds.has(r.id));
        if (this.store.data.relations.length !== before) mutated = true;
      }
    }

    if (this.pendingBatches.size > 0) {
      const historyIds = new Set<string>();
      const relationIds = new Set<string>();
      for (const [batchId, receipt] of this.pendingBatches) {
        for (const id of receipt.historyIds) historyIds.add(id);
        for (const id of receipt.relationIds) relationIds.add(id);
        for (const target of receipt.insertionTargets) {
          const desk = this.store.data.desks.find((d) => d.id === target.deskId);
          const entry = desk?.outline.entries.find((e) => e.id === target.entryId);
          if (entry?.lastInsertion &&
            entry.lastInsertion.operationId === target.operationId &&
            entry.lastInsertion.commitSequence === target.insertion.commitSequence) {
            const confirmed = this.confirmedInsertions.get(insertionKey(target.deskId, target.entryId));
            if (confirmed) entry.lastInsertion = { ...confirmed };
            else delete entry.lastInsertion;
            mutated = true;
          }
        }
        this.suppressedBatches.add(batchId);
      }
      this.pendingBatches.clear();
      if (historyIds.size > 0) {
        const before = this.store.data.history.length;
        this.store.data.history = this.store.data.history.filter((r) => !historyIds.has(r.id));
        if (this.store.data.history.length !== before) mutated = true;
      }
      if (relationIds.size > 0) {
        const before = this.store.data.relations.length;
        this.store.data.relations = this.store.data.relations.filter((r) => !relationIds.has(r.id));
        if (this.store.data.relations.length !== before) mutated = true;
      }
      if (this.confirmedCommitSequence !== undefined && this.store.data.lastCommitSequence !== this.confirmedCommitSequence) {
        this.store.data.lastCommitSequence = this.confirmedCommitSequence;
        mutated = true;
      }
    }

    if (mutated) this.store.touch();
  }

  async clearHistory(): Promise<void> {
    this.syncPersisted();
    this.store.data.history = [];
    for (const p of this.pending.values()) p.historyId = "";
    for (const p of this.pendingBatches.values()) p.historyIds.clear();
    this.store.touch();
    await this.store.save();
  }

  async clearRelations(): Promise<void> {
    this.syncPersisted();
    this.store.data.relations = [];
    for (const p of this.pending.values()) p.relationId = undefined;
    for (const p of this.pendingBatches.values()) p.relationIds.clear();
    this.store.touch();
    await this.store.save();
  }

  async renamePaths(oldPath: string, newPath: string, isFolder: boolean): Promise<void> {
    let changed = false;
    for (const entry of this.store.data.history) {
      const sourcePath = mapPath(entry.sourcePath, oldPath, newPath, isFolder);
      if (sourcePath !== entry.sourcePath) { entry.sourcePath = sourcePath; changed = true; }
      if (entry.targetPath) {
        const targetPath = mapPath(entry.targetPath, oldPath, newPath, isFolder);
        if (targetPath !== entry.targetPath) { entry.targetPath = targetPath; changed = true; }
      }
    }
    for (const rel of this.store.data.relations) {
      const sourcePath = mapPath(rel.sourcePath, oldPath, newPath, isFolder);
      if (sourcePath !== rel.sourcePath) { rel.sourcePath = sourcePath; changed = true; }
      const targetPath = mapPath(rel.targetPath, oldPath, newPath, isFolder);
      if (targetPath !== rel.targetPath) { rel.targetPath = targetPath; changed = true; }
    }
    if (changed) {
      this.store.touch();
      try { await this.store.save(); } catch { /* 保留内存映射 */ }
    }
  }

  private syncPersisted(): void {
    for (const [opId, receipt] of this.pending) {
      if (this.store.isPersisted(receipt.rootRevision)) this.pending.delete(opId);
    }
    for (const [, receipt] of this.pendingBatches) {
      if (this.store.isPersisted(receipt.rootRevision)) {
        this.confirmBatchReceipt(receipt);
      }
    }
    if (this.pendingBatches.size === 0) {
      this.confirmedCommitSequence = this.store.data.lastCommitSequence;
    }
  }

  private confirmBatchReceipt(receipt: PendingBatchReceipt): void {
    for (const target of receipt.insertionTargets) {
      const key = insertionKey(target.deskId, target.entryId);
      const existing = this.confirmedInsertions.get(key);
      if (!existing || target.insertion.commitSequence > existing.commitSequence) {
        this.confirmedInsertions.set(key, { ...target.insertion });
      }
    }
    this.confirmedCommitSequence = Math.max(this.confirmedCommitSequence ?? 0, receipt.commitSequence);
    this.completedBatches.set(receipt.batchId, receipt.result);
    this.pendingBatches.delete(receipt.batchId);
  }
}
