import type SlipStreamPlugin from "../main";
import type { CitationIntent, SourceSnapshot, TargetBinding, TargetTicket } from "../domain/citationTypes";
import { canCreateBlockId } from "../domain/BlockReference";
import { CitationError, localDate } from "../domain/citationTypes";
import type { EngineOutcome, ExecutionOptions } from "../domain/CitationEngine";
import { captureSelection } from "./CitationSelection";
import type { CapturedFragment, CitationUnit } from "./CitationSelection";
import { citationPrompt } from "./CitationPrompt";
import { t } from "../util/i18n";

export async function performCitation(plugin: SlipStreamPlugin, intent: CitationIntent, feedback: HTMLElement,
  ticket: TargetTicket | undefined, signal: AbortSignal, showTarget: () => void, refresh: () => void,
  currentTicket?: () => TargetTicket): Promise<EngineOutcome> {
  let current = intent;
  const options: ExecutionOptions = { ticket, signal };
  let outcome: EngineOutcome;
  let warning = "";
  feedback.setText(t("citation.processing"));
  do {
    outcome = await plugin.cite.execute(current, options);
    if (signal.aborted || outcome.effect !== "none") break;
    let choice: string | undefined;
    if (outcome.code === "CONSENT_REQUIRED") {
      choice = await citationPrompt(plugin.app, t("anchor.explanation"), [
        { id: "accept", label: t("anchor.accept") }, { id: "disable", label: t("anchor.disable") },
      ], signal);
      if (choice === "accept") {
        try { await plugin.store.acceptBlockIds(); } catch { outcome = { ...outcome, code: "CONSENT_REQUIRED", status: "failed" }; warning = t("anchor.saveFailed"); break; }
      } else if (choice === "disable") {
        plugin.settings.blockPrecision = false;
        try { await plugin.persist(); } catch { warning = t("data.saveFailed"); }
        options.fallback = "heading";
      }
    } else if (outcome.code === "DUPLICATE") {
      choice = await citationPrompt(plugin.app, `${t("citation.duplicate")}\n${plugin.editors.path(intent.snapshot.sourceRef)} → ${ticket ? plugin.editors.path(ticket.fileRef) : ""}\n${intent.content}`, [
        { id: "insert", label: t("citation.insertAgain") },
      ], signal);
      if (choice) options.duplicateAuthorization = outcome.duplicateAuthorization;
    } else if (["TEMPLATE_REQUIRES_BLOCK", "TEMPLATE_INVALID", "LINK_INVALID"].includes(outcome.code ?? "") && current.templateId !== "A") {
      choice = await citationPrompt(plugin.app, t(`error.${outcome.code}`), [{ id: "A", label: t("citation.useA") }, { id: "expand", label: t("citation.refresh") }], signal);
      if (choice === "A") current = { ...current, templateId: "A" };
      if (choice === "expand") { refresh(); choice = undefined; }
    } else if (outcome.code === "LINK_INVALID" && options.fallback !== "file") {
      choice = await citationPrompt(plugin.app, t("error.LINK_INVALID"), [{ id: "file", label: t("citation.fileFallback") }], signal);
      if (choice) options.fallback = "file";
    } else if (outcome.code === "SOURCE_STALE") {
      choice = await citationPrompt(plugin.app, t("error.SOURCE_STALE"), [
        { id: "refresh", label: t("citation.refresh") }, { id: "snapshot", label: t("citation.savedFragment") },
      ], signal);
      if (choice === "snapshot") { options.staleSnapshot = true; options.fallback = "file"; }
      if (choice === "refresh") { refresh(); choice = undefined; }
    } else if (outcome.code === "ANCHOR_WRITE_FAILED" && !options.fallback) {
      choice = await citationPrompt(plugin.app, t("error.ANCHOR_WRITE_FAILED"), [
        { id: "fallback", label: t("citation.fallback") }, { id: "file", label: t("citation.fileFallback") },
      ], signal);
      if (choice) options.fallback = choice === "file" ? "file" : "heading";
    } else break;
    if (!choice) { outcome = { ...outcome, status: "cancelled", code: "OPERATION_CANCELLED" }; break; }
  } while (!signal.aborted);
  feedback.empty();
  const message = outcome.code ? t(outcome.code === "RECORD_SAVE_FAILED" && outcome.effect === "copied" ? "citation.copyRecordFailed" : `error.${outcome.code}`) : t(outcome.effect === "inserted" ? "citation.inserted" : "notice.copied", { path: outcome.targetPath ?? "" });
  if (warning) feedback.createDiv({ text: warning });
  feedback.createDiv({ text: `${message} · ${t(`precision.${outcome.precision}`)}` });
  if (outcome.sourceAnchor === "created" && outcome.effect === "none") feedback.createDiv({ text: t("anchor.retained") });
  if (options.staleSnapshot) feedback.createDiv({ text: t("citation.staleSnapshot") });
  if (outcome.effect === "inserted" || ticket) feedback.createEl("button", { cls: "slipstream-btn", text: t("target.show") }).addEventListener("click", () => {
    try { showTarget(); } catch (error) { feedback.setText(t(`error.${error instanceof CitationError ? error.code : "TARGET_MISSING"}`)); }
  });
  feedback.createEl("button", { cls: "slipstream-btn", text: t("history.jump") }).addEventListener("click", () => {
    try { void plugin.app.workspace.openLinkText(plugin.editors.path(intent.snapshot.sourceRef), "", false); } catch { feedback.setText(t("error.SOURCE_MISSING")); }
  });
  if (outcome.recording === "pending") {
    const retry = feedback.createEl("button", { cls: "slipstream-btn", text: t("citation.retryRecord") });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      const state = await plugin.history.retry(intent.operationId);
      retry.disabled = false;
      if (state !== "pending") { feedback.setText(t(state === "capacity-exceeded" ? "error.RECORD_CAPACITY_EXCEEDED" : "citation.recordSaved")); }
    });
  } else if (outcome.effect === "none" && outcome.status !== "cancelled" && (outcome.code !== "TARGET_STALE" || currentTicket)) {
    const retry = feedback.createEl("button", { cls: "slipstream-btn", text: t("common.retry") });
    retry.addEventListener("click", () => {
      let nextTicket = ticket;
      try { if (currentTicket) nextTicket = currentTicket(); }
      catch (error) { feedback.setText(t(`error.${error instanceof CitationError ? error.code : "TARGET_STALE"}`)); return; }
      retry.disabled = true;
      void performCitation(plugin, current, feedback, nextTicket, signal, showTarget, refresh, currentTicket);
    });
  }
  feedback.createEl("button", { cls: "slipstream-btn", text: t("common.close") }).addEventListener("click", () => feedback.empty());
  return outcome;
}

export class CitationActions {
  private units = new Map<HTMLElement, CitationUnit>();
  private frozen?: CapturedFragment;
  private active?: CapturedFragment;
  private buttons: HTMLButtonElement[] = [];
  private bar: HTMLElement;
  private feedback: HTMLElement;
  private busy = false;
  private disposed = false;
  private invalidSelection = false;
  private emptySelection = false;
  private pointerListener = () => { this.frozen = undefined; this.invalidSelection = false; this.emptySelection = false; };
  private dragTokens = new Set<string>();
  private controllers = new Set<AbortController>();
  private selectionListener = () => this.selectionChanged();
  private escapeListener = (event: KeyboardEvent) => { if (event.key === "Escape") this.controllers.forEach((controller) => controller.abort()); };
  constructor(private plugin: SlipStreamPlugin, private snapshot: SourceSnapshot, private body: HTMLElement,
    private controls: HTMLElement, private getTarget: () => TargetBinding | undefined, private refresh: () => void, feedback?: HTMLElement) {
    this.bar = controls.createDiv({ cls: "slipstream-citation-actions", attr: { "data-no-cite": "true" } });
    this.bar.hidden = true;
    this.feedback = feedback ?? controls.createDiv({ cls: "slipstream-citation-feedback", attr: { role: "status", "aria-live": "polite" } });
    body.addEventListener("pointerdown", this.pointerListener);
    body.ownerDocument.addEventListener("selectionchange", this.selectionListener);
    body.ownerDocument.addEventListener("keydown", this.escapeListener);
  }
  addUnit(element: HTMLElement, unit: CitationUnit): void {
    this.units.set(element, unit);
    const button = this.controls.createEl("button", { cls: "slipstream-paragraph-action slipstream-btn", text: "⋯",
      attr: { "aria-label": t("citation.paragraph", { n: this.buttons.length + 1 }), "data-no-cite": "true" } });
    this.buttons.push(button);
    const top = () => button.setCssProps({ "--slipstream-action-top": `${element.getBoundingClientRect().top - this.controls.parentElement!.getBoundingClientRect().top}px` });
    top();
    element.addEventListener("mouseenter", () => { top(); button.classList.add("is-visible"); });
    element.addEventListener("mouseleave", () => button.classList.remove("is-visible"));
    button.addEventListener("pointerdown", () => this.freezeSelection());
    button.addEventListener("click", () => {
      if (this.invalidSelection || this.emptySelection) return;
      this.active = this.frozen ?? { spans: [unit.origin], content: unit.content, mode: unit.mode, selectionKey: unit.key };
      this.renderBar();
      this.bar.querySelector<HTMLButtonElement>("button")?.focus();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const index = this.buttons.indexOf(button);
      this.buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + this.buttons.length) % this.buttons.length].focus();
    });
  }
  selection(): CapturedFragment | undefined { this.freezeSelection(); return this.frozen; }
  refreshContext(): void { this.renderBar(); if (this.busy) this.setBusy(true); }
  async copySelection(): Promise<void> {
    const selection = this.selection();
    if (!selection) { this.feedback.setText(t("citation.selectFirst")); return; }
    await this.submit(selection, "copy");
  }
  fragment(element: HTMLElement): CapturedFragment | undefined {
    this.freezeSelection();
    if (this.emptySelection) return;
    if (this.invalidSelection) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
    const unit = this.units.get(element);
    return this.frozen ?? (unit ? { spans: [unit.origin], content: unit.content, mode: unit.mode, selectionKey: unit.key } : undefined);
  }
  intent(fragment: CapturedFragment, action: "copy" | "insert"): CitationIntent {
    return { ...fragment, operationId: crypto.randomUUID(), action, snapshot: this.snapshot,
      templateId: this.plugin.settings.defaultTemplate, customTemplate: this.plugin.settings.customTemplate, date: localDate() };
  }
  private selectionChanged(): void {
    if (this.disposed || this.busy) return;
    const selection = this.body.ownerDocument.getSelection();
    const focused = this.body.ownerDocument.activeElement;
    const headerActions = this.body.closest(".slipstream-card")?.querySelector(".slipstream-card-actions");
    if (selection?.isCollapsed && (this.controls.contains(focused) || headerActions?.contains(focused))) return;
    if (selection?.isCollapsed) { this.frozen = undefined; this.active = undefined; this.invalidSelection = false; this.emptySelection = false; this.bar.hidden = true; return; }
    this.freezeSelection();
    if (this.frozen) { this.active = this.frozen; this.renderBar(); }
  }
  private freezeSelection(): void {
    const selection = this.body.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    if (!selection.getRangeAt(0).intersectsNode(this.body)) { this.frozen = undefined; return; }
    try { this.frozen = captureSelection(this.body, this.units, selection); this.invalidSelection = false; this.emptySelection = !this.frozen; }
    catch { this.invalidSelection = true; this.frozen = undefined; this.active = undefined; this.bar.hidden = true; this.feedback.setText(t("citation.invalidSelection")); }
  }
  private renderBar(): void {
    this.bar.empty();
    if (!this.active) { this.bar.hidden = true; return; }
    this.bar.hidden = false;
    const target = this.getTarget();
    let name = "";
    if (target) { try { name = this.plugin.editors.path(target.fileRef); } catch { /* The target remains visible as unavailable. */ } }
    const insert = this.bar.createEl("button", { cls: "slipstream-btn", text: name ? t("citation.to", { path: name }) : t("citation.insert") });
    const copy = this.bar.createEl("button", { cls: "slipstream-btn", text: t("card.copy") });
    insert.addEventListener("click", () => { if (this.active) void this.submit(this.active, "insert"); });
    copy.addEventListener("click", () => { if (this.active) void this.submit(this.active, "copy"); });
    const origin = this.active.spans[0];
    const precision = origin.existingBlockId || this.plugin.settings.blockPrecision && !this.plugin.store.readOnly && target?.fileRef !== this.snapshot.sourceRef && canCreateBlockId(origin.kind, origin.rawText)
      ? this.active.mode === "block" ? "block" : this.active.spans.length > 1 ? "multi-block-start" : "fragment"
      : origin.heading ? "heading" : "file";
    this.bar.createSpan({ cls: "slipstream-precision", text: t(`precision.${precision}`) });
    this.bar.createEl("button", { cls: "slipstream-btn", text: t("history.jump") }).addEventListener("click", () => {
      const path = this.plugin.editors.path(this.snapshot.sourceRef);
      const anchor = origin.existingBlockId ? `#^${origin.existingBlockId}` : origin.heading ? `#${origin.heading}` : "";
      void this.plugin.app.workspace.openLinkText(path + anchor, "", false);
    });
  }
  private async submit(fragment: CapturedFragment, action: "insert" | "copy"): Promise<void> {
    if (this.busy || this.disposed) return;
    let ticket: TargetTicket | undefined;
    const binding = this.getTarget();
    try { if (action === "insert") ticket = this.plugin.editors.ticket(binding); }
    catch (error) { this.feedback.setText(t(`error.${error instanceof CitationError ? error.code : "TARGET_MISSING"}`)); return; }
    this.setBusy(true); this.plugin.citationBusy++;
    const controller = new AbortController();
    this.controllers.add(controller);
    const trigger = this.body.ownerDocument.activeElement as HTMLElement | null;
    try {
      await performCitation(this.plugin, this.intent(fragment, action), this.feedback, ticket, controller.signal,
        () => { if (binding) this.plugin.editors.show(binding); }, this.refresh,
        ticket ? () => this.plugin.editors.ticket(binding) : undefined);
    } finally {
      this.setBusy(false); this.plugin.citationBusy--;
      if (!this.disposed && trigger?.isConnected) trigger.focus();
    }
  }
  createDrag(element: HTMLElement, captured?: CapturedFragment): string | undefined {
    if (this.disposed) return;
    const fragment = captured ?? this.fragment(element);
    if (!fragment || this.busy) return;
    const intent = this.intent(fragment, "insert");
    const controller = new AbortController();
    this.controllers.add(controller);
    const token = crypto.randomUUID();
    this.dragTokens.add(token);
    this.plugin.dragTokens.set(token, (ticket, error) => {
      this.dragTokens.delete(token);
      if (error || !ticket) { this.feedback.setText(t(`error.${error?.code ?? "DROP_POSITION_UNAVAILABLE"}`)); return; }
      if (this.busy) { this.feedback.setText(t("citation.processing")); return; }
      this.setBusy(true);
      this.plugin.citationBusy++;
      void performCitation(this.plugin, intent, this.feedback, ticket, controller.signal,
        () => { void this.plugin.app.workspace.openLinkText(this.plugin.editors.path(ticket.fileRef), "", false); }, this.refresh)
        .finally(() => { this.setBusy(false); this.plugin.citationBusy--; });
    });
    return token;
  }
  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.controls.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.disabled = busy);
  }
  destroy(): void {
    this.disposed = true; this.controllers.forEach((controller) => controller.abort()); this.controllers.clear();
    this.body.removeEventListener("pointerdown", this.pointerListener);
    this.body.ownerDocument.removeEventListener("selectionchange", this.selectionListener);
    this.body.ownerDocument.removeEventListener("keydown", this.escapeListener);
    for (const token of this.dragTokens) this.plugin.dragTokens.delete(token);
    this.units.clear(); this.frozen = undefined; this.active = undefined;
  }
}
