import type { TextRange } from "./citationTypes";
import type { BlockKind } from "./types";

export const MAX_GROUP_NAME = 80;
export const MAX_CONTEXT_HINT_LENGTH = 80;

export type EvidenceMode = "block" | "fragment" | "selection";
export type EvidenceSourceIdentity = "unconfirmed-after-loss" | "path-reference";

export interface SavedOrigin {
  range: TextRange;
  rawText: string;
  kind: BlockKind | "list";
  blockId?: string;
  heading?: string;
  before: string;
  after: string;
}

export interface EvidenceSourceInfo {
  path: string;
  capturedPath: string;
  title: string;
  capturedAt: number;
  sourceLength: number;
  identity: EvidenceSourceIdentity;
}

export interface EvidenceSnapshot {
  content: string;
  mode: EvidenceMode;
  source: EvidenceSourceInfo;
  origins: SavedOrigin[];
  selectedRanges: TextRange[];
}

export interface EntryLastInsertion {
  batchId: string;
  operationId: string;
  targetPath: string;
  at: number;
  contentRevision: number;
  commitSequence: number;
}

export interface EvidenceEntry {
  id: string;
  groupId: string | null;
  snapshot: EvidenceSnapshot;
  note: string;
  contentRevision: number;
  createdAt: number;
  updatedAt: number;
  lastInsertion?: EntryLastInsertion;
}

export interface OutlineGroup {
  id: string;
  name: string;
}

export interface EvidenceOutline {
  groups: OutlineGroup[];
  entries: EvidenceEntry[];
}

export type OutlineScope =
  | { kind: "entry"; entryId: string }
  | { kind: "group"; groupId: string }
  | { kind: "all" };

export type OutlineErrorCode =
  | "OUTLINE_READONLY"
  | "OUTLINE_SAVE_FAILED"
  | "DESK_STALE"
  | "ENTRY_STALE"
  | "DESK_DELETED"
  | "CAPTURE_UNSUPPORTED"
  | "CAPTURE_STALE"
  | "GROUP_NAME_INVALID"
  | "GROUP_NAME_DUPLICATE"
  | "DUPLICATE_ENTRY";

export function emptyOutline(): EvidenceOutline {
  return { groups: [], entries: [] };
}

export function normalizeGroupName(raw: string): string {
  return raw.trim();
}

export function isValidGroupName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_GROUP_NAME && !/[\r\n]/.test(trimmed);
}

export function isNormalizedMarkdownPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith(".md")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\") || value.includes("//")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Slices up to maxUnits UTF-16 code units before `from` without splitting a surrogate pair. */
export function sliceContextBefore(text: string, from: number, maxUnits = MAX_CONTEXT_HINT_LENGTH): string {
  const clampedEnd = Math.max(0, Math.min(from, text.length));
  let start = Math.max(0, clampedEnd - maxUnits);
  if (start > 0 && start < clampedEnd) {
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  }
  return text.slice(start, clampedEnd);
}

/** Slices up to maxUnits UTF-16 code units after `to` without splitting a surrogate pair. */
export function sliceContextAfter(text: string, to: number, maxUnits = MAX_CONTEXT_HINT_LENGTH): string {
  const clampedStart = Math.max(0, Math.min(to, text.length));
  let end = Math.min(text.length, clampedStart + maxUnits);
  if (end > clampedStart && end < text.length) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return text.slice(clampedStart, end);
}

export function cloneSnapshot(snapshot: EvidenceSnapshot): EvidenceSnapshot {
  return {
    content: snapshot.content,
    mode: snapshot.mode,
    source: { ...snapshot.source },
    origins: snapshot.origins.map((origin) => ({
      range: { ...origin.range },
      rawText: origin.rawText,
      kind: origin.kind,
      ...(origin.blockId !== undefined ? { blockId: origin.blockId } : {}),
      ...(origin.heading !== undefined ? { heading: origin.heading } : {}),
      before: origin.before,
      after: origin.after,
    })),
    selectedRanges: snapshot.selectedRanges.map((range) => ({ ...range })),
  };
}

export function cloneEntry(entry: EvidenceEntry): EvidenceEntry {
  return {
    id: entry.id,
    groupId: entry.groupId,
    snapshot: cloneSnapshot(entry.snapshot),
    note: entry.note,
    contentRevision: entry.contentRevision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.lastInsertion ? { lastInsertion: { ...entry.lastInsertion } } : {}),
  };
}

export function cloneOutline(outline: EvidenceOutline): EvidenceOutline {
  return {
    groups: outline.groups.map((group) => ({ ...group })),
    entries: outline.entries.map(cloneEntry),
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidRange(range: unknown, maxLength: number): range is TextRange {
  return isObjectRecord(range) &&
    typeof range.from === "number" &&
    typeof range.to === "number" &&
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.from <= range.to &&
    range.to <= maxLength;
}

const ORIGIN_KINDS = new Set(["paragraph", "list", "list_item", "heading", "callout", "blockquote", "code", "table", "other"]);

/** Validates an unknown snapshot against v3 persistence & collection boundary invariants. */
export function isValidEvidenceSnapshot(raw: unknown): raw is EvidenceSnapshot {
  if (!isObjectRecord(raw)) return false;
  if (typeof raw.content !== "string" || !raw.content.trim()) return false;
  if (raw.mode !== "block" && raw.mode !== "fragment" && raw.mode !== "selection") return false;
  if (!isObjectRecord(raw.source)) return false;
  const src = raw.source;
  if (!isNormalizedMarkdownPath(src.path) || !isNormalizedMarkdownPath(src.capturedPath)) return false;
  if (typeof src.title !== "string") return false;
  if (typeof src.capturedAt !== "number" || !Number.isFinite(src.capturedAt)) return false;
  if (typeof src.sourceLength !== "number" || !Number.isSafeInteger(src.sourceLength) || src.sourceLength < 0) return false;
  if (src.identity !== "unconfirmed-after-loss" && src.identity !== "path-reference") return false;
  if (!Array.isArray(raw.origins) || raw.origins.length === 0) return false;
  let prevOriginTo = 0;
  const originRanges: TextRange[] = [];
  for (const item of raw.origins) {
    if (!isObjectRecord(item) || !isValidRange(item.range, src.sourceLength)) return false;
    if (item.range.to <= item.range.from || item.range.from < prevOriginTo) return false;
    prevOriginTo = item.range.to;
    if (typeof item.rawText !== "string" || item.rawText.length !== item.range.to - item.range.from) return false;
    if (typeof item.kind !== "string" || !ORIGIN_KINDS.has(item.kind)) return false;
    if (item.blockId !== undefined && (typeof item.blockId !== "string" || !item.blockId)) return false;
    if (item.heading !== undefined && typeof item.heading !== "string") return false;
    if (typeof item.before !== "string" || item.before.length > MAX_CONTEXT_HINT_LENGTH || hasUnpairedSurrogate(item.before)) return false;
    if (typeof item.after !== "string" || item.after.length > MAX_CONTEXT_HINT_LENGTH || hasUnpairedSurrogate(item.after)) return false;
    originRanges.push(item.range);
  }
  if (!Array.isArray(raw.selectedRanges) || raw.selectedRanges.length === 0) return false;
  let prevSelectedTo = 0;
  for (const sr of raw.selectedRanges) {
    if (!isValidRange(sr, src.sourceLength) || sr.to <= sr.from || sr.from < prevSelectedTo) return false;
    prevSelectedTo = sr.to;
    if (!originRanges.some((range) => sr.from >= range.from && sr.to <= range.to)) return false;
  }
  return true;
}
