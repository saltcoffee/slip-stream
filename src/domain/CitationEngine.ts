import { buildCitation } from "./DropTemplate";
import { stripInlineBlockId } from "./BlockReference";
import { CitationError } from "./citationTypes";
import type { CitationIntent, CitationOutcome, CitationRelation, CommitReceipt, OriginSpan, Precision, TargetTicket } from "./citationTypes";
import type { Settings } from "../settings/settings";
import type { BlockIdService, SourceInspection } from "../infra/BlockIdService";
import type { CitationRecordsService } from "./CitationRecords";
import type { CitationLinkService } from "../infra/CitationLinkService";

interface EnginePorts {
  settings(): Settings;
  consentAccepted(): boolean;
  anchorWritesEnabled(): boolean;
  sources: Pick<BlockIdService, "inspect" | "ensure">;
  editors: {
    validate(ticket: TargetTicket): void;
    commit(ticket: TargetTicket, text: string, block?: boolean): CommitReceipt;
    copy(text: string): Promise<void>;
    path(ref: string): string;
  };
  links: Pick<CitationLinkService, "link" | "validate">;
  records: Pick<CitationRecordsService, "record" | "enabled">;
}
export interface ExecutionOptions {
  ticket?: TargetTicket;
  signal?: AbortSignal;
  duplicateAuthorization?: string;
  fallback?: "heading" | "file";
  staleSnapshot?: boolean;
}
export interface EngineOutcome extends CitationOutcome { duplicateAuthorization?: string }

export class CitationEngine {
  private inserted = new Set<string>();
  private running = new Map<string, Promise<EngineOutcome>>();
  private committed = new Map<string, EngineOutcome>();
  private reservations = new Map<string, Promise<EngineOutcome>>();
  private targets = new Map<string, Promise<unknown>>();
  private authorizations = new Map<string, { key: string; token: string }>();
  constructor(private ports: EnginePorts) {}

  execute(intent: CitationIntent, options: ExecutionOptions = {}): Promise<EngineOutcome> {
    const existing = this.running.get(intent.operationId);
    if (existing) return existing;
    const completed = this.committed.get(intent.operationId);
    if (completed) return Promise.resolve(completed);
    const key = intent.action === "insert" && options.ticket ? this.duplicateKey(intent, options.ticket) : "";
    const reserved = key && this.reservations.get(key);
    if (reserved) return reserved;
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
  private duplicateKey(intent: CitationIntent, ticket: TargetTicket): string {
    const first = intent.spans[0];
    const signature = (span: OriginSpan) => `${span.kind}:${stripInlineBlockId(span.rawText, span.kind, span.existingBlockId)}`;
    const sig = first ? signature(first) : "";
    const matching = intent.snapshot.spans.filter((span) => signature(span) === sig);
    const occurrence = matching.findIndex((span) => span.blockKey === first?.blockKey);
    return JSON.stringify([ticket.fileRef, intent.snapshot.sourceRef, sig, occurrence, intent.mode,
      intent.mode === "block" ? "" : intent.selectionKey, intent.content]);
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
      // Missing files are never a permissible stale-snapshot fallback.
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
      result.precision = this.precision(intent, inspection, allowNew, options);
      // Reject unsupported templates and unsafe links before any source write or prompt.
      const plannedId = options.fallback ? undefined : inspection.id ?? (allowNew && inspection.canCreate ? "slipstream-preview" : undefined);
      this.format(intent, result.precision, plannedId, inspection.heading, options);
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
          result.precision = this.precision(intent, anchor, false, options);
        }
        checkCancelled(); validateTarget();
        const text = this.format(intent, result.precision, id, heading, options);
        const sourcePath = this.ports.editors.path(intent.snapshot.sourceRef);
        let receipt: CommitReceipt | undefined;
        // No await between the final target validation and its single dispatch.
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
  private precision(intent: CitationIntent, inspected: SourceInspection, allowNew: boolean, options: ExecutionOptions): Precision {
    if (options.fallback === "file") return "file";
    if (!options.fallback && (inspected.id || allowNew && inspected.canCreate)) return intent.mode === "block" ? "block" : intent.spans.length > 1 ? "multi-block-start" : "fragment";
    return inspected.heading ? "heading" : "file";
  }
  private format(intent: CitationIntent, precision: Precision, id: string | undefined, heading: string | undefined, options: ExecutionOptions): string {
    const sourceRef = intent.snapshot.sourceRef;
    const context = options.ticket ? this.ports.editors.path(options.ticket.fileRef) : "";
    const path = this.ports.editors.path(sourceRef);
    const subpath = id ? `#^${id}` : precision === "heading" && heading ? `#${heading}` : "";
    const link = this.ports.links.link(sourceRef, context, id, precision === "heading" ? heading : undefined);
    const filename = path.split("/").pop()!.replace(/\.md$/, "");
    const text = buildCitation({ templateId: intent.templateId, content: intent.content, link, precision,
      wholeBlock: intent.mode === "block" && intent.spans.length === 1, customTemplate: intent.customTemplate,
      legacyVars: { filename, path, title: intent.snapshot.title ?? filename, blockId: id ?? "", heading: heading ?? "", url: `obsidian://open?file=${encodeURIComponent(path)}`, date: intent.date } });
    this.ports.links.validate(text, sourceRef, context, subpath);
    return text;
  }
}
