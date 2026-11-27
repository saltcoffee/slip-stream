import { buildCitation } from "./DropTemplate";
import { stripInlineBlockId } from "./BlockReference";
import {
  checkMarkdownBoundaries,
  checkTargetInsertionBoundaries,
  compileCitationDocument,
  DEFAULT_DOCUMENT_LABELS,
  escapeMarkdownText,
} from "./CitationDocument";
import type {
  CitationDocumentLabels,
  CitationLayoutPart,
  CitationSlice,
  CompiledCitationDocument,
  LayoutSlice,
} from "./CitationDocument";
import { CitationError } from "./citationTypes";
import type {
  CitationErrorCode,
  CitationHistoryEntry,
  CitationIntent,
  CitationOutcome,
  CitationRelation,
  CommitReceipt,
  OriginSpan,
  Precision,
  PreparedEvidenceInput,
  RelationSourceState,
  SavedSnapshotEvidenceInput,
  TargetTicket,
  TextRange,
  VerifiedLiveEvidenceInput,
} from "./citationTypes";
import type { Settings } from "../settings/settings";
import type {
  BlockIdService,
  SelfTargetItemMapping,
  SourceAnchorPlan,
  SourceInspection,
} from "../infra/BlockIdService";
import { mapBatchSliceReceipt } from "../infra/EditorGateway";
import type { BatchCitationRecordItem, CitationRecordsService } from "./CitationRecords";
import type { CitationLinkService } from "../infra/CitationLinkService";

interface EnginePorts {
  settings(): Settings;
  consentAccepted(): boolean;
  anchorWritesEnabled(): boolean;
  sources: Pick<BlockIdService, "inspect" | "ensure" | "prepareMany" | "ensurePlanned" | "verifyPlanned" | "predictSelfTarget" | "matchesPlannedResult">;
  editors: {
    validate(ticket: TargetTicket): void;
    commit(ticket: TargetTicket, text: string, block?: boolean): CommitReceipt;
    copy(text: string): Promise<void>;
    path(ref: string): string;
    readSource(ref: string): Promise<string>;
    onContentChanged?(listener: (fileRef: string, path: string) => void): () => void;
    watchSourceChanges?(refs: ReadonlySet<string>, onChanged: (fileRef: string) => void): () => void;
    readOpenSourceSync?(ref: string): string | undefined;
  };
  links: Pick<CitationLinkService, "link" | "validate">;
  records: Pick<CitationRecordsService, "record" | "enabled" | "recordBatch" | "freezeBatchCommit" | "canFitRelations">;
}

export interface ExecutionOptions {
  ticket?: TargetTicket;
  signal?: AbortSignal;
  duplicateAuthorization?: string;
  fallback?: "heading" | "file";
  staleSnapshot?: boolean;
}

export interface EngineOutcome extends CitationOutcome {
  duplicateAuthorization?: string;
}

export type BatchIssueCode =
  | CitationErrorCode
  | "BATCH_DUPLICATE"
  | "RELATION_CAPACITY"
  | "SKELETON_CONFIRMATION_REQUIRED";

export interface BatchIssue {
  code: BatchIssueCode;
  itemId?: string;
  sourcePath?: string;
  blocking: boolean;
  options: readonly string[];
  reason: string;
}

export interface CitationBatchRequest {
  batchId: string;
  deskId?: string;
  outlineRevision?: number;
  templateRevision?: number;
  decisionsRevision?: number;
  items: readonly PreparedEvidenceInput[];
  layout: readonly CitationLayoutPart[];
  ticket?: TargetTicket;
  block?: boolean;
  signal: AbortSignal;
  skipRelationsOnCapacityExceeded?: boolean;
  skeletonConfirmed?: boolean;
  labels?: Partial<CitationDocumentLabels>;
}

export interface CitationBatchPlan {
  planId: string;
  batchId: string;
  markdown: string;
  isEmpty: boolean;
  includedItemCount: number;
  hasSkeleton: boolean;
  citationSlices: readonly CitationSlice[];
  layoutSlices: readonly LayoutSlice[];
  issues: readonly BatchIssue[];
  anchorPlans: readonly SourceAnchorPlan[];
  recording: "enabled" | "disabled" | "capacity-choice-required";
  canCommit: boolean;
}

export interface SourceAnchorWriteResult {
  sourceRef: string;
  sourcePath: string;
  kind: "reused" | "created" | "unchanged" | "unknown" | "failed";
  createdIds: readonly string[];
  reusedIds: readonly string[];
  code?: CitationErrorCode;
}

export interface BatchCommitItemResult {
  itemId: string;
  operationId: string;
  entryId: string;
  contentRevision: number;
  precision: Precision;
  sourceState: RelationSourceState;
  targetRange?: TextRange;
  insertedText?: string;
}

export interface BatchCommitOutcome {
  batchId: string;
  planId: string;
  status: "success" | "cancelled" | "blocked" | "failed" | "partial" | "uncertain";
  effect: "none" | "inserted" | "unknown";
  recording: "not-attempted" | "saved" | "disabled" | "pending" | "capacity-exceeded";
  code?: CitationErrorCode;
  targetPath?: string;
  commitSequence?: number;
  at?: number;
  includedItemCount: number;
  hasSkeleton: boolean;
  sourceResults: readonly SourceAnchorWriteResult[];
  items: readonly BatchCommitItemResult[];
}

export interface BatchCommitOptions {
  signal: AbortSignal;
  ticket?: TargetTicket;
}

interface PreparedBatchItem {
  input: PreparedEvidenceInput;
  operationId: string;
  precision: Precision;
  blockId?: string;
  heading?: string;
  sourcePath: string;
  sourceState: RelationSourceState;
  formattedText: string;
  dedupeKey: string;
  selfTarget: boolean;
}

interface FrozenBatchPlan {
  planId: string;
  batchId: string;
  deskId?: string;
  ticket?: TargetTicket;
  block: boolean;
  compiled: CompiledCitationDocument;
  anchorPlans: readonly SourceAnchorPlan[];
  preparedItems: readonly PreparedBatchItem[];
  selfTargetMappings: ReadonlyMap<string, SelfTargetItemMapping>;
  issues: readonly BatchIssue[];
  skipRelationsOnCapacityExceeded: boolean;
  usesNewAnchors: boolean;
  canCommit: boolean;
}

function sameTicket(a?: TargetTicket, b?: TargetTicket): boolean {
  if (!a || !b) return false;
  return (
    a.fileRef === b.fileRef &&
    a.editorId === b.editorId &&
    a.revision === b.revision &&
    a.bindingGeneration === b.bindingGeneration &&
    a.range.from === b.range.from &&
    a.range.to === b.range.to &&
    a.baselineText === b.baselineText
  );
}

function resolveBatchLayout(
  layout: readonly CitationLayoutPart[],
  formattedByItem: ReadonlyMap<string, string>,
  skippedIds: ReadonlySet<string>,
  allSkippedPlaceholder: string,
): CitationLayoutPart[] {
  const out: CitationLayoutPart[] = [];
  let pendingHeadingIndex = -1;
  let pendingGroupId: string | null = null;
  let hadGroupItems = false;
  let activeGroupItems = 0;
  let hasGroupPlaceholder = false;

  const finalizeGroup = () => {
    if (pendingHeadingIndex >= 0 && pendingGroupId !== null && hadGroupItems && activeGroupItems === 0 && !hasGroupPlaceholder) {
      out.push({
        kind: "placeholder",
        id: `placeholder:${pendingGroupId}`,
        text: allSkippedPlaceholder,
        reason: "all-skipped",
        groupId: pendingGroupId,
      });
    }
    pendingHeadingIndex = -1;
    pendingGroupId = null;
    hadGroupItems = false;
    activeGroupItems = 0;
    hasGroupPlaceholder = false;
  };

  for (const part of layout) {
    if (part.kind === "heading") {
      finalizeGroup();
      pendingHeadingIndex = out.length;
      pendingGroupId = part.groupId;
      out.push(part);
      continue;
    }
    if (part.kind === "citation") {
      if (pendingHeadingIndex >= 0) hadGroupItems = true;
      if (skippedIds.has(part.itemId)) continue;
      const text = formattedByItem.get(part.itemId) ?? part.text;
      if (!text.trim()) continue;
      if (pendingHeadingIndex >= 0) activeGroupItems++;
      out.push({ ...part, text });
      continue;
    }
    if (part.kind === "note") {
      if (part.itemId && skippedIds.has(part.itemId)) continue;
      out.push(part);
      continue;
    }
    if (part.kind === "placeholder") {
      if (pendingHeadingIndex >= 0) hasGroupPlaceholder = true;
      out.push(part);
    }
  }
  finalizeGroup();
  return out;
}

export class CitationEngine {
  private inserted = new Set<string>();
  private running = new Map<string, Promise<EngineOutcome>>();
  private committed = new Map<string, EngineOutcome>();
  private reservations = new Map<string, Promise<EngineOutcome>>();
  private targets = new Map<string, Promise<unknown>>();
  private authorizations = new Map<string, { key: string; token: string }>();
  private batchPlans = new Map<string, FrozenBatchPlan>();
  private planBatchIds = new Map<string, string>();
  private batchRunning = new Map<string, Promise<BatchCommitOutcome>>();
  private batchCommitted = new Map<string, BatchCommitOutcome>();
  private activeBatchKeys = new Map<string, Promise<BatchCommitOutcome>>();

  constructor(private ports: EnginePorts) {}

  execute(intent: CitationIntent, options: ExecutionOptions = {}): Promise<EngineOutcome> {
    const existing = this.running.get(intent.operationId);
    if (existing) return existing;
    const completed = this.committed.get(intent.operationId);
    if (completed) return Promise.resolve(completed);
    const key = intent.action === "insert" && options.ticket ? this.computeDuplicateKey(
      options.ticket.fileRef,
      intent.snapshot.sourceRef,
      intent.spans,
      intent.snapshot.spans,
      intent.mode,
      intent.selectionKey,
      intent.content,
    ) : "";
    const reserved = key ? this.reservations.get(key) : undefined;
    if (reserved) return reserved;
    const activeBatch = key ? this.activeBatchKeys.get(key) : undefined;
    if (activeBatch) {
      return activeBatch.then((batchOutcome) => this.singleOutcomeFromBatch(intent, batchOutcome));
    }

    const job = this.run(intent, options, key).then((outcome) => {
      if (outcome.effect !== "none") this.committed.set(intent.operationId, outcome);
      return outcome;
    }).finally(() => {
      this.running.delete(intent.operationId);
      if (key && this.reservations.get(key) === job) this.reservations.delete(key);
    });
    this.running.set(intent.operationId, job);
    if (key) this.reservations.set(key, job);
    return job;
  }

  private singleOutcomeFromBatch(intent: CitationIntent, batch: BatchCommitOutcome): EngineOutcome {
    const matched = batch.items.find((item) => item.operationId === intent.operationId);
    return {
      operationId: intent.operationId,
      status: batch.status,
      sourceAnchor: "unchanged",
      effect: batch.effect,
      recording: batch.recording,
      precision: matched?.precision ?? "file",
      code: batch.code,
      targetPath: batch.targetPath,
    };
  }

  private computeDuplicateKey(
    targetFileRef: string,
    sourceRef: string,
    spans: readonly OriginSpan[],
    allSourceSpans: readonly OriginSpan[],
    mode: "block" | "fragment" | "selection",
    selectionKey: string | undefined,
    content: string,
  ): string {
    const first = spans[0];
    const signature = (span: OriginSpan) => `${span.kind}:${stripInlineBlockId(span.rawText, span.kind, span.existingBlockId)}`;
    const sig = first ? signature(first) : "";
    const matching = allSourceSpans.filter((span) => signature(span) === sig);
    const occurrence = matching.findIndex((span) => span.blockKey === first?.blockKey);
    return JSON.stringify([targetFileRef, sourceRef, sig, occurrence, mode, mode === "block" ? "" : selectionKey, content]);
  }

  private computeSavedSnapshotDedupeKey(targetFileRef: string, item: SavedSnapshotEvidenceInput): string {
    const first = item.snapshot.origins[0];
    return JSON.stringify([
      targetFileRef,
      item.sourceRef ?? item.snapshot.source.capturedPath,
      "saved-snapshot",
      first?.range.from ?? 0,
      item.snapshot.mode,
      item.snapshot.content,
    ]);
  }

  private async run(intent: CitationIntent, options: ExecutionOptions, key: string): Promise<EngineOutcome> {
    const result: EngineOutcome = { operationId: intent.operationId, status: "blocked", sourceAnchor: "unchanged", effect: "none", recording: "not-attempted", precision: "file" };
    const checkCancelled = () => { if (options.signal?.aborted) throw new CitationError("OPERATION_CANCELLED"); };
    const ticket = options.ticket;
    const validateTarget = () => { if (intent.action === "insert") { if (!ticket) throw new CitationError("TARGET_MISSING"); this.ports.editors.validate(ticket); } };
    try {
      checkCancelled();
      if (!intent.content.trim()) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
      validateTarget();
      this.ports.editors.path(intent.snapshot.sourceRef);
      let inspection: SourceInspection;
      try { inspection = await this.ports.sources.inspect(intent.snapshot, intent.spans); }
      catch (error) {
        if (!(error instanceof CitationError) || error.code !== "SOURCE_STALE" || !options.staleSnapshot || options.fallback !== "file") throw error;
        inspection = { text: intent.snapshot.text, spans: [...intent.spans], canCreate: false };
      }
      checkCancelled(); validateTarget();
      if (intent.spans[0]?.existingBlockId && !inspection.id && !options.fallback) throw new CitationError("ANCHOR_WRITE_FAILED");
      const selfTarget = ticket?.fileRef === intent.snapshot.sourceRef;
      const allowNew = !options.fallback && this.ports.settings().blockPrecision && this.ports.anchorWritesEnabled() && !selfTarget;
      result.precision = this.precision(intent.mode, intent.spans.length, inspection, allowNew, options.fallback);
      const plannedId = options.fallback ? undefined : inspection.id ?? (allowNew && inspection.canCreate ? "slipstream-preview" : undefined);
      this.format(intent, result.precision, plannedId, inspection.heading, options.ticket);
      const authorizationKey = JSON.stringify([key, ticket?.revision, ticket?.editorId, ticket?.bindingGeneration, intent.snapshot.text]);
      if (key && this.ports.settings().dedupe && this.inserted.has(key)) {
        const authorization = this.authorizations.get(intent.operationId);
        if (!authorization || authorization.key !== authorizationKey || authorization.token !== options.duplicateAuthorization) {
          const token = crypto.randomUUID();
          this.authorizations.set(intent.operationId, { key: authorizationKey, token });
          result.duplicateAuthorization = token;
          throw new CitationError("DUPLICATE");
        }
      }
      if (allowNew && !inspection.id && inspection.canCreate && !this.ports.consentAccepted()) throw new CitationError("CONSENT_REQUIRED");
      if (selfTarget && !inspection.id && !options.fallback) throw new CitationError("ANCHOR_WRITE_FAILED");
      const previous = ticket ? this.targets.get(ticket.fileRef) ?? Promise.resolve() : Promise.resolve();
      const job = previous.catch(() => {}).then(async () => {
        checkCancelled(); validateTarget();
        let id = options.fallback ? undefined : inspection.id;
        let heading = options.fallback === "file" ? undefined : inspection.heading;
        if (!options.staleSnapshot) {
          const anchor = await this.ports.sources.ensure(intent.snapshot, intent.spans, allowNew, () => !!options.signal?.aborted);
          result.sourceAnchor = anchor.kind === "unavailable" ? "unchanged" : anchor.kind;
          id = options.fallback ? undefined : anchor.id;
          heading = options.fallback === "file" ? undefined : anchor.heading;
          result.precision = this.precision(intent.mode, intent.spans.length, anchor, false, options.fallback);
        }
        checkCancelled(); validateTarget();
        const text = this.format(intent, result.precision, id, heading, options.ticket);
        const sourcePath = this.ports.editors.path(intent.snapshot.sourceRef);
        let receipt: CommitReceipt | undefined;
        if (intent.action === "insert") {
          receipt = this.ports.editors.commit(ticket!, text, intent.templateId !== "B" || intent.content.includes("\n"));
          result.effect = "inserted";
          result.targetPath = receipt.targetPath;
          this.inserted.add(key);
        } else {
          await this.ports.editors.copy(text);
          result.effect = "copied";
        }
        result.status = "success";
        this.authorizations.delete(intent.operationId);
        if (!this.ports.records.enabled) { result.recording = "disabled"; return; }
        const at = Date.now();
        const relation: CitationRelation | undefined = receipt ? {
          id: `relation:${intent.operationId}`, operationId: intent.operationId, at, sourcePath, targetPath: receipt.targetPath,
          sourceSpans: intent.spans.map((span) => ({ range: { ...span.rawRange }, rawText: span.rawText, kind: span.kind })),
          content: intent.content, insertedText: receipt.text, blockId: id, heading, precision: result.precision,
          sourceState: options.staleSnapshot ? "stale-snapshot" : "verified", template: intent.templateId,
          targetHint: { range: receipt.range, before: receipt.before, after: receipt.after },
        } : undefined;
        try {
          result.recording = await this.ports.records.record({ id: `history:${intent.operationId}`, operationId: intent.operationId, at,
            action: intent.action, sourcePath, targetPath: receipt?.targetPath, blockId: id, heading, precision: result.precision,
            template: intent.templateId, snippet: intent.content.slice(0, 120), text }, relation);
        } catch { result.recording = "pending"; }
        if (result.recording === "pending" || result.recording === "capacity-exceeded") {
          result.status = "partial";
          result.code = result.recording === "pending" ? "RECORD_SAVE_FAILED" : "RECORD_CAPACITY_EXCEEDED";
        }
      });
      if (ticket) this.targets.set(ticket.fileRef, job);
      try { await job; } finally { if (ticket && this.targets.get(ticket.fileRef) === job) this.targets.delete(ticket.fileRef); }
      return result;
    } catch (error) {
      const code = error instanceof CitationError ? error.code : "COMMIT_STATE_UNCERTAIN";
      result.code = code;
      if (code === "COMMIT_STATE_UNCERTAIN") { result.status = "uncertain"; result.effect = "unknown"; if (result.sourceAnchor === "unchanged") result.sourceAnchor = "unknown"; }
      else if (result.effect !== "none") { result.status = "partial"; result.recording = "pending"; result.code = "RECORD_SAVE_FAILED"; }
      else if (result.sourceAnchor === "created") result.status = "partial";
      else if (code === "OPERATION_CANCELLED") result.status = "cancelled";
      else result.status = ["ANCHOR_WRITE_FAILED", "CLIPBOARD_DENIED", "TARGET_COMMIT_FAILED", "SOURCE_READ_FAILED"].includes(code) ? "failed" : "blocked";
      return result;
    }
  }

  /** Read-only preflight and plan freeze for single entry, group, or full outline batch insertion. */
  async prepareBatch(request: CitationBatchRequest): Promise<CitationBatchPlan> {
    if (request.signal.aborted) throw new CitationError("OPERATION_CANCELLED");
    const settings = this.ports.settings();
    const consentAccepted = this.ports.consentAccepted();
    const anchorWritesEnabled = this.ports.anchorWritesEnabled();
    const issues: BatchIssue[] = [];
    const blockMode = request.block ?? true;

    let targetValid = false;
    if (!request.ticket) {
      issues.push({ code: "TARGET_MISSING", blocking: true, options: ["select-target"], reason: "Target position not confirmed" });
    } else {
      try {
        this.ports.editors.validate(request.ticket);
        targetValid = true;
      } catch (error) {
        const code = error instanceof CitationError ? error.code : "TARGET_MISSING";
        issues.push({ code, blocking: true, options: ["relocate-target"], reason: `Target validation failed: ${code}` });
      }
    }

    const skippedIds = new Set(request.items.filter((item) => item.skipped).map((item) => item.itemId));
    const activeItems = request.items.filter((item) => !item.skipped);
    const liveItems = activeItems.filter((item): item is VerifiedLiveEvidenceInput => item.kind === "verified-live");

    // 1. Read-only anchor planning per source file (never writes IDs during preview).
    const anchorPlans: SourceAnchorPlan[] = [];
    const plannedAnchorByItem = new Map<string, { id?: string; heading?: string; canCreate: boolean; kind: "reused" | "planned" | "unavailable" }>();
    const liveBySource = new Map<string, VerifiedLiveEvidenceInput[]>();
    for (const item of liveItems) {
      if (!item.content.trim()) {
        issues.push({ code: "SOURCE_MAPPING_UNSUPPORTED", itemId: item.itemId, blocking: true, options: ["skip", "refresh"], reason: "Empty citation content" });
        continue;
      }
      const list = liveBySource.get(item.snapshot.sourceRef) ?? [];
      list.push(item);
      liveBySource.set(item.snapshot.sourceRef, list);
    }

    for (const [sourceRef, group] of liveBySource) {
      if (request.signal.aborted) throw new CitationError("OPERATION_CANCELLED");
      try {
        const selfTarget = request.ticket?.fileRef === sourceRef;
        const plans = await this.ports.sources.prepareMany(
          group.map((item) => ({
            itemId: item.itemId,
            snapshot: item.snapshot,
            spans: item.spans,
            allowNew: !item.fallback && settings.blockPrecision && anchorWritesEnabled && !selfTarget,
            fallback: item.fallback,
          })),
        );
        for (const plan of plans) {
          anchorPlans.push(plan);
          for (const planned of plan.items) plannedAnchorByItem.set(planned.itemId, planned);
        }
      } catch (error) {
        if (error instanceof CitationError && error.code === "OPERATION_CANCELLED") throw error;
        const code = error instanceof CitationError ? error.code : "SOURCE_READ_FAILED";
        for (const item of group) {
          issues.push({ code, itemId: item.itemId, sourcePath: item.snapshot.title, blocking: true, options: ["refresh", "skip", "use-snapshot"], reason: `Source inspection failed: ${code}` });
        }
      }
    }

    anchorPlans.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    const usesNewAnchors = anchorPlans.some((plan) => plan.edits.length > 0);
    if (usesNewAnchors && !consentAccepted) {
      issues.push({ code: "CONSENT_REQUIRED", blocking: true, options: ["accept-consent", "disable-block-ids"], reason: "Block ID consent not yet saved" });
    }

    // 2. Format each non-skipped item and validate template / links / self-target anchors / dedupe.
    const formattedByItem = new Map<string, string>();
    const preparedItems: PreparedBatchItem[] = [];
    const seenBatchKeys = new Set<string>();
    const opByItem = new Map<string, string>();
    for (const part of request.layout) {
      if (part.kind === "citation") opByItem.set(part.itemId, part.operationId);
    }

    for (const item of activeItems) {
      if (request.signal.aborted) throw new CitationError("OPERATION_CANCELLED");
      const operationId = opByItem.get(item.itemId) ?? `${request.batchId}:${item.itemId}`;
      if (item.kind === "verified-live") {
        const anchor = plannedAnchorByItem.get(item.itemId);
        if (!anchor) continue;
        const selfTarget = request.ticket?.fileRef === item.snapshot.sourceRef;
        if (selfTarget && !anchor.id && !item.fallback) {
          issues.push({ code: "ANCHOR_WRITE_FAILED", itemId: item.itemId, blocking: true, options: ["fallback", "use-snapshot", "skip"], reason: "Self-target source has no existing verified block ID" });
        }
        const precision = this.precision(item.mode, item.spans.length, {
          text: item.snapshot.text, spans: [...item.spans], id: anchor.id, canCreate: anchor.canCreate, heading: anchor.heading,
        }, false, item.fallback);
        const heading = item.fallback === "file" ? undefined : anchor.heading;
        const id = item.fallback ? undefined : anchor.id;
        let formattedText = "";
        try {
          formattedText = this.formatLiveItem(item, precision, id, heading, request.ticket);
        } catch (error) {
          const code = error instanceof CitationError ? error.code : "TEMPLATE_INVALID";
          issues.push({ code, itemId: item.itemId, blocking: true, options: ["use-A", "use-B", "skip"], reason: `Formatting failed: ${code}` });
          continue;
        }
        formattedByItem.set(item.itemId, formattedText);
        const dedupeKey = request.ticket
          ? this.computeDuplicateKey(request.ticket.fileRef, item.snapshot.sourceRef, item.spans, item.snapshot.spans, item.mode, item.selectionKey, item.content)
          : "";
        if (dedupeKey && settings.dedupe && (this.inserted.has(dedupeKey) || seenBatchKeys.has(dedupeKey)) && !item.duplicateAuthorized) {
          issues.push({ code: "BATCH_DUPLICATE", itemId: item.itemId, blocking: true, options: ["insert-again", "skip"], reason: "Duplicate fragment for target" });
        }
        if (dedupeKey) seenBatchKeys.add(dedupeKey);
        preparedItems.push({
          input: item,
          operationId,
          precision,
          blockId: id,
          heading,
          sourcePath: this.ports.editors.path(item.snapshot.sourceRef),
          sourceState: "verified",
          formattedText,
          dedupeKey,
          selfTarget,
        });
      } else {
        if (!item.snapshot.content.trim()) {
          issues.push({ code: "SOURCE_MAPPING_UNSUPPORTED", itemId: item.itemId, blocking: true, options: ["skip"], reason: "Empty saved snapshot content" });
          continue;
        }
        let formattedText = "";
        try {
          formattedText = this.formatSavedSnapshot(item, request.ticket);
        } catch (error) {
          const code = error instanceof CitationError ? error.code : "TEMPLATE_INVALID";
          issues.push({ code, itemId: item.itemId, blocking: true, options: ["use-A", "use-B", "skip"], reason: `Snapshot formatting failed: ${code}` });
          continue;
        }
        formattedByItem.set(item.itemId, formattedText);
        const dedupeKey = request.ticket ? this.computeSavedSnapshotDedupeKey(request.ticket.fileRef, item) : "";
        if (dedupeKey && settings.dedupe && (this.inserted.has(dedupeKey) || seenBatchKeys.has(dedupeKey)) && !item.duplicateAuthorized) {
          issues.push({ code: "BATCH_DUPLICATE", itemId: item.itemId, blocking: true, options: ["insert-again", "skip"], reason: "Duplicate saved snapshot for target" });
        }
        if (dedupeKey) seenBatchKeys.add(dedupeKey);
        const resolvedPath = item.sourceRef ? this.ports.editors.path(item.sourceRef) : item.snapshot.source.path;
        preparedItems.push({
          input: item,
          operationId,
          precision: "file",
          sourcePath: resolvedPath,
          sourceState: item.sourceState,
          formattedText,
          dedupeKey,
          selfTarget: !!request.ticket && item.sourceRef === request.ticket.fileRef,
        });
      }
    }

    // 3. Compile Markdown document & run AC-39 / AC-41 / AC-40 checks.
    const labels = { ...DEFAULT_DOCUMENT_LABELS, ...request.labels };
    const resolvedLayout = resolveBatchLayout(request.layout, formattedByItem, skippedIds, labels.allSkippedPlaceholder);
    const compiled = compileCitationDocument(resolvedLayout, labels);

    if (compiled.isEmpty) {
      issues.push({ code: "EMPTY_OUTPUT", blocking: true, options: [], reason: "Compiled Markdown output is empty" });
    } else if (compiled.includedItemCount === 0 && compiled.hasSkeleton && !request.skeletonConfirmed) {
      issues.push({ code: "SKELETON_CONFIRMATION_REQUIRED", blocking: true, options: ["confirm-skeleton", "cancel"], reason: "Only skeleton headings/placeholders remain" });
    }

    for (const boundaryIssue of checkMarkdownBoundaries(compiled)) {
      issues.push({ code: boundaryIssue.code, itemId: boundaryIssue.itemId, blocking: true, options: ["use-A", "use-B", "skip"], reason: boundaryIssue.reason });
    }

    const selfTargetMappings = new Map<string, SelfTargetItemMapping>();
    if (targetValid && request.ticket && !compiled.isEmpty) {
      for (const boundaryIssue of checkTargetInsertionBoundaries(request.ticket.baselineText, request.ticket.range, compiled, blockMode)) {
        issues.push({ code: boundaryIssue.code, itemId: boundaryIssue.itemId, blocking: true, options: ["relocate-target", "use-A", "skip"], reason: boundaryIssue.reason });
      }
      const selfLiveItems = preparedItems.filter((item): item is PreparedBatchItem & { input: VerifiedLiveEvidenceInput } => item.selfTarget && item.input.kind === "verified-live");
      if (selfLiveItems.length > 0) {
        const prediction = this.ports.sources.predictSelfTarget({
          baselineText: request.ticket.baselineText,
          bodyStart: selfLiveItems[0].input.snapshot.bodyStart,
          ticketRange: request.ticket.range,
          compiledMarkdown: compiled.markdown,
          block: blockMode,
          items: selfLiveItems.map((item) => ({
            itemId: item.input.itemId,
            spans: item.input.spans,
            expectedBlockId: item.blockId,
            expectedHeading: item.heading,
            precision: item.precision,
          })),
        });
        for (const conflict of prediction.conflicts) {
          issues.push({ code: conflict.code, itemId: conflict.itemId, blocking: true, options: ["relocate-target", "use-snapshot", "skip"], reason: conflict.reason });
        }
        for (const [itemId, mapping] of prediction.mappings) {
          selfTargetMappings.set(itemId, mapping);
        }
      }
    }

    // 4. Capacity preflight across all batch relations.
    let recording: CitationBatchPlan["recording"] = "disabled";
    if (this.ports.records.enabled) {
      const targetPath = targetValid && request.ticket ? this.ports.editors.path(request.ticket.fileRef) : "pending-target.md";
      const candidateRelations = this.buildCandidateRelations(request.batchId, compiled, preparedItems, selfTargetMappings, targetPath);
      if (candidateRelations.length > 0 && !this.ports.records.canFitRelations(candidateRelations) && !request.skipRelationsOnCapacityExceeded) {
        recording = "capacity-choice-required";
        issues.push({ code: "RELATION_CAPACITY", blocking: true, options: ["skip-relations", "reduce-scope", "cancel"], reason: "Relation snapshot capacity exceeded" });
      } else {
        recording = "enabled";
      }
    }

    const planId = crypto.randomUUID();
    const canCommit = !compiled.isEmpty && targetValid && !issues.some((issue) => issue.blocking);
    this.planBatchIds.set(planId, request.batchId);
    this.batchPlans.set(planId, {
      planId,
      batchId: request.batchId,
      deskId: request.deskId,
      ticket: request.ticket ? { ...request.ticket, range: { ...request.ticket.range } } : undefined,
      block: blockMode,
      compiled,
      anchorPlans,
      preparedItems,
      selfTargetMappings,
      issues,
      skipRelationsOnCapacityExceeded: !!request.skipRelationsOnCapacityExceeded,
      usesNewAnchors,
      canCommit,
    });

    return {
      planId,
      batchId: request.batchId,
      markdown: compiled.markdown,
      isEmpty: compiled.isEmpty,
      includedItemCount: compiled.includedItemCount,
      hasSkeleton: compiled.hasSkeleton,
      citationSlices: compiled.citationSlices,
      layoutSlices: compiled.layoutSlices,
      issues,
      anchorPlans,
      recording,
      canCommit,
    };
  }

  /** Releases an unconsumed batch plan and cleans its batchId mapping unless a commit is active or completed. */
  releaseBatchPlan(planId: string): void {
    this.batchPlans.delete(planId);
    const batchId = this.planBatchIds.get(planId);
    if (batchId && !this.batchRunning.has(batchId) && !this.batchCommitted.has(batchId)) {
      this.planBatchIds.delete(planId);
    }
  }

  /** Executes a frozen, preflight-verified batch plan with at most one target commit. */
  commitBatch(planId: string, options: BatchCommitOptions): Promise<BatchCommitOutcome> {
    const knownBatchId = this.planBatchIds.get(planId);
    if (knownBatchId) {
      const existing = this.batchRunning.get(knownBatchId);
      if (existing) return existing;
      const completed = this.batchCommitted.get(knownBatchId);
      if (completed) return Promise.resolve(completed);
    }
    const frozen = this.batchPlans.get(planId);
    if (!frozen) {
      return Promise.resolve({
        batchId: "",
        planId,
        status: "blocked",
        effect: "none",
        recording: "not-attempted",
        code: "PLAN_STALE",
        includedItemCount: 0,
        hasSkeleton: false,
        sourceResults: [],
        items: [],
      });
    }
    const existing = this.batchRunning.get(frozen.batchId);
    if (existing) return existing;
    const completed = this.batchCommitted.get(frozen.batchId);
    if (completed) return Promise.resolve(completed);

    const keys = [...new Set(frozen.preparedItems.map((item) => item.dedupeKey).filter(Boolean))];
    const job = this.runBatch(frozen, options).then((outcome) => {
      if (outcome.effect !== "none") this.batchCommitted.set(frozen.batchId, outcome);
      return outcome;
    }).finally(() => {
      this.batchRunning.delete(frozen.batchId);
      for (const key of keys) {
        if (this.activeBatchKeys.get(key) === job) this.activeBatchKeys.delete(key);
      }
    });
    this.batchRunning.set(frozen.batchId, job);
    for (const key of keys) this.activeBatchKeys.set(key, job);
    return job;
  }

  private async runBatch(frozen: FrozenBatchPlan, options: BatchCommitOptions): Promise<BatchCommitOutcome> {
    const outcome: BatchCommitOutcome = {
      batchId: frozen.batchId,
      planId: frozen.planId,
      status: "blocked",
      effect: "none",
      recording: "not-attempted",
      includedItemCount: frozen.compiled.includedItemCount,
      hasSkeleton: frozen.compiled.hasSkeleton,
      sourceResults: [],
      items: [],
    };
    const sourceResults: SourceAnchorWriteResult[] = [];
    const checkCancelled = () => {
      if (options.signal.aborted) throw new CitationError("OPERATION_CANCELLED");
    };

    try {
      checkCancelled();
      if (frozen.compiled.isEmpty || !frozen.compiled.markdown.trim()) throw new CitationError("EMPTY_OUTPUT");
      if (!frozen.canCommit || frozen.issues.some((i) => i.blocking)) throw new CitationError("PLAN_STALE");
      const ticket = options.ticket ?? frozen.ticket;
      if (!ticket) throw new CitationError("TARGET_MISSING");
      if (!sameTicket(ticket, frozen.ticket)) throw new CitationError("PLAN_STALE");
      this.ports.editors.validate(ticket);
      if (frozen.usesNewAnchors && (!this.ports.anchorWritesEnabled() || !this.ports.settings().blockPrecision || !this.ports.consentAccepted())) {
        throw new CitationError("ANCHOR_PLAN_CHANGED");
      }

      const previous = this.targets.get(ticket.fileRef) ?? Promise.resolve();
      const targetJob = previous.catch(() => {}).then(async () => {
        checkCancelled();
        if (frozen.compiled.isEmpty || !frozen.compiled.markdown.trim()) throw new CitationError("EMPTY_OUTPUT");
        this.ports.editors.validate(ticket);

        // Re-check dedupe after acquiring the target queue; another single/batch commit may have run while waiting.
        if (this.ports.settings().dedupe) {
          for (const item of frozen.preparedItems) {
            if (item.dedupeKey && this.inserted.has(item.dedupeKey) && !item.input.duplicateAuthorized) {
              throw new CitationError("DUPLICATE");
            }
          }
        }

        // Consume the frozen plan before any source anchor writes so failed attempts require re-previewing.
        this.batchPlans.delete(frozen.planId);

        // Write necessary source anchors sequentially per source file.
        for (const plan of frozen.anchorPlans) {
          checkCancelled();
          try {
            const applied = await this.ports.sources.ensurePlanned(plan, () => options.signal.aborted);
            sourceResults.push({
              sourceRef: applied.sourceRef,
              sourcePath: applied.sourcePath,
              kind: applied.editsApplied > 0 ? "created" : applied.reusedIds.length > 0 ? "reused" : "unchanged",
              createdIds: applied.createdIds,
              reusedIds: applied.reusedIds,
            });
          } catch (error) {
            const code = error instanceof CitationError ? error.code : "ANCHOR_WRITE_FAILED";
            sourceResults.push({
              sourceRef: plan.sourceRef,
              sourcePath: plan.sourcePath,
              kind: code === "COMMIT_STATE_UNCERTAIN" ? "unknown" : "failed",
              createdIds: [],
              reusedIds: [],
              code,
            });
            throw error;
          }
        }

        checkCancelled();
        if (!frozen.compiled.markdown.trim()) throw new CitationError("EMPTY_OUTPUT");

        const watchedRefs = new Set(frozen.anchorPlans.map((plan) => plan.sourceRef));
        for (const item of frozen.preparedItems) {
          if (item.input.kind === "verified-live") watchedRefs.add(item.input.snapshot.sourceRef);
          else if (item.input.sourceRef) watchedRefs.add(item.input.sourceRef);
        }
        let sourcesChanged = false;
        const unwatchSources = watchedRefs.size > 0
          ? (this.ports.editors.watchSourceChanges?.(watchedRefs, () => { sourcesChanged = true; })
            ?? this.ports.editors.onContentChanged?.((ref) => { if (watchedRefs.has(ref)) sourcesChanged = true; }))
          : undefined;
        let receipt: CommitReceipt;
        try {
          await this.verifyBatchSources(frozen, checkCancelled);
          checkCancelled();

          // Re-check self-target safety right before target dispatch.
          const selfLiveItems = frozen.preparedItems.filter(
            (item): item is PreparedBatchItem & { input: VerifiedLiveEvidenceInput } => item.selfTarget && item.input.kind === "verified-live",
          );
          if (selfLiveItems.length > 0) {
            const prediction = this.ports.sources.predictSelfTarget({
              baselineText: ticket.baselineText,
              bodyStart: selfLiveItems[0].input.snapshot.bodyStart,
              ticketRange: ticket.range,
              compiledMarkdown: frozen.compiled.markdown,
              block: frozen.block,
              items: selfLiveItems.map((item) => ({
                itemId: item.input.itemId,
                spans: item.input.spans,
                expectedBlockId: item.blockId,
                expectedHeading: item.heading,
                precision: item.precision,
              })),
            });
            if (prediction.conflicts.length > 0) throw new CitationError("SELF_SOURCE_CONFLICT");
          }

          // Keep source checks, target validation, and dispatch in one synchronous section.
          if (sourcesChanged) throw new CitationError("SOURCE_STALE");
          this.assertBatchSourcesCurrent(frozen);
          this.ports.editors.validate(ticket);
          receipt = this.ports.editors.commit(ticket, frozen.compiled.markdown, frozen.block);
          outcome.effect = "inserted";
          outcome.status = "success";
          outcome.targetPath = receipt.targetPath;
        } finally {
          unwatchSources?.();
        }

        for (const item of frozen.preparedItems) {
          if (item.dedupeKey) this.inserted.add(item.dedupeKey);
        }

        // Synchronously freeze recording eligibility and monotonic commit sequence immediately after commit.
        const freeze = this.ports.records.freezeBatchCommit(frozen.compiled.citationSlices.length > 0);
        outcome.at = freeze.at;
        outcome.commitSequence = freeze.commitSequence;

        const preparedById = new Map(frozen.preparedItems.map((item) => [item.input.itemId, item]));
        const recordItems: BatchCitationRecordItem[] = [];
        const itemResults: BatchCommitItemResult[] = [];

        for (const slice of frozen.compiled.citationSlices) {
          const item = preparedById.get(slice.itemId);
          if (!item) continue;
          const sliceReceipt = mapBatchSliceReceipt(receipt, frozen.compiled.markdown, slice.range);
          itemResults.push({
            itemId: item.input.itemId,
            operationId: slice.operationId,
            entryId: item.input.entryId,
            contentRevision: item.input.contentRevision,
            precision: item.precision,
            sourceState: item.sourceState,
            targetRange: sliceReceipt.range,
            insertedText: sliceReceipt.text,
          });
          const mappedSelf = frozen.selfTargetMappings.get(item.input.itemId);
          const sourceSpans = mappedSelf
            ? mappedSelf.mappedSpans.map((s) => ({ range: { ...s.range }, rawText: s.rawText, kind: s.kind }))
            : item.input.kind === "verified-live"
              ? item.input.spans.map((s) => ({ range: { ...s.rawRange }, rawText: s.rawText, kind: s.kind }))
              : item.input.snapshot.origins.map((o) => ({ range: { ...o.range }, rawText: o.rawText, kind: o.kind }));
          const contentText = item.input.kind === "verified-live" ? item.input.content : item.input.snapshot.content;

          const history: CitationHistoryEntry = {
            id: `history:${slice.operationId}`,
            operationId: slice.operationId,
            at: freeze.at,
            action: "insert",
            sourcePath: item.sourcePath,
            targetPath: receipt.targetPath,
            blockId: item.blockId,
            heading: item.heading,
            precision: item.precision,
            template: item.input.templateId,
            snippet: contentText.slice(0, 120),
            text: sliceReceipt.text,
          };
          const relation: CitationRelation = {
            id: `relation:${slice.operationId}`,
            operationId: slice.operationId,
            batchId: frozen.batchId,
            at: freeze.at,
            sourcePath: item.sourcePath,
            targetPath: receipt.targetPath,
            sourceSpans,
            content: contentText,
            insertedText: sliceReceipt.text,
            blockId: item.blockId,
            heading: item.heading,
            precision: item.precision,
            sourceState: item.sourceState,
            template: item.input.templateId,
            targetHint: { range: sliceReceipt.range, before: sliceReceipt.before, after: sliceReceipt.after },
          };
          recordItems.push({
            operationId: slice.operationId,
            entryId: item.input.entryId,
            contentRevision: item.input.contentRevision,
            history,
            relation,
          });
        }
        outcome.items = itemResults;

        if (!freeze.recordingEligible) {
          outcome.recording = "disabled";
          return;
        }

        try {
          outcome.recording = await this.ports.records.recordBatch({
            batchId: frozen.batchId,
            deskId: frozen.deskId,
            targetPath: receipt.targetPath,
            at: freeze.at,
            commitSequence: freeze.commitSequence,
            recordingEligible: true,
            skipRelations: frozen.skipRelationsOnCapacityExceeded,
            items: recordItems,
          });
        } catch {
          outcome.recording = "pending";
        }
        if (outcome.recording === "pending" || outcome.recording === "capacity-exceeded") {
          outcome.status = "partial";
          outcome.code = outcome.recording === "pending" ? "RECORD_SAVE_FAILED" : "RECORD_CAPACITY_EXCEEDED";
        }
      });

      this.targets.set(ticket.fileRef, targetJob);
      try { await targetJob; } finally { if (this.targets.get(ticket.fileRef) === targetJob) this.targets.delete(ticket.fileRef); }
      outcome.sourceResults = sourceResults;
      return outcome;
    } catch (error) {
      outcome.sourceResults = sourceResults;
      const anyCreated = sourceResults.some((sr) => sr.createdIds.length > 0);
      const code = error instanceof CitationError ? error.code : "COMMIT_STATE_UNCERTAIN";
      outcome.code = code;
      if (code === "COMMIT_STATE_UNCERTAIN") {
        outcome.status = "uncertain";
        outcome.effect = "unknown";
      } else if (outcome.effect !== "none") {
        outcome.status = "partial";
        outcome.recording = "pending";
        outcome.code = "RECORD_SAVE_FAILED";
      } else if (anyCreated) {
        outcome.status = "partial";
      } else if (code === "OPERATION_CANCELLED") {
        outcome.status = "cancelled";
      } else {
        outcome.status = ["ANCHOR_WRITE_FAILED", "CLIPBOARD_DENIED", "TARGET_COMMIT_FAILED", "SOURCE_READ_FAILED"].includes(code)
          ? "failed"
          : "blocked";
      }
      return outcome;
    }
  }

  private async verifyBatchSources(frozen: FrozenBatchPlan, checkCancelled: () => void): Promise<void> {
    for (const plan of frozen.anchorPlans) {
      checkCancelled();
      await this.ports.sources.verifyPlanned(plan);
    }
    const coveredSourceRefs = new Set(frozen.anchorPlans.map((plan) => plan.sourceRef));
    for (const item of frozen.preparedItems) {
      if (item.input.kind === "verified-live") {
        if (coveredSourceRefs.has(item.input.snapshot.sourceRef)) continue;
        checkCancelled();
        this.assertExpectedPath(item.input.snapshot.sourceRef, item.sourcePath);
        const currentText = await this.readSourceOrStale(item.input.snapshot.sourceRef);
        if (currentText !== item.input.snapshot.text) {
          throw new CitationError("SOURCE_STALE");
        }
      } else if (item.input.sourceRef) {
        this.assertExpectedPath(item.input.sourceRef, item.sourcePath);
      }
    }
  }

  private assertBatchSourcesCurrent(frozen: FrozenBatchPlan): void {
    const coveredSourceRefs = new Set(frozen.anchorPlans.map((plan) => plan.sourceRef));
    for (const plan of frozen.anchorPlans) {
      this.assertExpectedPath(plan.sourceRef, plan.sourcePath);
      const syncText = this.readOpenSourceSyncOrStale(plan.sourceRef);
      if (syncText !== undefined && !this.ports.sources.matchesPlannedResult(plan, syncText)) {
        throw new CitationError("SOURCE_STALE");
      }
    }
    for (const item of frozen.preparedItems) {
      if (item.input.kind === "verified-live") {
        if (coveredSourceRefs.has(item.input.snapshot.sourceRef)) continue;
        this.assertExpectedPath(item.input.snapshot.sourceRef, item.sourcePath);
        const syncText = this.readOpenSourceSyncOrStale(item.input.snapshot.sourceRef);
        if (syncText !== undefined && syncText !== item.input.snapshot.text) {
          throw new CitationError("SOURCE_STALE");
        }
      } else if (item.input.sourceRef) {
        this.assertExpectedPath(item.input.sourceRef, item.sourcePath);
      }
    }
  }

  private readOpenSourceSyncOrStale(sourceRef: string): string | undefined {
    try {
      return this.ports.editors.readOpenSourceSync?.(sourceRef);
    } catch (error) {
      if (error instanceof CitationError && error.code === "SOURCE_MISSING") {
        throw new CitationError("SOURCE_STALE");
      }
      throw error;
    }
  }

  private assertExpectedPath(sourceRef: string, expectedPath: string): void {
    let currentPath: string;
    try {
      currentPath = this.ports.editors.path(sourceRef);
    } catch (error) {
      if (error instanceof CitationError && error.code === "SOURCE_MISSING") {
        throw new CitationError("SOURCE_STALE");
      }
      throw error;
    }
    if (currentPath !== expectedPath) {
      throw new CitationError("SOURCE_STALE");
    }
  }

  private async readSourceOrStale(sourceRef: string): Promise<string> {
    try {
      return await this.ports.editors.readSource(sourceRef);
    } catch (error) {
      if (error instanceof CitationError && error.code === "SOURCE_MISSING") {
        throw new CitationError("SOURCE_STALE");
      }
      throw error;
    }
  }

  private buildCandidateRelations(
    batchId: string,
    compiled: CompiledCitationDocument,
    preparedItems: readonly PreparedBatchItem[],
    selfTargetMappings: ReadonlyMap<string, SelfTargetItemMapping>,
    targetPath: string,
  ): CitationRelation[] {
    const byId = new Map(preparedItems.map((item) => [item.input.itemId, item]));
    const relations: CitationRelation[] = [];
    for (const slice of compiled.citationSlices) {
      const item = byId.get(slice.itemId);
      if (!item) continue;
      const mappedSelf = selfTargetMappings.get(item.input.itemId);
      const sourceSpans = mappedSelf
        ? mappedSelf.mappedSpans.map((s) => ({ range: { ...s.range }, rawText: s.rawText, kind: s.kind }))
        : item.input.kind === "verified-live"
          ? item.input.spans.map((s) => ({ range: { ...s.rawRange }, rawText: s.rawText, kind: s.kind }))
          : item.input.snapshot.origins.map((o) => ({ range: { ...o.range }, rawText: o.rawText, kind: o.kind }));
      relations.push({
        id: `relation:${slice.operationId}`,
        operationId: slice.operationId,
        batchId,
        at: 0,
        sourcePath: item.sourcePath,
        targetPath,
        sourceSpans,
        content: item.input.kind === "verified-live" ? item.input.content : item.input.snapshot.content,
        insertedText: compiled.markdown.slice(slice.range.from, slice.range.to),
        blockId: item.blockId,
        heading: item.heading,
        precision: item.precision,
        sourceState: item.sourceState,
        template: item.input.templateId,
        targetHint: { range: { ...slice.range }, before: "", after: "" },
      });
    }
    return relations;
  }

  private precision(
    mode: "block" | "fragment" | "selection",
    spanCount: number,
    inspected: SourceInspection,
    allowNew: boolean,
    fallback?: "heading" | "file",
  ): Precision {
    if (fallback === "file") return "file";
    if (!fallback && (inspected.id || allowNew && inspected.canCreate)) {
      return mode === "block" ? "block" : spanCount > 1 ? "multi-block-start" : "fragment";
    }
    return inspected.heading ? "heading" : "file";
  }

  private format(
    intent: CitationIntent,
    precision: Precision,
    id: string | undefined,
    heading: string | undefined,
    ticket: TargetTicket | undefined,
  ): string {
    return this.formatSourceCitation({
      sourceRef: intent.snapshot.sourceRef,
      title: intent.snapshot.title,
      templateId: intent.templateId,
      customTemplate: intent.customTemplate,
      content: intent.content,
      wholeBlock: intent.mode === "block" && intent.spans.length === 1,
      date: intent.date,
      precision,
      id,
      heading,
      ticket,
    });
  }

  private formatLiveItem(
    item: VerifiedLiveEvidenceInput,
    precision: Precision,
    id: string | undefined,
    heading: string | undefined,
    ticket: TargetTicket | undefined,
  ): string {
    return this.formatSourceCitation({
      sourceRef: item.snapshot.sourceRef,
      title: item.snapshot.title,
      templateId: item.templateId,
      customTemplate: item.customTemplate,
      content: item.content,
      wholeBlock: item.mode === "block" && item.spans.length === 1,
      date: item.date,
      precision,
      id,
      heading,
      ticket,
    });
  }

  private formatSourceCitation(params: {
    sourceRef: string;
    title?: string;
    templateId: CitationIntent["templateId"];
    customTemplate?: string;
    content: string;
    wholeBlock: boolean;
    date: string;
    precision: Precision;
    id?: string;
    heading?: string;
    ticket?: TargetTicket;
  }): string {
    const context = params.ticket ? this.ports.editors.path(params.ticket.fileRef) : "";
    const path = this.ports.editors.path(params.sourceRef);
    const subpath = params.id ? `#^${params.id}` : params.precision === "heading" && params.heading ? `#${params.heading}` : "";
    const link = this.ports.links.link(params.sourceRef, context, params.id, params.precision === "heading" ? params.heading : undefined);
    const filename = path.split("/").pop()!.replace(/\.md$/, "");
    const text = buildCitation({
      templateId: params.templateId,
      content: params.content,
      link,
      precision: params.precision,
      wholeBlock: params.wholeBlock,
      customTemplate: params.customTemplate,
      legacyVars: {
        filename,
        path,
        title: params.title ?? filename,
        blockId: params.id ?? "",
        heading: params.heading ?? "",
        url: `obsidian://open?file=${encodeURIComponent(path)}`,
        date: params.date,
      },
    });
    this.ports.links.validate(text, params.sourceRef, context, subpath);
    return text;
  }

  private formatSavedSnapshot(item: SavedSnapshotEvidenceInput, ticket: TargetTicket | undefined): string {
    if (item.templateId === "C") throw new CitationError("TEMPLATE_REQUIRES_BLOCK");
    const content = item.snapshot.content.replace(/\r\n/g, "\n");
    const notice = "保存时摘录，非当前原文";

    if (item.sourceRef) {
      const context = ticket ? this.ports.editors.path(ticket.fileRef) : "";
      const path = this.ports.editors.path(item.sourceRef);
      const link = this.ports.links.link(item.sourceRef, context);
      const filename = path.split("/").pop()!.replace(/\.md$/, "");
      const quote = content.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
      let text: string;
      if (item.templateId === "A") {
        text = `${quote}\n> — ${link}（${notice}）`;
      } else if (item.templateId === "B") {
        text = `${content}${content.includes("\n") ? "\n\n" : " "}(${link}，${notice})`;
      } else {
        const rendered = buildCitation({
          templateId: "D",
          content,
          link,
          precision: "file",
          wholeBlock: false,
          customTemplate: item.customTemplate,
          legacyVars: {
            filename,
            path,
            title: item.snapshot.source.title || filename,
            blockId: "",
            heading: "",
            url: `obsidian://open?file=${encodeURIComponent(path)}`,
            date: item.date,
          },
        });
        text = `${rendered}\n（${notice}）`;
      }
      this.ports.links.validate(text, item.sourceRef, context, "");
      return text;
    }

    // Missing or unavailable source without verified file: only A/B allowed, never forge wikilinks or URLs.
    if (item.templateId === "D") throw new CitationError("LINK_INVALID");
    const statusLabel = item.sourceState === "missing-snapshot" ? "来源已失效" : "来源暂不可用";
    const escapedPath = escapeMarkdownText(item.snapshot.source.capturedPath);
    const attribution = `${statusLabel}，原路径：${escapedPath}（${notice}）`;
    if (item.templateId === "A") {
      const quote = content.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
      return `${quote}\n> — ${attribution}`;
    }
    return `${content}${content.includes("\n") ? "\n\n" : " "}(${attribution})`;
  }
}
