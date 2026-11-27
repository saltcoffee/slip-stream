import type { BlockKind } from "./types";
import type { EvidenceSnapshot } from "./outlineTypes";

export interface TextRange { from: number; to: number }
export type Precision = "block" | "fragment" | "multi-block-start" | "heading" | "file";
export type TemplateId = "A" | "B" | "C" | "D";
export interface OriginSpan {
  blockKey: string;
  rawRange: TextRange;
  rawText: string;
  kind: BlockKind | "list";
  existingBlockId?: string;
  heading?: string;
}
export interface SourceSnapshot {
  sourceRef: string;
  title?: string;
  text: string;
  bodyStart: number;
  spans: readonly OriginSpan[];
}
export interface CitationIntent {
  operationId: string;
  action: "insert" | "copy";
  snapshot: SourceSnapshot;
  spans: readonly OriginSpan[];
  mode: "block" | "fragment" | "selection";
  content: string;
  selectionKey?: string;
  templateId: TemplateId;
  customTemplate?: string;
  date: string;
}
export interface TargetTicket {
  fileRef: string;
  editorId: string;
  revision: number;
  range: TextRange;
  baselineText: string;
  bindingGeneration: number;
}
export interface TargetBinding { path: string; fileRef: string; editorId: string; generation: number; ticket?: TargetTicket }
export type CitationErrorCode =
  | "SOURCE_STALE" | "SOURCE_MISSING" | "SOURCE_MAPPING_UNSUPPORTED" | "SOURCE_AMBIGUOUS" | "SOURCE_READ_FAILED"
  | "TARGET_MISSING" | "TARGET_READONLY" | "TARGET_STALE" | "TARGET_MULTIPLE_SELECTIONS" | "DROP_POSITION_UNAVAILABLE"
  | "ANCHOR_WRITE_FAILED" | "TEMPLATE_REQUIRES_BLOCK" | "TEMPLATE_INVALID" | "LINK_INVALID" | "CONSENT_REQUIRED"
  | "DUPLICATE" | "CLIPBOARD_DENIED" | "TARGET_COMMIT_FAILED" | "RECORD_SAVE_FAILED" | "RECORD_CAPACITY_EXCEEDED"
  | "COMMIT_STATE_UNCERTAIN" | "OPERATION_CANCELLED"
  | "EMPTY_OUTPUT" | "SELF_SOURCE_CONFLICT" | "MARKDOWN_BOUNDARY_UNSAFE" | "PLAN_STALE" | "ANCHOR_PLAN_CHANGED";
export class CitationError extends Error {
  constructor(public readonly code: CitationErrorCode) { super(code); }
}
export interface CitationOutcome {
  operationId: string;
  status: "success" | "cancelled" | "blocked" | "failed" | "partial" | "uncertain";
  sourceAnchor: "unchanged" | "created" | "reused" | "unknown";
  effect: "none" | "inserted" | "copied" | "unknown";
  recording: "not-attempted" | "saved" | "disabled" | "pending" | "capacity-exceeded";
  precision: Precision;
  code?: CitationErrorCode;
  targetPath?: string;
}
export interface CitationHistoryEntry {
  id: string; operationId: string; at: number;
  action: "insert" | "copy" | "legacy-unknown";
  sourcePath: string; targetPath?: string;
  blockId?: string; heading?: string; precision?: Precision;
  template: string; snippet: string; text?: string; relationId?: string;
}
export type RelationSourceState = "verified" | "stale-snapshot" | "missing-snapshot" | "unavailable-snapshot";

export interface CitationRelation {
  id: string; operationId: string; batchId?: string; at: number;
  sourcePath: string; targetPath: string;
  sourceSpans: Array<{ range: TextRange; rawText: string; kind: BlockKind | "list" }>;
  content: string; insertedText: string;
  blockId?: string; heading?: string; precision: Precision;
  sourceState: RelationSourceState;
  template: TemplateId;
  targetHint: { range: TextRange; before: string; after: string };
}

export interface VerifiedLiveEvidenceInput {
  kind: "verified-live";
  itemId: string;
  entryId: string;
  contentRevision: number;
  groupId: string | null;
  note: string;
  snapshot: SourceSnapshot;
  spans: readonly OriginSpan[];
  mode: "block" | "fragment" | "selection";
  content: string;
  selectionKey?: string;
  sourceVersion?: number;
  templateId: TemplateId;
  customTemplate?: string;
  date: string;
  fallback?: "heading" | "file";
  skipped?: boolean;
  duplicateAuthorized?: boolean;
}

export interface SavedSnapshotEvidenceInput {
  kind: "saved-snapshot";
  itemId: string;
  entryId: string;
  contentRevision: number;
  groupId: string | null;
  note: string;
  snapshot: EvidenceSnapshot;
  sourceRef?: string;
  sourceState: "stale-snapshot" | "missing-snapshot" | "unavailable-snapshot";
  sourceVersion?: number;
  templateId: TemplateId;
  customTemplate?: string;
  date: string;
  skipped?: boolean;
  duplicateAuthorized?: boolean;
  selfSourceDegraded?: boolean;
}

export type PreparedEvidenceInput = VerifiedLiveEvidenceInput | SavedSnapshotEvidenceInput;
export interface CommitReceipt {
  targetPath: string;
  range: TextRange;
  contentRange?: TextRange;
  text: string;
  before: string;
  after: string;
}
export function validRange(range: TextRange, length: number): boolean {
  return Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.from <= range.to && range.to <= length;
}
/** Normalizes and merges selected ranges relative to the first origin span's start offset for canonical dedupe keys. */
export function canonicalSelectionKey(
  spans: readonly OriginSpan[],
  selectedRanges?: readonly TextRange[],
): string | undefined {
  if (!spans.length || !selectedRanges?.length) return undefined;
  const base = spans[0].rawRange.from;
  const normalized = selectedRanges
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from)
    .map((range) => ({ from: range.from - base, to: range.to - base }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  if (!normalized.length) return undefined;
  const merged: TextRange[] = [{ ...normalized[0] }];
  for (let i = 1; i < normalized.length; i++) {
    const next = normalized[i];
    const last = merged[merged.length - 1];
    if (next.from <= last.to) {
      last.to = Math.max(last.to, next.to);
    } else {
      merged.push({ ...next });
    }
  }
  return merged.map((range) => `${range.from}-${range.to}`).join(",");
}
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
