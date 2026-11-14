import type { BlockKind } from "./types";

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
  | "COMMIT_STATE_UNCERTAIN" | "OPERATION_CANCELLED";
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
export interface CitationRelation {
  id: string; operationId: string; at: number;
  sourcePath: string; targetPath: string;
  sourceSpans: Array<{ range: TextRange; rawText: string; kind: BlockKind | "list" }>;
  content: string; insertedText: string;
  blockId?: string; heading?: string; precision: Precision;
  sourceState: "verified" | "stale-snapshot";
  template: TemplateId;
  targetHint: { range: TextRange; before: string; after: string };
}
export interface CommitReceipt { targetPath: string; range: TextRange; text: string; before: string; after: string }
export function validRange(range: TextRange, length: number): boolean {
  return Number.isInteger(range.from) && Number.isInteger(range.to) && range.from >= 0 && range.from <= range.to && range.to <= length;
}
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
