import { stripInlineBlockId } from "./BlockReference";
import type { DeskService, OutlineMutationOutcome } from "./DeskService";
import type { PluginDataStore } from "../infra/PluginDataStore";
import type {
  EvidenceEntry,
  EvidenceOutline,
  EvidenceSnapshot,
  OutlineErrorCode,
  OutlineGroup,
  OutlineScope,
  SavedOrigin,
} from "./outlineTypes";
import {
  cloneEntry,
  cloneOutline,
  cloneSnapshot,
  isValidEvidenceSnapshot,
  isValidGroupName,
  normalizeGroupName,
} from "./outlineTypes";

export interface OutlineMutationResult {
  ok: boolean;
  saved: boolean;
  outlineRevision: number;
  code?: OutlineErrorCode;
  entry?: EvidenceEntry;
  group?: OutlineGroup;
  duplicateEntryId?: string;
  moved?: boolean;
}

export interface CollectEntryInput {
  deskId: string;
  expectedRevision: number;
  entryId: string;
  snapshot: EvidenceSnapshot;
  note?: string;
  allowDuplicate?: boolean;
  deskGeneration?: number;
}

export interface SetNoteInput {
  deskId: string;
  expectedRevision: number;
  entryId: string;
  expectedContentRevision: number;
  note: string;
  persist?: boolean;
}

export interface CreateGroupInput {
  deskId: string;
  expectedRevision: number;
  name: string;
  groupId?: string;
}

export interface RenameGroupInput {
  deskId: string;
  expectedRevision: number;
  groupId: string;
  name: string;
}

export interface MoveGroupInput {
  deskId: string;
  expectedRevision: number;
  groupId: string;
  direction?: "up" | "down";
  toIndex?: number;
}

export interface MoveEntryInput {
  deskId: string;
  expectedRevision: number;
  entryId: string;
  targetGroupId?: string | null;
  direction?: "up" | "down";
}

export interface RemoveEntryInput {
  deskId: string;
  expectedRevision: number;
  entryId: string;
}

export interface RemoveGroupInput {
  deskId: string;
  expectedRevision: number;
  groupId: string;
}

export interface RefreshEntryInput {
  deskId: string;
  expectedRevision: number;
  entryId: string;
  expectedContentRevision: number;
  snapshot: EvidenceSnapshot;
}

function mapMutationFailure(outcome: OutlineMutationOutcome): OutlineMutationResult {
  const code: OutlineErrorCode =
    outcome.status === "readonly" ? "OUTLINE_READONLY" :
    outcome.status === "missing" ? "DESK_DELETED" :
    "DESK_STALE";
  return { ok: false, saved: false, outlineRevision: outcome.revision, code };
}

function originSignature(origin: SavedOrigin): string {
  return `${origin.kind}:${stripInlineBlockId(origin.rawText, origin.kind, origin.blockId)}`;
}

function sameOccurrence(a: EvidenceSnapshot, b: EvidenceSnapshot): boolean {
  if (a.source.identity === "unconfirmed-after-loss" || b.source.identity === "unconfirmed-after-loss") return false;
  if (a.source.path !== b.source.path) return false;
  if (a.mode !== b.mode || a.content !== b.content) return false;
  if (a.origins.length !== b.origins.length || a.selectedRanges.length !== b.selectedRanges.length) return false;

  for (let i = 0; i < a.origins.length; i++) {
    const o1 = a.origins[i];
    const o2 = b.origins[i];
    if (originSignature(o1) !== originSignature(o2)) return false;
    const sameId = !!o1.blockId && o1.blockId === o2.blockId;
    const sameRange = o1.range.from === o2.range.from && o1.range.to === o2.range.to;
    if (!sameId && !sameRange) return false;
  }

  const baseA = a.origins[0].range.from;
  const baseB = b.origins[0].range.from;
  for (let i = 0; i < a.selectedRanges.length; i++) {
    const s1 = a.selectedRanges[i];
    const s2 = b.selectedRanges[i];
    const exact = s1.from === s2.from && s1.to === s2.to;
    const relative = (s1.from - baseA) === (s2.from - baseB) && (s1.to - baseA) === (s2.to - baseB);
    if (!exact && !relative) return false;
  }
  return true;
}

/** 书桌私有提纲的领域服务；只读取/修改书桌提纲并通过 DeskService/PluginDataStore 唯一根入口落盘。 */
export class OutlineService {
  constructor(private desks: DeskService, private store: PluginDataStore) {}

  outlineRevision(deskId: string): number {
    return this.desks.outlineRevision(deskId);
  }

  isDirty(deskId: string): boolean {
    return this.desks.isDirty(deskId);
  }

  getOutline(deskId: string): { outline: EvidenceOutline; revision: number } | undefined {
    const desk = this.desks.get(deskId);
    if (!desk) return undefined;
    return { outline: cloneOutline(desk.outline), revision: this.desks.outlineRevision(deskId) };
  }

  getEntry(deskId: string, entryId: string): EvidenceEntry | undefined {
    const entry = this.desks.get(deskId)?.outline.entries.find((item) => item.id === entryId);
    return entry ? cloneEntry(entry) : undefined;
  }

  selectEntries(deskId: string, scope: OutlineScope): { groups: OutlineGroup[]; entries: EvidenceEntry[]; scope: OutlineScope } | undefined {
    const desk = this.desks.get(deskId);
    if (!desk) return undefined;
    const outline = cloneOutline(desk.outline);
    if (scope.kind === "entry") {
      const entry = outline.entries.find((item) => item.id === scope.entryId);
      if (!entry) return undefined;
      return { groups: [], entries: [entry], scope };
    }
    if (scope.kind === "group") {
      const group = outline.groups.find((item) => item.id === scope.groupId);
      if (!group) return undefined;
      return { groups: [group], entries: outline.entries.filter((item) => item.groupId === group.id), scope };
    }
    return { groups: outline.groups, entries: outline.entries, scope };
  }

  async save(deskId: string): Promise<{ saved: boolean; code?: OutlineErrorCode }> {
    if (this.store.readOnly) return { saved: false, code: "OUTLINE_READONLY" };
    if (!this.desks.exists(deskId)) return { saved: false, code: "DESK_DELETED" };
    const result = await this.desks.save(deskId);
    return result.saved ? { saved: true } : { saved: false, code: "OUTLINE_SAVE_FAILED" };
  }

  async collect(input: CollectEntryInput): Promise<OutlineMutationResult> {
    if (this.store.readOnly) return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "OUTLINE_READONLY" };
    const desk = this.desks.get(input.deskId);
    if (!desk || (input.deskGeneration !== undefined && this.desks.generation(input.deskId) !== input.deskGeneration)) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "DESK_DELETED" };
    }
    if (!input.entryId || !isValidEvidenceSnapshot(input.snapshot)) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "CAPTURE_UNSUPPORTED" };
    }

    // 同一 entryId 重试只尝试持久化，不再追加第二条摘录。
    const existing = desk.outline.entries.find((item) => item.id === input.entryId);
    if (existing) {
      if (!this.desks.isDirty(input.deskId)) {
        return { ok: true, saved: true, outlineRevision: this.desks.outlineRevision(input.deskId), entry: cloneEntry(existing) };
      }
      const saved = await this.desks.save(input.deskId);
      return {
        ok: true,
        saved: saved.saved,
        outlineRevision: this.desks.outlineRevision(input.deskId),
        entry: cloneEntry(existing),
        ...(saved.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
      };
    }

    if (this.desks.outlineRevision(input.deskId) !== input.expectedRevision) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "DESK_STALE" };
    }

    if (!input.allowDuplicate) {
      const dup = desk.outline.entries.find((item) => sameOccurrence(item.snapshot, input.snapshot));
      if (dup) {
        return {
          ok: false,
          saved: false,
          outlineRevision: this.desks.outlineRevision(input.deskId),
          code: "DUPLICATE_ENTRY",
          duplicateEntryId: dup.id,
        };
      }
    }

    let created: EvidenceEntry | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const now = Date.now();
      created = {
        id: input.entryId,
        groupId: null,
        snapshot: cloneSnapshot(input.snapshot),
        note: input.note ?? "",
        contentRevision: 1,
        createdAt: now,
        updatedAt: now,
      };
      outline.entries.push(created);
    });

    if (outcome.status !== "ok" || !created) return mapMutationFailure(outcome);
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      entry: cloneEntry(created),
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }

  async setNote(input: SetNoteInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    let updated: EvidenceEntry | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const entry = outline.entries.find((item) => item.id === input.entryId);
      if (!entry || entry.contentRevision !== input.expectedContentRevision) {
        errorCode = "ENTRY_STALE";
        return false;
      }
      if (entry.note === input.note) {
        updated = entry;
        return false;
      }
      entry.note = input.note;
      entry.contentRevision += 1;
      entry.updatedAt = Date.now();
      updated = entry;
      return true;
    }, input.persist ?? true);

    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode };
    if (!updated) return { ok: false, saved: false, outlineRevision: outcome.revision, code: "ENTRY_STALE" };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      entry: cloneEntry(updated),
      ...((input.persist ?? true) && !outcome.saved ? { code: "OUTLINE_SAVE_FAILED" } : {}),
    };
  }

  async createGroup(input: CreateGroupInput): Promise<OutlineMutationResult> {
    if (this.store.readOnly) return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "OUTLINE_READONLY" };
    const desk = this.desks.get(input.deskId);
    if (!desk) return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "DESK_DELETED" };

    if (input.groupId) {
      const existing = desk.outline.groups.find((g) => g.id === input.groupId);
      if (existing) {
        if (!this.desks.isDirty(input.deskId)) {
          return { ok: true, saved: true, outlineRevision: this.desks.outlineRevision(input.deskId), group: { ...existing } };
        }
        const saved = await this.desks.save(input.deskId);
        return {
          ok: true,
          saved: saved.saved,
          outlineRevision: this.desks.outlineRevision(input.deskId),
          group: { ...existing },
          ...(saved.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
        };
      }
    }

    const name = normalizeGroupName(input.name);
    if (!isValidGroupName(name)) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "GROUP_NAME_INVALID" };
    }
    if (desk.outline.groups.some((g) => g.name.trim().toLowerCase() === name.toLowerCase())) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "GROUP_NAME_DUPLICATE" };
    }

    let created: OutlineGroup | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      if (outline.groups.some((g) => g.name.trim().toLowerCase() === name.toLowerCase())) return false;
      created = { id: input.groupId ?? `group-${crypto.randomUUID()}`, name };
      outline.groups.push(created);
      return true;
    });
    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (!created) return { ok: false, saved: false, outlineRevision: outcome.revision, code: "GROUP_NAME_DUPLICATE" };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      group: { ...created },
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }

  async renameGroup(input: RenameGroupInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    let renamed: OutlineGroup | undefined;
    const name = normalizeGroupName(input.name);
    if (!isValidGroupName(name)) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "GROUP_NAME_INVALID" };
    }
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const group = outline.groups.find((item) => item.id === input.groupId);
      if (!group) { errorCode = "ENTRY_STALE"; return false; }
      if (outline.groups.some((item) => item.id !== input.groupId && item.name.trim().toLowerCase() === name.toLowerCase())) {
        errorCode = "GROUP_NAME_DUPLICATE";
        return false;
      }
      if (group.name === name) { renamed = group; return false; }
      group.name = name;
      renamed = group;
      return true;
    });

    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode || !renamed) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode ?? "ENTRY_STALE" };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      group: { ...renamed },
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }

  async moveGroup(input: MoveGroupInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    let moved = false;
    let groupCopy: OutlineGroup | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const index = outline.groups.findIndex((item) => item.id === input.groupId);
      if (index < 0) { errorCode = "ENTRY_STALE"; return false; }
      const targetIndex = input.toIndex !== undefined
        ? Math.max(0, Math.min(outline.groups.length - 1, input.toIndex))
        : input.direction === "up" ? index - 1 : input.direction === "down" ? index + 1 : index;
      if (targetIndex < 0 || targetIndex >= outline.groups.length || targetIndex === index) {
        groupCopy = { ...outline.groups[index] };
        return false;
      }
      const [group] = outline.groups.splice(index, 1);
      outline.groups.splice(targetIndex, 0, group);
      moved = true;
      groupCopy = { ...group };
      return true;
    });

    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      group: groupCopy,
      moved,
      ...(moved && !outcome.saved ? { code: "OUTLINE_SAVE_FAILED" } : {}),
    };
  }

  async moveEntry(input: MoveEntryInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    let moved = false;
    let movedEntry: EvidenceEntry | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const index = outline.entries.findIndex((item) => item.id === input.entryId);
      if (index < 0) { errorCode = "ENTRY_STALE"; return false; }
      const entry = outline.entries[index];
      const destGroupId = input.targetGroupId !== undefined ? input.targetGroupId : entry.groupId;
      if (destGroupId !== null && !outline.groups.some((g) => g.id === destGroupId)) {
        errorCode = "ENTRY_STALE";
        return false;
      }
      if (destGroupId !== entry.groupId) {
        outline.entries.splice(index, 1);
        entry.groupId = destGroupId;
        outline.entries.push(entry);
        moved = true;
        movedEntry = entry;
        return true;
      }
      if (!input.direction) {
        movedEntry = entry;
        return false;
      }
      const zoneIndices = outline.entries.reduce<number[]>(
        (acc, item, idx) => (item.groupId === entry.groupId ? [...acc, idx] : acc),
        [],
      );
      const zonePos = zoneIndices.indexOf(index);
      const swapPos = input.direction === "up" ? zonePos - 1 : zonePos + 1;
      if (swapPos < 0 || swapPos >= zoneIndices.length) {
        movedEntry = entry;
        return false;
      }
      const otherIndex = zoneIndices[swapPos];
      const other = outline.entries[otherIndex];
      outline.entries[otherIndex] = entry;
      outline.entries[index] = other;
      moved = true;
      movedEntry = entry;
      return true;
    });

    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      entry: movedEntry ? cloneEntry(movedEntry) : undefined,
      moved,
      ...(moved && !outcome.saved ? { code: "OUTLINE_SAVE_FAILED" } : {}),
    };
  }

  async removeEntry(input: RemoveEntryInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const index = outline.entries.findIndex((item) => item.id === input.entryId);
      if (index < 0) { errorCode = "ENTRY_STALE"; return false; }
      outline.entries.splice(index, 1);
      return true;
    });
    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }

  async removeGroup(input: RemoveGroupInput): Promise<OutlineMutationResult> {
    let errorCode: OutlineErrorCode | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const groupIndex = outline.groups.findIndex((item) => item.id === input.groupId);
      if (groupIndex < 0) { errorCode = "ENTRY_STALE"; return false; }
      const remaining: EvidenceEntry[] = [];
      const movedBack: EvidenceEntry[] = [];
      for (const entry of outline.entries) {
        if (entry.groupId === input.groupId) {
          entry.groupId = null;
          movedBack.push(entry);
        } else {
          remaining.push(entry);
        }
      }
      outline.entries = [...remaining, ...movedBack];
      outline.groups.splice(groupIndex, 1);
      return true;
    });
    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }

  async refreshEntry(input: RefreshEntryInput): Promise<OutlineMutationResult> {
    if (!isValidEvidenceSnapshot(input.snapshot)) {
      return { ok: false, saved: false, outlineRevision: this.desks.outlineRevision(input.deskId), code: "CAPTURE_UNSUPPORTED" };
    }
    let errorCode: OutlineErrorCode | undefined;
    let refreshed: EvidenceEntry | undefined;
    const outcome = await this.desks.mutateOutline(input.deskId, input.expectedRevision, (outline) => {
      const entry = outline.entries.find((item) => item.id === input.entryId);
      if (!entry || entry.contentRevision !== input.expectedContentRevision) {
        errorCode = "ENTRY_STALE";
        return false;
      }
      entry.snapshot = cloneSnapshot(input.snapshot);
      entry.contentRevision += 1;
      entry.updatedAt = Date.now();
      refreshed = entry;
      return true;
    });

    if (outcome.status !== "ok") return mapMutationFailure(outcome);
    if (errorCode || !refreshed) return { ok: false, saved: false, outlineRevision: outcome.revision, code: errorCode ?? "ENTRY_STALE" };
    return {
      ok: true,
      saved: outcome.saved,
      outlineRevision: outcome.revision,
      entry: cloneEntry(refreshed),
      ...(outcome.saved ? {} : { code: "OUTLINE_SAVE_FAILED" }),
    };
  }
}
