import { Component, Modal, type App } from "obsidian";
import { buildOutlineLayout, type CitationLayoutPart } from "../domain/CitationDocument";
import type { BatchCommitOutcome, BatchIssue, CitationBatchPlan, CitationEngine, SourceAnchorWriteResult } from "../domain/CitationEngine";
import type { CitationRecordsService, RecordingResult } from "../domain/CitationRecords";
import type { DeskService } from "../domain/DeskService";
import type { EvidenceResolutionStatus, EvidenceResolver, ResolvedEvidence } from "../domain/EvidenceResolver";
import type { OutlineService } from "../domain/OutlineService";
import { canonicalSelectionKey, CitationError, localDate, type CitationErrorCode, type PreparedEvidenceInput, type TargetTicket, type TemplateId } from "../domain/citationTypes";
import type { EvidenceEntry, OutlineGroup, OutlineScope } from "../domain/outlineTypes";
import type { EditorGateway } from "../infra/EditorGateway";
import type { PluginDataStore } from "../infra/PluginDataStore";
import type { Settings } from "../settings/settings";
import { t } from "../util/i18n";
import { renderPreviewBatched } from "./OutlinePreviewRenderer";

export interface OutlinePreviewDecision {
  entryId: string;
  contentRevision: number;
  sourceVersion?: number;
  templateRevision: number;
  action?: "use-live" | "confirm-relocated" | "refresh" | "skip" | "use-snapshot" | "reselect";
  templateOverride?: "A" | "B";
  fallback?: "heading" | "file";
  duplicateAuthorized?: boolean;
  selfSourceDegraded?: boolean;
}

export interface OutlinePreviewDraft {
  draftId: string;
  deskId: string;
  deskGeneration: number;
  scope: OutlineScope;
  outlineRevision: number;
  templateRevision: number;
  state: "checking" | "preview" | "suspended-target" | "suspended-source" | "committing" | "closed";
  handoff?: { kind: "target" | "source"; entryId?: string };
  decisions: Map<string, OutlinePreviewDecision>;
  skipRelationsOnCapacityExceeded?: boolean;
  skeletonConfirmed?: boolean;
}

export interface OutlineInsertModalPlugin {
  readonly app: App;
  readonly settings: Settings;
  readonly store: Pick<PluginDataStore, "blockIdConsentAccepted" | "acceptBlockIds" | "readOnly">;
  readonly editors: Pick<EditorGateway, "path" | "subscribe" | "onContentChanged">;
  readonly desks: Pick<DeskService, "get" | "generation">;
  readonly outline: OutlineService;
  readonly evidence: EvidenceResolver;
  readonly cite: CitationEngine;
  readonly history: Pick<CitationRecordsService, "retryBatch">;
  persist(): Promise<void>;
}

export interface OutlineInsertModalOptions {
  plugin: OutlineInsertModalPlugin;
  deskId: string;
  scope: OutlineScope;
  draft?: OutlinePreviewDraft;
  getTicket: () => TargetTicket | undefined;
  getTargetPath: () => string | undefined;
  getTargetError?: () => CitationErrorCode | undefined;
  getTemplateRevision?: () => number;
  openTarget?: (path?: string) => void;
  openSource?: (path: string, anchor?: string) => void;
  renderMarkdown?: (markdown: string, container: HTMLElement, sourcePath: string, component: Component) => Promise<void>;
  onSuspend: (reason: "target" | "source", draft: OutlinePreviewDraft, entryId?: string) => void;
  onCancel: (draftId: string) => void;
  onCommitted: (outcome: BatchCommitOutcome, deskId: string) => void;
  onUncertain?: (outcome: BatchCommitOutcome, deskId: string) => void;
  onPartialSources?: (outcome: BatchCommitOutcome, deskId: string) => void;
  onOutlineUpdated?: () => void;
}

const SOURCE_STATUS_KEYS: Record<Exclude<EvidenceResolutionStatus, "verified">, string> = { relocated: "outline.issueRelocated", changed: "outline.issueChanged", unlocated: "outline.issueUnlocated", missing: "outline.issueMissing", unavailable: "outline.issueUnavailable" };
const ISSUE_TITLE_KEYS: Partial<Record<BatchIssue["code"], string>> = {
  BATCH_DUPLICATE: "outline.issueDuplicate", RELATION_CAPACITY: "outline.issueCapacity",
  SELF_SOURCE_CONFLICT: "outline.issueSelfTarget", MARKDOWN_BOUNDARY_UNSAFE: "outline.issueMarkdownBoundary",
  EMPTY_OUTPUT: "outline.issueEmptyOutput", SKELETON_CONFIRMATION_REQUIRED: "outline.issueSkeletonOnly",
  CONSENT_REQUIRED: "outline.issueConsent",
};
const TARGET_ISSUE_CODES = new Set(["TARGET_MISSING", "TARGET_READONLY", "TARGET_STALE", "TARGET_MULTIPLE_SELECTIONS"]);

function addBtn(parent: HTMLElement, text: string, onClick: () => void, cls = "slipstream-btn"): HTMLButtonElement {
  const btn = parent.createEl("button", { cls, text });
  btn.addEventListener("click", onClick);
  return btn;
}

function ticketSig(ticket?: TargetTicket): string {
  return ticket ? `${ticket.fileRef}:${ticket.editorId}:${ticket.revision}:${ticket.bindingGeneration}:${ticket.range.from}:${ticket.range.to}` : "";
}

function toPreparedItem(entry: EvidenceEntry, res: ResolvedEvidence | undefined, dec: OutlinePreviewDecision | undefined, settings: Settings, date: string): PreparedEvidenceInput {
  const skipped = dec?.action === "skip";
  const templateId: TemplateId = dec?.templateOverride ?? settings.defaultTemplate;
  const customTemplate = templateId === "D" ? settings.customTemplate : undefined;
  if (!skipped && !dec?.selfSourceDegraded && res && (res.status === "verified" || res.status === "relocated") && res.liveSnapshot && res.liveSpans) {
    const selectionKey = entry.snapshot.mode === "block" ? undefined : canonicalSelectionKey(res.liveSpans, res.mappedSelectedRanges ?? entry.snapshot.selectedRanges);
    return { kind: "verified-live", itemId: entry.id, entryId: entry.id, contentRevision: entry.contentRevision, groupId: entry.groupId, note: entry.note, snapshot: res.liveSnapshot, spans: res.liveSpans, mode: entry.snapshot.mode, content: entry.snapshot.content, selectionKey, sourceVersion: res.sourceVersion, templateId, customTemplate, date, fallback: dec?.fallback, duplicateAuthorized: dec?.duplicateAuthorized };
  }
  const sourceState = res?.status === "missing" ? "missing-snapshot" : res?.status === "unavailable" ? "unavailable-snapshot" : "stale-snapshot";
  const sourceRef = res?.status === "missing" || res?.status === "unavailable" ? undefined : res?.sourceRef;
  return { kind: "saved-snapshot", itemId: entry.id, entryId: entry.id, contentRevision: entry.contentRevision, groupId: entry.groupId, note: entry.note, snapshot: entry.snapshot, sourceRef, sourceState, sourceVersion: res?.sourceVersion, templateId, customTemplate, date, skipped, duplicateAuthorized: dec?.duplicateAuthorized, selfSourceDegraded: dec?.selfSourceDegraded };
}

const SOURCE_RESULT_KEYS: Record<Exclude<SourceAnchorWriteResult["kind"], "failed">, string> = {
  created: "outline.sourceCreated", reused: "outline.sourceReused", unchanged: "outline.sourceUnchanged", unknown: "outline.sourceUnknown",
};
function formatSourceResultLine(sr: SourceAnchorWriteResult): string {
  if (sr.kind === "failed") return t("outline.sourceFailed", { path: sr.sourcePath, code: sr.code ?? "ANCHOR_WRITE_FAILED" });
  return t(SOURCE_RESULT_KEYS[sr.kind], { path: sr.sourcePath, ids: sr.kind === "created" ? sr.createdIds.join(", ") : sr.reusedIds.join(", ") });
}

export class OutlineInsertModal extends Modal {
  readonly draft: OutlinePreviewDraft;
  private closeReason: "cancel" | "suspend" | "committed" | "expired" = "cancel";
  private closed = false;
  private preflightSeq = 0;
  private activeAbort?: AbortController;
  private rebuildingPlan = false;
  private cancelledPreflight = false;
  private decisionsResetNotice = false;
  private previewTab: "markdown" | "rendered" = "markdown";
  private renderComponent = new Component();
  private renderToken = 0;
  private unsubs: Array<() => void> = [];
  private frozenGroups: OutlineGroup[] = [];
  private frozenEntries: EvidenceEntry[] = [];
  private resolvedMap = new Map<string, ResolvedEvidence>();
  private currentPlan?: CitationBatchPlan;
  private currentTicket?: TargetTicket;
  private lastTicketSig = "";
  private activeSourceRefs = new Set<string>();
  private commitOutcome?: BatchCommitOutcome;
  private actionFeedback = "";
  private retryRecordState?: RecordingResult;
  private checkingProgress = { checked: 0, total: 0 };
  private statusEl?: HTMLElement;

  constructor(private options: OutlineInsertModalOptions) {
    super(options.plugin.app);
    this.shouldRestoreSelection = false;
    const rev = options.getTemplateRevision?.() ?? options.draft?.templateRevision ?? 0;
    if (options.draft) {
      this.draft = Object.assign(options.draft, { state: "checking" as const, handoff: undefined, templateRevision: rev, skeletonConfirmed: false, skipRelationsOnCapacityExceeded: false });
      for (const d of this.draft.decisions.values()) { delete d.duplicateAuthorized; delete d.selfSourceDegraded; }
    } else {
      this.draft = { draftId: crypto.randomUUID(), deskId: options.deskId, deskGeneration: options.plugin.desks.generation(options.deskId), scope: options.scope, outlineRevision: options.plugin.outline.outlineRevision(options.deskId), templateRevision: rev, state: "checking", decisions: new Map() };
    }
  }

  onOpen(): void {
    this.closed = false;
    this.closeReason = "cancel";
    this.renderComponent.load();
    this.contentEl.addClass("slipstream-outline-modal");
    this.unsubs.push(
      this.options.plugin.editors.subscribe(() => this.onEditorsChanged()),
      this.options.plugin.editors.onContentChanged((ref) => this.onSourceContentChanged(ref)),
    );
    void this.runPreflight().catch(() => { if (!this.closed) { this.actionFeedback = t("state.error"); this.render(); } });
  }

  onClose(): void {
    this.closed = true;
    this.rebuildingPlan = false;
    this.activeAbort?.abort();
    this.releaseCurrentPlan();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.renderComponent.unload();
    if (this.closeReason !== "suspend" && this.closeReason !== "committed") { this.draft.state = "closed"; this.options.onCancel(this.draft.draftId); }
    this.contentEl.empty();
  }

  /** Cancels any active preflight immediately (<= 100ms feedback target). */
  cancelPreflight(): void {
    if (this.draft.state !== "checking") return;
    this.preflightSeq++;
    this.activeAbort?.abort();
    this.rebuildingPlan = false;
    this.cancelledPreflight = true;
    this.draft.state = "preview";
    this.releaseCurrentPlan();
    this.render();
  }

  private releaseCurrentPlan(): void {
    if (!this.currentPlan) return;
    this.options.plugin.cite.releaseBatchPlan?.(this.currentPlan.planId);
    this.currentPlan = undefined;
  }

  private onEditorsChanged(): void {
    if (this.closed || this.draft.state === "committing" || this.commitOutcome) return;
    const nextSig = ticketSig(this.readTicketSafe());
    if (nextSig === this.lastTicketSig) return;
    this.lastTicketSig = nextSig;
    this.invalidatePlan();
    if (this.draft.state === "preview" && !this.cancelledPreflight) void this.rebuildPlan().catch(() => { if (!this.closed) { this.actionFeedback = t("state.error"); this.render(); } });
    else this.render();
  }

  private onSourceContentChanged(fileRef: string): void {
    if (this.closed || this.draft.state === "committing" || this.commitOutcome || !this.activeSourceRefs.has(fileRef)) return;
    this.invalidatePlan();
    if (this.draft.state === "preview" && !this.cancelledPreflight) void this.runPreflight().catch(() => { if (!this.closed) { this.actionFeedback = t("state.error"); this.render(); } });
  }

  private invalidatePlan(): void {
    this.releaseCurrentPlan();
    this.draft.skeletonConfirmed = false;
    for (const d of this.draft.decisions.values()) delete d.duplicateAuthorized;
  }

  private readTicketSafe(): TargetTicket | undefined { try { return this.options.getTicket(); } catch { return undefined; } }

  private suspend(reason: "target" | "source", entryId?: string): void {
    if (this.draft.state === "committing" || this.commitOutcome?.effect === "inserted") return;
    this.activeAbort?.abort(); this.rebuildingPlan = false; this.releaseCurrentPlan();
    this.closeReason = "suspend";
    this.draft.state = reason === "target" ? "suspended-target" : "suspended-source";
    this.draft.handoff = { kind: reason, ...(entryId ? { entryId } : {}) };
    this.options.onSuspend(reason, this.draft, entryId);
    this.close();
  }

  async runPreflight(): Promise<void> {
    const seq = ++this.preflightSeq;
    this.activeAbort?.abort();
    const abort = (this.activeAbort = new AbortController());
    this.rebuildingPlan = false;
    this.cancelledPreflight = false;
    this.actionFeedback = "";
    this.releaseCurrentPlan();

    const { plugin, deskId } = this.options;
    const scoped = plugin.desks.generation(deskId) === this.draft.deskGeneration && plugin.desks.get(deskId)
      ? plugin.outline.selectEntries(deskId, this.draft.scope)
      : undefined;
    if (!scoped) { this.closeReason = "expired"; this.draft.state = "closed"; this.renderExpired(); return; }

    this.draft.outlineRevision = plugin.outline.outlineRevision(deskId);
    this.draft.templateRevision = this.options.getTemplateRevision?.() ?? this.draft.templateRevision;
    this.frozenGroups = scoped.groups;
    this.frozenEntries = scoped.entries;
    this.resolvedMap.clear();
    this.activeSourceRefs.clear();
    this.draft.state = "checking";
    this.checkingProgress = { checked: 0, total: this.frozenEntries.length };
    this.render();
    if (!this.frozenEntries.length) { this.draft.state = "preview"; await this.rebuildPlan(); return; }

    try {
      const resolved = await plugin.evidence.resolveBatch(this.frozenEntries, {
        signal: abort.signal,
        onProgress: (p) => {
          if (seq !== this.preflightSeq || abort.signal.aborted || this.closed) return;
          this.checkingProgress = p;
          this.statusEl?.setText(t("outline.checkingProgress", p));
        },
      });
      if (seq !== this.preflightSeq || abort.signal.aborted || this.closed) return;
      for (const item of resolved) {
        this.resolvedMap.set(item.entryId, item);
        if (item.sourceRef) this.activeSourceRefs.add(item.sourceRef);
      }
      this.reconcileDecisions();
      this.draft.state = "preview";
      await this.rebuildPlan();
    } catch (error) {
      if (seq !== this.preflightSeq || abort.signal.aborted || this.closed) return;
      if (error instanceof CitationError && error.code === "OPERATION_CANCELLED") this.cancelledPreflight = true;
      else this.actionFeedback = t("state.error");
      this.draft.state = "preview";
      this.render();
    }
  }

  private reconcileDecisions(): void {
    const templateRev = this.options.getTemplateRevision?.() ?? this.draft.templateRevision;
    const byEntry = new Map(this.frozenEntries.map((entry) => [entry.id, entry]));
    for (const [entryId, dec] of [...this.draft.decisions.entries()]) {
      const entry = byEntry.get(entryId);
      const res = this.resolvedMap.get(entryId);
      const verChanged = res?.sourceVersion !== undefined && dec.sourceVersion !== undefined && res.sourceVersion !== dec.sourceVersion;
      if (!entry || !res || dec.contentRevision !== entry.contentRevision || dec.templateRevision !== templateRev || verChanged) {
        this.draft.decisions.delete(entryId);
        this.decisionsResetNotice = true;
      }
    }
  }

  private unresolvedSourceIds(): Set<string> {
    const unresolved = new Set<string>();
    for (const entry of this.frozenEntries) {
      const res = this.resolvedMap.get(entry.id);
      const dec = this.draft.decisions.get(entry.id);
      if (!res || res.status === "verified") continue;
      if (res.status === "relocated") { if (dec?.action !== "confirm-relocated" && dec?.action !== "skip") unresolved.add(entry.id); }
      else if (dec?.action !== "use-snapshot" && dec?.action !== "skip") unresolved.add(entry.id);
    }
    return unresolved;
  }

  async rebuildPlan(): Promise<void> {
    if (this.closed || this.draft.state === "committing") return;
    const seq = ++this.preflightSeq;
    this.activeAbort?.abort();
    const abort = (this.activeAbort = new AbortController());
    this.releaseCurrentPlan();
    this.rebuildingPlan = true;
    this.currentTicket = this.readTicketSafe();
    this.lastTicketSig = ticketSig(this.currentTicket);
    this.render();
    const batchId = crypto.randomUUID();
    const { settings } = this.options.plugin;
    const date = localDate();
    const items = this.frozenEntries.map((e) => toPreparedItem(e, this.resolvedMap.get(e.id), this.draft.decisions.get(e.id), settings, date));
    const layoutItems = this.frozenEntries.map((e) => ({ itemId: e.id, operationId: `${batchId}:${e.id}`, groupId: e.groupId, citationText: e.snapshot.content, note: e.note, skipped: this.draft.decisions.get(e.id)?.action === "skip" }));
    const labels = { collectionHeading: t("outline.collectionArea"), notePrefix: t("outline.docNotePrefix"), emptyGroupPlaceholder: t("outline.emptyGroup"), allSkippedPlaceholder: t("outline.allSkipped") };
    const layout: CitationLayoutPart[] = buildOutlineLayout({ scope: this.draft.scope.kind === "entry" ? "single" : this.draft.scope.kind, groups: this.frozenGroups, items: layoutItems, labels });
    try {
      const plan = await this.options.plugin.cite.prepareBatch({
        batchId, deskId: this.draft.deskId, outlineRevision: this.draft.outlineRevision, templateRevision: this.draft.templateRevision,
        items, layout, ticket: this.currentTicket, block: true, signal: abort.signal,
        skipRelationsOnCapacityExceeded: this.draft.skipRelationsOnCapacityExceeded, skeletonConfirmed: this.draft.skeletonConfirmed, labels,
      });
      if (seq !== this.preflightSeq || abort.signal.aborted || this.closed) { this.options.plugin.cite.releaseBatchPlan?.(plan.planId); return; }
      this.rebuildingPlan = false;
      this.currentPlan = plan;
      this.render();
    } catch (error) {
      if (seq !== this.preflightSeq || abort.signal.aborted || this.closed) return;
      this.rebuildingPlan = false;
      if (!(error instanceof CitationError && error.code === "OPERATION_CANCELLED")) this.actionFeedback = t("state.error");
      this.render();
    } finally { if (seq === this.preflightSeq) this.rebuildingPlan = false; }
  }

  private async commit(): Promise<void> {
    if (this.rebuildingPlan || this.draft.state !== "preview" || !this.currentPlan?.canCommit || this.unresolvedSourceIds().size > 0) return;
    const ticket = this.readTicketSafe();
    if (!ticket) { await this.rebuildPlan(); return; }
    const planId = this.currentPlan.planId;
    this.draft.state = "committing";
    this.actionFeedback = "";
    this.render();
    const abort = (this.activeAbort = new AbortController());
    try {
      const outcome = await this.options.plugin.cite.commitBatch(planId, { signal: abort.signal, ticket });
      this.commitOutcome = outcome;
      if (outcome.effect === "inserted") {
        this.currentPlan = undefined; this.closeReason = "committed"; this.draft.state = "closed";
        this.options.onCommitted(outcome, this.draft.deskId);
      } else if (outcome.effect === "unknown") {
        this.currentPlan = undefined; this.draft.state = "closed";
        this.options.onUncertain?.(outcome, this.draft.deskId);
      } else {
        this.releaseCurrentPlan();
        const hasSourceChanges = outcome.status === "partial" || outcome.sourceResults.some((sr) => sr.createdIds.length > 0 || sr.kind === "unknown");
        if (this.closed) { if (hasSourceChanges) this.options.onPartialSources?.(outcome, this.draft.deskId); return; }
        this.draft.state = "preview";
      }
      if (!this.closed) this.render();
    } catch {
      if (this.closed) return;
      this.draft.state = "preview";
      this.actionFeedback = t("outline.commitFailed", { reason: t("state.error") });
      this.render();
    }
  }

  private renderExpired(): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "slipstream-outline-modal-header" }).createEl("h3", { text: t("outline.modalTitle") });
    this.contentEl.createDiv({ cls: "slipstream-outline-issue is-blocking", text: t("outline.draftExpired") });
    addBtn(this.contentEl.createDiv({ cls: "slipstream-outline-modal-actions" }), t("common.close"), () => this.close());
  }

  private render(): void {
    this.contentEl.empty();
    this.renderHeader();
    if (this.decisionsResetNotice) this.contentEl.createDiv({ cls: "slipstream-outline-issue", text: t("outline.decisionsResetNotice") });
    if (this.actionFeedback) this.contentEl.createDiv({ cls: "slipstream-form-error", text: this.actionFeedback, attr: { role: "status" } });
    if (this.commitOutcome) { this.renderOutcomeSection(this.commitOutcome); return; }
    if (this.draft.state === "checking") {
      const box = this.contentEl.createDiv({ cls: "slipstream-outline-progress" });
      this.statusEl = box.createDiv({ text: t("outline.checkingProgress", this.checkingProgress), attr: { role: "status" } });
      addBtn(box, t("outline.checkingCancel"), () => this.cancelPreflight());
      return;
    }
    if (this.cancelledPreflight) {
      const box = this.contentEl.createDiv({ cls: "slipstream-outline-modal-section" });
      box.createDiv({ text: t("outline.checkingCancelled"), attr: { role: "status" } });
      addBtn(box, t("outline.retryPreflight"), () => { void this.runPreflight(); });
      return;
    }
    this.renderTargetSection();
    this.renderIssuesSection();
    this.renderPreviewSection();
    this.renderFooterActions();
  }

  private renderHeader(): void {
    const header = this.contentEl.createDiv({ cls: "slipstream-outline-modal-header" });
    header.createEl("h3", { text: t("outline.modalTitle") });
    header.createDiv({ cls: "slipstream-desk-target", text: t("outline.noWriteBeforeConfirm") });
    const allScope = this.options.plugin.outline.selectEntries(this.draft.deskId, { kind: "all" });
    if (!allScope) return;
    const scopeBar = header.createDiv({ cls: "slipstream-outline-scope-bar" });
    scopeBar.createSpan({ text: t("outline.scopeLabel") });
    const select = scopeBar.createEl("select", { attr: { "aria-label": t("outline.scopeLabel") } });
    select.disabled = this.draft.state === "committing" || this.draft.state === "checking" || !!this.commitOutcome;
    const currentVal = this.draft.scope.kind === "all" ? "all" : this.draft.scope.kind === "group" ? `group:${this.draft.scope.groupId}` : `entry:${this.draft.scope.entryId}`;
    const addOpt = (val: string, label: string) => { const opt = select.createEl("option", { attr: { value: val }, text: label }); if (val === currentVal) opt.selected = true; };
    addOpt("all", t("outline.scopeAll"));
    for (const g of allScope.groups) addOpt(`group:${g.id}`, t("outline.scopeGroup", { name: g.name }));
    if (this.draft.scope.kind === "entry") addOpt(`entry:${this.draft.scope.entryId}`, t("outline.scopeEntry"));
    select.addEventListener("change", () => {
      const v = select.value;
      this.draft.scope = v === "all" ? { kind: "all" } : v.startsWith("group:") ? { kind: "group", groupId: v.slice(6) } : { kind: "entry", entryId: v.slice(6) };
      this.invalidatePlan();
      void this.runPreflight();
    });
  }

  private renderTargetSection(): void {
    const sec = this.contentEl.createDiv({ cls: "slipstream-outline-modal-section" });
    const targetPath = this.options.getTargetPath() || "";
    const ticket = this.currentTicket;
    if (ticket) {
      const line = ticket.baselineText.slice(0, ticket.range.from).split("\n").length;
      sec.createDiv({ text: t("outline.targetConfirmed", { path: targetPath, line }) });
      const rawSel = ticket.range.from < ticket.range.to ? ticket.baselineText.slice(ticket.range.from, ticket.range.to).replace(/\s+/g, " ").trim() : "";
      sec.createDiv({ cls: "slipstream-desk-target", text: rawSel ? t("outline.targetReplaceSummary", { preview: rawSel.length > 60 ? `${rawSel.slice(0, 60)}…` : rawSel }) : t("outline.targetAppendSummary", { line }) });
    } else {
      sec.createDiv({ text: targetPath ? t("outline.targetPending", { path: targetPath }) : t("outline.targetMissing") });
      const errCode = this.options.getTargetError?.();
      if (errCode) sec.createDiv({ cls: "slipstream-form-error", text: t(`error.${errCode}`) });
    }
    addBtn(sec, t("outline.goLocateTarget"), () => this.suspend("target")).disabled = this.draft.state === "committing";
  }

  private renderIssuesSection(): void {
    const unresolved = this.unresolvedSourceIds();
    const planIssues = (this.currentPlan?.issues ?? []).filter((i) => !TARGET_ISSUE_CODES.has(i.code));
    const sourceAlerts = this.frozenEntries.filter((e) => { const st = this.resolvedMap.get(e.id)?.status; return st && st !== "verified"; });
    if (!sourceAlerts.length && !planIssues.length) return;
    const sec = this.contentEl.createDiv({ cls: "slipstream-outline-modal-section" });
    sec.createEl("h4", { text: t("outline.issuesHeader", { n: sourceAlerts.length + planIssues.length }) });
    for (const entry of sourceAlerts) {
      const res = this.resolvedMap.get(entry.id)!;
      const dec = this.draft.decisions.get(entry.id);
      const row = sec.createDiv({ cls: `slipstream-outline-issue ${unresolved.has(entry.id) ? "is-blocking" : "is-resolved"}` });
      row.createDiv({ text: `${t(SOURCE_STATUS_KEYS[res.status as Exclude<EvidenceResolutionStatus, "verified">])} · ${res.sourcePath}` });
      row.createDiv({ cls: "slipstream-desk-target", text: entry.snapshot.content.slice(0, 120) });
      if (res.status === "changed" && res.refreshCandidate) {
        const cmp = row.createDiv({ cls: "slipstream-outline-compare" });
        cmp.createDiv({ text: `${t("outline.refreshOld")}: ${entry.snapshot.content.slice(0, 140)}` });
        cmp.createDiv({ text: `${t("outline.refreshNew")}: ${res.refreshCandidate.newContent.slice(0, 140)}` });
        addBtn(row, t("outline.refreshConfirm"), () => { void this.applyRefresh(entry, res.refreshCandidate!.newSnapshot); });
      }
      if (res.status === "relocated") addBtn(row, t("outline.actionConfirmRelocated"), () => this.updateDecision(entry, { action: "confirm-relocated" }));
      if (res.status === "unlocated" || res.status === "missing" || (res.status === "changed" && !res.refreshCandidate)) addBtn(row, t("outline.goReselectSource"), () => this.suspend("source", entry.id));
      if (res.status === "unavailable") addBtn(row, t("common.retry"), () => { void this.runPreflight(); });
      if (res.status !== "relocated") addBtn(row, t("outline.actionUseSnapshot"), () => this.updateDecision(entry, { action: "use-snapshot" }));
      if (dec?.action !== "skip") addBtn(row, t("outline.actionSkip"), () => this.updateDecision(entry, { action: "skip" }));
    }
    for (const issue of planIssues) this.renderPlanIssueRow(sec, issue);
  }

  private renderPlanIssueRow(sec: HTMLElement, issue: BatchIssue): void {
    const row = sec.createDiv({ cls: `slipstream-outline-issue ${issue.blocking ? "is-blocking" : ""}` });
    const entry = issue.itemId ? this.frozenEntries.find((e) => e.id === issue.itemId) : undefined;
    row.createDiv({ text: t(ISSUE_TITLE_KEYS[issue.code] ?? `error.${issue.code}`) });
    if (issue.reason) row.createDiv({ cls: "slipstream-desk-target", text: issue.reason });
    if (entry) row.createDiv({ cls: "slipstream-desk-target", text: entry.snapshot.content.slice(0, 100) });
    if (issue.code === "CONSENT_REQUIRED") {
      row.createDiv({ cls: "slipstream-desk-target", text: t("anchor.explanation") });
      addBtn(row, t("outline.actionAcceptConsent"), () => { void this.acceptConsentAndRebuild(); });
      addBtn(row, t("outline.actionDisableBlockIds"), () => { void this.disableBlockIdsAndRebuild(); });
    } else if (issue.code === "BATCH_DUPLICATE" && entry) {
      addBtn(row, t("outline.actionInsertAgain"), () => this.updateDecision(entry, { duplicateAuthorized: true }));
      addBtn(row, t("outline.actionSkip"), () => this.updateDecision(entry, { action: "skip" }));
    } else if (issue.code === "RELATION_CAPACITY") {
      addBtn(row, t("outline.actionSkipRelations"), () => { this.draft.skipRelationsOnCapacityExceeded = true; void this.rebuildPlan(); });
    } else if (issue.code === "SKELETON_CONFIRMATION_REQUIRED") {
      addBtn(row, t("outline.actionConfirmSkeleton"), () => { this.draft.skeletonConfirmed = true; void this.rebuildPlan(); });
    } else if (issue.code === "SELF_SOURCE_CONFLICT" && entry) {
      addBtn(row, t("outline.goLocateTarget"), () => this.suspend("target"));
      addBtn(row, t("outline.actionUseSnapshot"), () => this.updateDecision(entry, { selfSourceDegraded: true, action: "use-snapshot", ...(this.options.plugin.settings.defaultTemplate === "C" ? { templateOverride: "A" as const } : {}) }));
      addBtn(row, t("outline.actionSkip"), () => this.updateDecision(entry, { action: "skip" }));
    } else if (entry && ["TEMPLATE_REQUIRES_BLOCK", "TEMPLATE_INVALID", "LINK_INVALID", "MARKDOWN_BOUNDARY_UNSAFE", "ANCHOR_WRITE_FAILED"].includes(issue.code)) {
      if (issue.options.includes("relocate-target")) addBtn(row, t("outline.goLocateTarget"), () => this.suspend("target"));
      if (issue.options.includes("fallback")) addBtn(row, t("outline.actionFallbackFile"), () => this.updateDecision(entry, { fallback: "heading" }));
      if (issue.options.includes("use-snapshot")) addBtn(row, t("outline.actionUseSnapshot"), () => this.updateDecision(entry, { selfSourceDegraded: true, action: "use-snapshot" }));
      if (issue.options.includes("use-A")) addBtn(row, t("outline.actionUseA"), () => this.updateDecision(entry, { templateOverride: "A" }));
      if (issue.options.includes("use-B")) addBtn(row, t("outline.actionUseB"), () => this.updateDecision(entry, { templateOverride: "B" }));
      addBtn(row, t("outline.actionSkip"), () => this.updateDecision(entry, { action: "skip" }));
    } else if (issue.code === "MARKDOWN_BOUNDARY_UNSAFE") addBtn(row, t("outline.goLocateTarget"), () => this.suspend("target"));
  }

  private renderPreviewSection(): void {
    const plan = this.currentPlan;
    if (!plan) return;
    const sec = this.contentEl.createDiv({ cls: "slipstream-outline-modal-section" });
    const skipped = this.frozenEntries.filter((e) => this.draft.decisions.get(e.id)?.action === "skip").length;
    const placeholders = plan.layoutSlices.filter((s) => s.kind === "placeholder").length;
    const groups = plan.layoutSlices.filter((s) => s.kind === "heading").length;
    const summary = sec.createDiv({ cls: "slipstream-outline-summary" });
    summary.createDiv({ text: plan.includedItemCount === 0 && plan.hasSkeleton ? t("outline.previewSkeletonOnly", { groups }) : t("outline.previewCounts", { groups, entries: plan.includedItemCount, placeholders, skipped }) });
    const plannedEdits = plan.anchorPlans.reduce((sum, p) => sum + p.edits.length, 0);
    if (plannedEdits > 0) summary.createDiv({ cls: "slipstream-outline-badge", text: t("outline.previewAnchorsPlanned", { count: plannedEdits }) });
    if (!this.options.plugin.settings.historyEnabled) summary.createDiv({ cls: "slipstream-outline-badge", text: t("outline.recordingDisabledNotice") });
    const defTpl = this.options.plugin.settings.defaultTemplate;
    if (this.frozenEntries.some((e) => { const d = this.draft.decisions.get(e.id); return d?.action !== "skip" && d?.action !== "use-snapshot" && this.resolvedMap.get(e.id)?.status === "verified" && (d?.templateOverride ?? defTpl) === "C"; })) summary.createDiv({ cls: "slipstream-outline-badge", text: t("outline.dynamicEmbedNote") });
    if (this.frozenEntries.some((e) => !!this.draft.decisions.get(e.id)?.selfSourceDegraded)) summary.createDiv({ cls: "slipstream-outline-badge", text: t("outline.sourceSelfTargetDegraded") });
    else if (this.frozenEntries.some((e) => this.draft.decisions.get(e.id)?.action === "use-snapshot")) summary.createDiv({ cls: "slipstream-outline-badge", text: t("outline.savedSnapshotNote") });
    summary.createDiv({ cls: "slipstream-desk-target", text: t("outline.targetUndoHint") });
    const tabs = sec.createDiv({ cls: "slipstream-outline-preview-tabs" });
    addBtn(tabs, t("outline.previewMarkdown"), () => { this.previewTab = "markdown"; this.render(); }, `slipstream-btn${this.previewTab === "markdown" ? " is-active" : ""}`);
    addBtn(tabs, t("outline.previewRendered"), () => { this.previewTab = "rendered"; this.render(); }, `slipstream-btn${this.previewTab === "rendered" ? " is-active" : ""}`);
    const body = sec.createDiv({ cls: "slipstream-outline-preview-body" });
    if (this.previewTab === "markdown") body.createEl("pre", { cls: "slipstream-outline-markdown", text: plan.markdown });
    else {
      const token = ++this.renderToken;
      void renderPreviewBatched({ container: body.createDiv({ cls: "slipstream-outline-rendered" }), markdown: plan.markdown, targetPath: this.options.getTargetPath() ?? "", component: this.renderComponent, renderer: this.options.renderMarkdown, isStale: () => this.closed || token !== this.renderToken });
    }
  }

  private renderFooterActions(): void {
    const actions = this.contentEl.createDiv({ cls: "slipstream-outline-modal-actions" });
    addBtn(actions, t("common.cancel"), () => this.close()).disabled = this.draft.state === "committing";
    const targetPath = this.options.getTargetPath() || "";
    const isSkeleton = this.currentPlan?.includedItemCount === 0 && this.currentPlan?.hasSkeleton;
    const label = this.draft.state === "committing" ? t("outline.committing", { path: targetPath }) : targetPath ? t(isSkeleton ? "outline.commitBtnSkeleton" : "outline.commitBtn", { path: targetPath }) : t("outline.targetMissing");
    addBtn(actions, label, () => { void this.commit(); }, "slipstream-btn is-active").disabled = !(this.draft.state === "preview" && !this.rebuildingPlan && this.unresolvedSourceIds().size === 0 && !!this.currentPlan?.canCommit && !this.currentPlan.isEmpty && !!this.currentTicket);
  }

  private renderOutcomeSection(outcome: BatchCommitOutcome): void {
    const sec = this.contentEl.createDiv({ cls: "slipstream-outline-modal-section" });
    const targetPath = outcome.targetPath ?? this.options.getTargetPath() ?? "";
    if (outcome.effect === "inserted") {
      const msgKey = outcome.recording === "pending" ? "outline.commitPartialRecord" : outcome.recording === "capacity-exceeded" ? "outline.commitCapacityExceeded" : "outline.commitSuccess";
      sec.createDiv({ text: t(msgKey, { path: targetPath, count: outcome.includedItemCount }), attr: { role: "status" } });
      if (outcome.recording === "disabled") sec.createDiv({ cls: "slipstream-outline-badge", text: t("outline.recordingDisabledNotice") });
      if (this.retryRecordState === "saved") sec.createDiv({ cls: "slipstream-outline-badge", text: t("citation.recordSaved") });
      else if (this.retryRecordState === "capacity-exceeded") sec.createDiv({ cls: "slipstream-form-error", text: t("error.RECORD_CAPACITY_EXCEEDED") });
    } else if (outcome.effect === "unknown") sec.createDiv({ cls: "slipstream-outline-issue is-blocking", text: t("outline.commitUncertain", { path: targetPath }), attr: { role: "status" } });
    else if (outcome.status === "cancelled") sec.createDiv({ text: t("outline.commitCancelled"), attr: { role: "status" } });
    else {
      sec.createDiv({ cls: "slipstream-outline-issue is-blocking", text: t("outline.commitFailed", { reason: outcome.code ? t(`error.${outcome.code}`) : t("state.error") }), attr: { role: "status" } });
      if (outcome.sourceResults.some((sr) => sr.createdIds.length > 0)) sec.createDiv({ cls: "slipstream-outline-badge", text: t("outline.commitPartialSources") });
    }
    if (outcome.sourceResults.length > 0) {
      const list = sec.createDiv({ cls: "slipstream-outline-source-results" });
      list.createDiv({ text: t("outline.sourceResultsTitle") });
      for (const sr of outcome.sourceResults) list.createDiv({ cls: "slipstream-desk-target", text: formatSourceResultLine(sr) });
    }
    const actions = this.contentEl.createDiv({ cls: "slipstream-outline-modal-actions" });
    if (outcome.effect === "inserted" && outcome.recording === "pending" && this.retryRecordState !== "saved") {
      const retryBtn = addBtn(actions, t("outline.retryRecordOnly"), () => {
        retryBtn.disabled = true;
        void this.options.plugin.history.retryBatch(outcome.batchId).then(
          (res) => { if (!this.closed) { this.retryRecordState = res; if (res !== "pending") outcome.recording = res; this.render(); } },
          () => { if (!this.closed) { retryBtn.disabled = false; this.actionFeedback = t("data.saveFailed"); this.render(); } },
        );
      });
    }
    if (outcome.effect === "none") addBtn(actions, t("outline.retryPreflight"), () => { this.commitOutcome = undefined; void this.runPreflight(); });
    if (targetPath) addBtn(actions, t("outline.openTarget"), () => this.options.openTarget?.(targetPath));
    addBtn(actions, t("common.close"), () => this.close());
  }

  private updateDecision(entry: EvidenceEntry, patch: Partial<OutlinePreviewDecision>): void {
    const dec = this.draft.decisions.get(entry.id) ?? { entryId: entry.id, contentRevision: entry.contentRevision, sourceVersion: this.resolvedMap.get(entry.id)?.sourceVersion, templateRevision: this.options.getTemplateRevision?.() ?? this.draft.templateRevision };
    this.draft.decisions.set(entry.id, Object.assign(dec, patch));
    if (patch.action !== "skip") this.draft.skeletonConfirmed = false;
    void this.rebuildPlan();
  }

  private async applyRefresh(entry: EvidenceEntry, newSnapshot: EvidenceEntry["snapshot"]): Promise<void> {
    const res = await this.options.plugin.outline.refreshEntry({ deskId: this.draft.deskId, expectedRevision: this.draft.outlineRevision, entryId: entry.id, expectedContentRevision: entry.contentRevision, snapshot: newSnapshot });
    if (!res.ok) { this.actionFeedback = res.code === "OUTLINE_READONLY" ? t("outline.statusReadonly") : res.code === "OUTLINE_SAVE_FAILED" ? t("data.saveFailed") : res.code === "DESK_DELETED" ? t("desk.missing") : t("state.error"); this.render(); return; }
    this.draft.decisions.delete(entry.id);
    this.options.onOutlineUpdated?.();
    await this.runPreflight();
  }
  private async acceptConsentAndRebuild(): Promise<void> {
    try { await this.options.plugin.store.acceptBlockIds(); this.actionFeedback = ""; await this.rebuildPlan(); } catch { this.actionFeedback = t("anchor.saveFailed"); this.render(); }
  }
  private async disableBlockIdsAndRebuild(): Promise<void> {
    this.options.plugin.settings.blockPrecision = false;
    try { await this.options.plugin.persist(); await this.rebuildPlan(); } catch { this.actionFeedback = t("data.saveFailed"); this.render(); }
  }
}
