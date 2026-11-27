import type { App } from "obsidian";
import { getFrontMatterInfo, MarkdownRenderer, MarkdownView, Modal, Notice, TFile } from "obsidian";
import type { CardModel } from "./CardModel";
import { buildCardModel } from "./CardModel";
import type { Density, SortKey } from "./types";
import type SlipStreamPlugin from "../main";
import type { SlipStreamView } from "../view/SlipStreamView";
import { CardStream } from "../view/CardStream";
import { Toolbar } from "../view/Toolbar";
import type { ToolbarHost } from "../view/Toolbar";
import { SourceBar } from "../view/SourceBar";
import type { SourceBarHost } from "../view/SourceBar";
import { TargetBar } from "../view/TargetBar";
import { DeskSelector } from "../view/DeskSelector";
import type { DeskFormResult, DeskSelectorHost } from "../view/DeskSelector";
import { FocusBar } from "../view/FocusBar";
import type { FocusBarHost } from "../view/FocusBar";
import { FocusResults } from "../view/FocusResults";
import type { FocusCiteOptions, FocusResultsHost } from "../view/FocusResults";
import { ReadingPosition } from "../view/ReadingPosition";
import { renderSectionPreview } from "../view/SectionPreview";
import { chapterRange } from "./ChapterRange";
import { CardView } from "../view/CardView";
import type { CardHost } from "../view/CardView";
import { buildEvidenceSnapshot, rangesFromOffsets } from "../view/CitationSelection";
import type { CapturedFragment } from "../view/CitationSelection";
import { citationPrompt } from "../view/CitationPrompt";
import { OutlinePanel } from "../view/OutlinePanel";
import type { OutlinePanelHost } from "../view/OutlinePanel";
import { OutlineInsertModal } from "../view/OutlineInsertModal";
import type { OutlinePreviewDraft } from "../view/OutlineInsertModal";
import { renderEmpty, renderError, renderSkeleton } from "../view/states";
import { canonicalSelectionKey, CitationError, localDate } from "./citationTypes";
import type { CitationIntent, SourceSnapshot, TargetBinding, TargetTicket, TextRange } from "./citationTypes";
import type { BatchCommitOutcome } from "./CitationEngine";
import { performCitation } from "../view/CitationActions";
import { visibleCharacters } from "./SnippetExtractor";
import type { Desk, DeskReadingState, DeskRule, ReadingAnchor, CollectionItem, CollectionSnapshot, CollectionSource, UnresolvedRef } from "./deskTypes";
import { defaultReadingState } from "./deskTypes";
import type { EvidenceEntry, EvidenceOutline, EvidenceSnapshot, OutlineScope, SavedOrigin } from "./outlineTypes";
import { sliceContextAfter, sliceContextBefore } from "./outlineTypes";
import type { OutlineMutationResult } from "./OutlineService";
import { applyHidden, deriveVisible, metadataFilter, stableSort } from "./CollectionService";
import type { FocusKind, FocusProgress, FocusRequest, FocusResult, SearchRun } from "./FocusSearch";
import { hashText } from "./FocusSearch";
import { t } from "../util/i18n";

interface TempState {
  rules: DeskRule[];
  manualPaths: string[];
  reading: DeskReadingState;
  targetPath: string;
  anchor?: ReadingAnchor;
}

interface FocusRuntime {
  sessionId: string;
  query: string;
  kind: FocusKind;
  includeHidden: boolean;
  cursor: number;
  normalAnchor?: ReadingAnchor;
  controller?: AbortController;
  run?: SearchRun;
}

function readingFrom(raw: unknown, fallback: DeskReadingState): DeskReadingState {
  const state = defaultReadingState({ ...fallback });
  if (!raw || typeof raw !== "object") return state;
  const source = raw as Record<string, unknown>;
  if (["full", "snippet", "compact"].includes(String(source.density))) state.density = source.density as Density;
  if (["mtime", "ctime", "name", "custom"].includes(String(source.sort))) state.sort = source.sort as SortKey;
  if (typeof source.sortAsc === "boolean") state.sortAsc = source.sortAsc;
  if (typeof source.filter === "string") state.filter = source.filter;
  if (typeof source.showHidden === "boolean") state.showHidden = source.showHidden;
  for (const key of ["pinned", "collapsed", "compactExpanded", "dismissed", "customOrder"] as const) {
    const value = source[key];
    if (Array.isArray(value)) state[key] = value.filter((item): item is string => typeof item === "string");
  }
  return state;
}

function rulesFrom(raw: unknown): DeskRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((rule) => {
    if (!rule || typeof rule !== "object") return undefined;
    const item = rule as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.spec || typeof item.spec !== "object") return undefined;
    const spec = item.spec as Record<string, unknown>;
    if (!["folder", "tag", "backlinks", "outlinks"].includes(String(spec.kind)) || typeof spec.value !== "string") return undefined;
    return { id: item.id, spec: spec as DeskRule["spec"] };
  }).filter((rule): rule is DeskRule => !!rule);
}

/** 编排：书桌／临时会话 → 完整集合 → 普通阅读／聚焦／提纲。 */
export class CardStreamController implements ToolbarHost, SourceBarHost, CardHost, DeskSelectorHost, FocusBarHost, FocusResultsHost, OutlinePanelHost {
  private root!: HTMLElement;
  private modeSwitchEl?: HTMLElement;
  private materialsTabBtn?: HTMLButtonElement;
  private outlineTabBtn?: HTMLButtonElement;
  private draftBannerEl?: HTMLElement;
  private streamEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private feedbackEl!: HTMLElement;
  private focusResultsEl!: HTMLElement;
  private outlinePanel?: OutlinePanel;
  private stream!: CardStream;
  private toolbar?: Toolbar;
  private sourceBar?: SourceBar;
  private targetBar?: TargetBar;
  private deskSelector?: DeskSelector;
  private focusBar?: FocusBar;
  private focusResults?: FocusResults;
  private readingPosition?: ReadingPosition;

  private activeMode: "materials" | "outline" = "materials";
  private previewDraft?: OutlinePreviewDraft;
  private pendingCollectAfterCreate?: {
    epoch: number;
    entryId: string;
    sourceSnapshot: SourceSnapshot;
    spans: readonly import("./citationTypes").OriginSpan[];
    evidenceSnapshot: EvidenceSnapshot;
  };

  private deskId?: string;
  private temp: TempState = { rules: [], manualPaths: [], reading: defaultReadingState(), targetPath: "" };
  private collection?: CollectionSnapshot;
  private visible: CollectionItem[] = [];
  private loadedCount = 0;
  private scopeRevision = 0;
  private dataGeneration = 0;
  private focusGeneration = 0;
  private focusRunProgress?: FocusProgress;
  private focus?: FocusRuntime;
  private binding?: TargetBinding;
  private saveTimer: number | null = null;
  private scrollTimer: number | null = null;
  private destroyed = false;
  private operationControllers = new Set<AbortController>();
  private focusDragTokens = new Set<string>();
  private deskEpoch = 0;
  private focusPublishTimer: number | null = null;
  private pendingFocusResults: FocusResult[] | null = null;

  constructor(private plugin: SlipStreamPlugin, private view: SlipStreamView) {}

  // ------------------------------------------------------------------ state
  private desk(): Desk | undefined { return this.plugin.desks.get(this.deskId); }
  private readingState(): DeskReadingState { return this.desk()?.reading ?? this.temp.reading; }
  private pageSize(): number { return Math.max(1, this.plugin.settings.collectionPageSize); }

  async restore(viewState: unknown): Promise<void> {
    const state = (viewState ?? {}) as Record<string, unknown>;
    if (state.viewStateVersion === 2) {
      if (typeof state.deskId === "string" && this.plugin.desks.exists(state.deskId)) {
        this.deskId = state.deskId;
        return;
      }
      this.deskId = undefined;
      const raw = state.temp as Record<string, unknown> | undefined;
      this.temp = {
        rules: rulesFrom(raw?.rules),
        manualPaths: Array.isArray(raw?.manualPaths) ? raw.manualPaths.filter((path): path is string => typeof path === "string") : [],
        reading: readingFrom(raw?.reading, defaultReadingState({ density: this.plugin.settings.defaultDensity })),
        targetPath: typeof raw?.targetPath === "string" ? raw.targetPath : "",
        anchor: raw?.anchor as ReadingAnchor | undefined,
      };
      return;
    }
    // 旧工作区单源状态 → 临时浏览，不制造书桌名称或推断目标。
    this.deskId = undefined;
    const source = state.source as { kind?: string; value?: string; options?: Record<string, unknown> } | undefined;
    const rules: DeskRule[] = [];
    if (source && typeof source.value === "string" && ["folder", "tag", "backlinks", "outlinks"].includes(String(source.kind))) {
      rules.push({ id: `rule-${crypto.randomUUID()}`, spec: { ...(source as DeskRule["spec"]) } });
    }
    this.temp = {
      rules,
      manualPaths: [],
      reading: readingFrom(state, defaultReadingState({
        density: this.plugin.settings.defaultDensity,
        showHidden: this.plugin.settings.showDismissed,
      })),
      targetPath: "",
    };
  }

  serializeViewState(): Record<string, unknown> {
    if (this.deskId && this.plugin.desks.exists(this.deskId)) return { viewStateVersion: 2, deskId: this.deskId };
    return {
      viewStateVersion: 2,
      temp: { rules: this.temp.rules, manualPaths: this.temp.manualPaths, reading: this.temp.reading, targetPath: this.temp.targetPath, anchor: this.temp.anchor },
    };
  }

  async mount(root: HTMLElement): Promise<void> {
    if (this.focus) this.cancelFocus(false);
    this.focusResults?.destroy();
    this.outlinePanel?.destroy();
    this.stream?.destroy();
    this.targetBar?.destroy();
    this.focusBar?.destroy();
    root.empty();
    root.addClass("slipstream-root");
    this.root = root;

    this.deskSelector = new DeskSelector(this);
    root.appendChild(this.deskSelector.el);
    this.modeSwitchEl = root.createDiv({ cls: "slipstream-mode-switch" });
    this.materialsTabBtn = this.modeSwitchEl.createEl("button", { cls: "slipstream-btn", text: t("outline.tabMaterials") });
    this.materialsTabBtn.addEventListener("click", () => this.setMode("materials"));
    this.outlineTabBtn = this.modeSwitchEl.createEl("button", { cls: "slipstream-btn", text: t("outline.tabOutline") });
    this.outlineTabBtn.addEventListener("click", () => this.setMode("outline"));
    this.draftBannerEl = root.createDiv({ cls: "slipstream-outline-draft-banner is-hidden" });
    this.targetBar = new TargetBar(this.plugin.app, this.plugin.editors, () => this.binding,
      (editorId) => this.bindTarget(editorId), () => this.plugin.settings.blockPrecision && !this.plugin.store.readOnly,
      () => this.plugin.openCitationSettings(), () => this.currentTargetPath());
    root.appendChild(this.targetBar.el);
    this.sourceBar = new SourceBar(this);
    root.appendChild(this.sourceBar.el);
    this.toolbar = new Toolbar(this);
    root.appendChild(this.toolbar.el);

    this.focusBar = new FocusBar(this);
    root.appendChild(this.focusBar.el);

    this.streamEl = root.createDiv({ cls: "slipstream-stream" });
    this.focusResultsEl = root.createDiv({ cls: "slipstream-focus-results-wrap is-hidden" });
    this.focusResults = new FocusResults(this);
    this.focusResultsEl.appendChild(this.focusResults.el);
    this.outlinePanel = new OutlinePanel(this);
    root.appendChild(this.outlinePanel.el);
    this.feedbackEl = root.createDiv({ cls: "slipstream-operation-feedback", attr: { role: "status", "aria-live": "polite" } });
    this.statusEl = root.createDiv({ cls: "slipstream-statusbar" });
    this.stream = new CardStream(this.plugin, this.streamEl, this, () => this.readingState().density,
      (path) => this.isCollapsed(path), (path) => this.readingState().pinned.includes(path));
    this.readingPosition = new ReadingPosition({ container: this.streamEl, ensureRendered: (path) => this.stream.ensureCardRendered(path) });
    this.streamEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.applyModeVisibility();
    this.updateModeSwitch();
    this.renderDraftBanner();
    await this.refreshCollection();
  }

  destroy(): void {
    this.destroyed = true;
    this.dataGeneration++;
    this.closeDraft();
    this.pendingCollectAfterCreate = undefined;
    this.abortOperations();
    this.clearFocusPublish();
    this.readingPosition?.cancelRestore();
    this.cancelFocus(true);
    this.outlinePanel?.destroy();
    this.focusResults?.destroy();
    this.targetBar?.destroy();
    if (this.binding) this.plugin.editors.release(this.binding);
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.stream?.destroy();
  }

  /** 关闭前同步捕获最后阅读位置并尽力完成保存，不依赖异步卸载。 */
  async prepareClose(): Promise<void> {
    try {
      this.closeDraft();
      await this.outlinePanel?.flushPendingNotes();
      this.captureAnchor();
      if (this.deskId && this.plugin.desks.exists(this.deskId)) await this.plugin.desks.save(this.deskId);
    } catch { /* 关闭失败保留内存，不阻塞销毁 */ }
  }

  openCreateDeskForm(): void { this.deskSelector?.openForm(); }
  openDeskSelector(): void { this.deskSelector?.openList(); }
  openOutline(): void { this.setMode("outline"); }
  openNewOutlineGroup(): void {
    this.setMode("outline");
    this.outlinePanel?.openNewGroupDialog();
  }
  previewOutline(scope: OutlineScope): void { this.openPreview(scope); }
  focusSearchInput(): void {
    if (this.activeMode === "outline") this.setMode("materials");
    if (!this.focus) this.enterFocus();
    this.focusBar?.focusInput();
  }

  // ------------------------------------------------------------- collection
  private collectionSource(): CollectionSource {
    const desk = this.desk();
    if (desk) return {
      rules: desk.rules, manualPaths: desk.manualPaths, targetPath: desk.targetPath,
      blockedManualPaths: desk.unresolvedRefs.filter((ref) => ref.scope === "manual").map((ref) => ref.path),
    };
    return { rules: this.temp.rules, manualPaths: this.temp.manualPaths, targetPath: this.temp.targetPath || undefined };
  }

  refresh(): void { void this.refreshCollection(); }
  refreshSilent(): void {
    if (this.plugin.citationBusy > 0) { this.plugin.scheduleRefresh(); return; }
    // 外部分变化时重新解析完整集合；聚焦中由 refreshCollection 重新检索。
    this.updateModeSwitch();
    if (this.activeMode === "outline" && !this.outlinePanel?.hasPendingNotes()) {
      this.outlinePanel?.render();
    }
    void this.refreshCollection(true);
  }

  private async refreshCollection(silent = false): Promise<void> {
    const generation = ++this.dataGeneration;
    const source = this.collectionSource();
    const focusing = !!this.focus;
    if (!source.rules.length && !source.manualPaths.length) {
      this.collection = undefined; this.visible = []; this.loadedCount = 0;
      if (focusing) this.exitFocus(); else this.renderEmptyState();
      return;
    }
    if (!silent && !focusing) renderSkeleton(this.streamEl, 4);
    try {
      const snapshot = await this.plugin.collections.resolve(source, generation);
      if (this.destroyed || generation !== this.dataGeneration) return;
      this.collection = snapshot;
      this.scopeRevision++;
      this.syncUnresolved(snapshot);
      // 聚焦期间的来源成员变化必须重新检索，不能复用旧集合。
      if (focusing) { if (this.focus) void this.startFocus(); return; }
      this.recomputeVisible(true);
    } catch {
      if (this.destroyed || generation !== this.dataGeneration) return;
      if (focusing) { if (this.focus) void this.startFocus(); return; }
      this.plugin.logger.error("resolve sources failed");
      renderError(this.streamEl, t("state.error"), () => this.refresh(), t("common.retry"));
      this.updateStatus();
    }
  }

  private recomputeVisible(resetPaging: boolean): void {
    if (!this.collection) { this.visible = []; this.loadedCount = 0; return; }
    this.visible = deriveVisible(this.collection.items, this.readingState());
    if (resetPaging) this.loadedCount = Math.min(this.pageSize(), this.visible.length);
    const anchor = this.desk()?.anchor ?? this.temp.anchor;
    if (anchor) {
      const index = this.visible.findIndex((item) => item.path === anchor.filePath);
      if (index >= this.loadedCount) this.loadedCount = Math.min(this.visible.length, Math.ceil((index + 1) / this.pageSize()) * this.pageSize());
    }
    this.renderCards();
    void this.restoreAnchor();
  }

  private renderCards(): void {
    if (this.focus) return;
    if (!this.visible.length) {
      this.stream.destroy();
      if (!this.collection) this.renderEmptyState();
      else if (this.collection.issues.some((issue) => issue.category === "RULE_INVALID" || issue.category === "RULE_MISSING" || issue.category === "RULE_UNSUPPORTED")) renderEmpty(this.streamEl, t("state.empty"));
      else if (this.readingState().dismissed.length && !this.readingState().showHidden) renderEmpty(this.streamEl, t("state.allHidden"));
      else if (this.readingState().filter.trim()) renderEmpty(this.streamEl, t("state.filterEmpty"));
      else renderEmpty(this.streamEl, t("state.empty"));
      this.updateStatus();
      return;
    }
    const slice = this.visible.slice(0, this.loadedCount);
    this.stream.setCards(slice.map((item) => this.cardModel(item)));
    this.updateStatus();
  }

  private cardModel(item: CollectionItem): CardModel {
    const model = buildCardModel(this.plugin.gateway, item.file);
    const rules = this.collectionSource().rules;
    const labels: string[] = [];
    for (const ruleId of item.matchedRuleIds) {
      const rule = rules.find((candidate) => candidate.id === ruleId);
      if (rule) labels.push(t(`sb.${rule.spec.kind}`));
    }
    if (item.manual) labels.push(t("src.manualTag"));
    model.sources = [...new Set(labels)];
    return model;
  }

  private renderEmptyState(): void {
    this.stream.destroy();
    this.streamEl.empty();
    const state = this.streamEl.createDiv({ cls: "slipstream-state" });
    state.createDiv({ text: this.collectionSource().rules.length || this.collectionSource().manualPaths.length ? t("state.empty") : t("state.noSource") });
    const add = state.createEl("button", { cls: "slipstream-btn", text: t("src.add") });
    add.addEventListener("click", () => this.sourceBar?.update());
    const create = state.createEl("button", { cls: "slipstream-btn", text: t("desk.create") });
    create.addEventListener("click", () => this.deskSelector?.openForm());
    this.updateStatus();
  }

  private loadMore(): void {
    if (this.focus || !this.collection) return;
    const previous = this.loadedCount;
    if (previous >= this.visible.length) return;
    this.loadedCount = Math.min(this.visible.length, previous + this.pageSize());
    const appended = this.visible.slice(previous, this.loadedCount).map((item) => this.cardModel(item));
    this.stream.appendCards(appended);
    this.updateStatus();
  }

  private updateStatus(): void {
    if (this.focus) { this.updateFocusStatus(); return; }
    this.statusEl.empty();
    if (!this.collection) return;
    const total = this.collection.items.length;
    const visible = this.visible.length;
    const key = this.collection.completeness === "partial" ? "status.collectionPartial" : "status.collection";
    this.statusEl.createSpan({ text: t(key, { total, visible, loaded: this.loadedCount }) });
    const hidden = this.collection.items.filter((item) => this.readingState().dismissed.includes(item.path)).length;
    if (hidden) this.statusEl.createSpan({ text: t("status.hidden", { n: hidden }) });
    const citations = this.plugin.history.list().length;
    const link = this.statusEl.createSpan({ cls: "slipstream-status-link", text: `· ${citations}` });
    link.setAttribute("aria-label", t("history.title"));
    link.addEventListener("click", () => this.plugin.openHistory());
    if (this.loadedCount < visible) {
      const button = this.statusEl.createEl("button", { cls: "slipstream-btn", text: t("tb.loadMore", { n: visible - this.loadedCount }) });
      button.addEventListener("click", () => this.loadMore());
    } else if (visible > 0) {
      this.statusEl.createSpan({ text: t("tb.allLoaded") });
    }
  }

  private syncUnresolved(snapshot: CollectionSnapshot): void {
    if (!this.deskId) return;
    const desk = this.desk();
    if (!desk) return;
    const refKey = (ref: { scope: string; ruleId?: string; path: string }): string => `${ref.scope}:${ref.ruleId ?? ""}:${ref.path}`;
    // 只保留仍被用户明确配置的失效项；同路径出现新文件不会自动清除已有标记。
    const merged = new Map<string, UnresolvedRef>();
    for (const ref of desk.unresolvedRefs) {
      if (ref.scope === "rule" && !desk.rules.some((rule) => rule.id === ref.ruleId)) continue;
      if (ref.scope === "manual" && !desk.manualPaths.includes(ref.path)) continue;
      merged.set(refKey(ref), ref);
    }
    for (const issue of snapshot.issues) {
      if (!["FILE_MISSING", "RULE_MISSING", "RULE_INVALID", "RULE_UNSUPPORTED"].includes(issue.category)) continue;
      const ref: UnresolvedRef = {
        path: issue.path,
        kind: issue.category === "FILE_MISSING" ? "file" : "folder",
        scope: issue.ruleId ? "rule" : "manual",
        ...(issue.ruleId ? { ruleId: issue.ruleId } : {}),
        reason: "missing",
      };
      if (!merged.has(refKey(ref))) merged.set(refKey(ref), ref);
    }
    const next = [...merged.values()];
    if (JSON.stringify(desk.unresolvedRefs) !== JSON.stringify(next)) this.plugin.desks.setUnresolved(this.deskId, next);
  }

  // ------------------------------------------------------------- reading anchor
  private onScroll(): void {
    if (this.focus) return;
    // 用户滚动立即取消进行中的位置恢复，避免抢回新位置。
    this.readingPosition?.cancelRestore();
    if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
    this.scrollTimer = window.setTimeout(() => { this.scrollTimer = null; this.captureAnchor(); }, 300);
  }

  private captureAnchor(): void {
    if (this.focus || !this.readingPosition) return;
    const anchor = this.readingPosition.capture(this.visible.slice(0, this.loadedCount).map((item) => item.path));
    if (!anchor) return;
    if (this.deskId) { this.plugin.desks.setAnchor(this.deskId, anchor); this.schedulePersist(); }
    else { this.temp.anchor = anchor; this.schedulePersist(); }
  }

  private async restoreAnchor(): Promise<void> {
    if (!this.readingPosition) return;
    const anchor = this.desk()?.anchor ?? this.temp.anchor;
    if (!anchor) return;
    const paths = this.visible.slice(0, this.loadedCount).map((item) => item.path);
    if (!paths.includes(anchor.filePath)) return;
    try { await this.readingPosition.restore(anchor, paths); } catch { /* 尽力恢复；失败不阻塞阅读 */ }
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.deskId && this.plugin.desks.exists(this.deskId)) void this.plugin.desks.save(this.deskId);
      else this.view.requestSaveState();
    }, 300);
  }

  private mutateReading(change: (state: DeskReadingState) => void): void {
    const state = this.readingState();
    change(state);
    if (this.deskId) this.plugin.desks.markDirty(this.deskId, () => {});
    this.schedulePersist();
  }

  // ------------------------------------------------------------- focus
  private enterFocus(): FocusRuntime {
    const anchor = this.readingPosition?.capture(this.visible.slice(0, this.loadedCount).map((item) => item.path));
    const runtime: FocusRuntime = { sessionId: crypto.randomUUID(), query: "", kind: "all", includeHidden: false, cursor: 0, normalAnchor: anchor };
    this.focus = runtime;
    this.streamEl.addClass("is-hidden");
    this.focusResultsEl.removeClass("is-hidden");
    this.focusBar?.el.removeClass("is-hidden");
    return runtime;
  }

  private clearFocusPublish(): void {
    if (this.focusPublishTimer !== null) { window.clearTimeout(this.focusPublishTimer); this.focusPublishTimer = null; }
    this.pendingFocusResults = null;
  }

  private scheduleFocusPublish(results: readonly FocusResult[]): void {
    this.pendingFocusResults = [...results];
    if (this.focusPublishTimer !== null) return;
    this.focusPublishTimer = window.setTimeout(() => {
      this.focusPublishTimer = null;
      const pending = this.pendingFocusResults;
      this.pendingFocusResults = null;
      if (!pending || !this.focus) return;
      this.focusResults?.setPartial(this.sortFocusResults(pending), "running", this.focusRunProgress?.total);
    }, 150);
  }

  private async startFocus(): Promise<void> {
    if (!this.collection || !this.focus) return;
    const runtime = this.focus;
    if (!runtime.query.trim() && runtime.kind === "all") { this.exitFocus(); return; }
    runtime.controller?.abort();
    this.clearFocusPublish();
    runtime.run = undefined;
    runtime.cursor = 0;
    const controller = new AbortController();
    runtime.controller = controller;
    const request: FocusRequest = {
      sessionId: runtime.sessionId, ...(this.deskId ? { deskId: this.deskId } : {}), scopeRevision: this.scopeRevision,
      collectionGeneration: this.collection.generation, query: runtime.query, kind: runtime.kind, includeHidden: runtime.includeHidden,
    };
    const candidates = this.focusCandidates(runtime.includeHidden);
    const session = runtime.sessionId;
    const generation = ++this.focusGeneration;
    this.focusRunProgress = { total: candidates.length, scanned: 0, failed: 0, files: 0, units: 0, keywords: 0, phase: "running" };
    this.updateFocusStatus();
    // 新查询立即清除旧结果，避免旧数据冒充当前查询。
    this.focusResults?.setPartial([], "running", candidates.length);
    const run = await this.plugin.focusSearch.run(request, candidates, controller.signal, this.collection.completeness === "complete", (progress, results) => {
      if (!this.focus || this.focus.sessionId !== session || generation !== this.focusGeneration) return;
      this.focusRunProgress = progress;
      this.updateFocusStatus();
      // 检索未结束也发布已找到的结果，慢文件不阻塞已有材料。
      if (progress.phase === "running") this.scheduleFocusPublish(results);
    });
    if (!this.focus || this.focus.sessionId !== session || generation !== this.focusGeneration) return;
    this.clearFocusPublish();
    run.results = this.sortFocusResults(run.results);
    runtime.run = run;
    runtime.cursor = 0;
    this.focusResults?.setRun(run);
    this.updateFocusStatus();
    const first = run.results[0];
    if (first) this.focusResults?.focusMatch(first.key, 0);
  }

  private sortFocusResults(results: readonly FocusResult[]): FocusResult[] {
    const ordered = this.focusCandidates(this.focus?.includeHidden ?? false);
    const rank = new Map<string, number>();
    ordered.forEach((item, index) => rank.set(item.path, index));
    const at = (path: string): number => rank.get(path) ?? Number.MAX_SAFE_INTEGER;
    return [...results]
      .sort((a, b) => at(a.filePath) - at(b.filePath) || a.unitRange.from - b.unitRange.from || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      .map((result) => ({ ...result, order: at(result.filePath) }));
  }

  /** 聚焦中是纯排序变化：仅重排当前查询的结果，不重扫正文。 */
  private resortFocusResults(): void {
    if (!this.focus || !this.focusResults) return;
    const results = this.focusResults.results();
    const current = this.focusEntries(results)[this.focus.cursor];
    const sorted = this.sortFocusResults(results);
    if (this.focus.run) {
      this.focus.run.results = sorted;
      this.focusResults.setRun(this.focus.run, true);
    } else {
      this.focusResults.setPartial(sorted, this.focusRunProgress?.phase ?? "running", this.focusRunProgress?.total);
    }
    if (current) {
      const index = this.focusEntries(sorted).findIndex((entry) => entry.key === current.key && entry.index === current.index);
      this.focus.cursor = Math.max(0, index);
      if (index >= 0) this.focusResults.focusMatch(current.key, current.index);
    }
    this.updateFocusStatus();
  }

  private focusCandidates(includeHidden: boolean): CollectionItem[] {
    if (!this.collection) return [];
    const filtered = metadataFilter(this.collection.items, this.readingState().filter);
    const scope = includeHidden ? filtered : applyHidden(filtered, this.readingState().dismissed, false);
    return stableSort(scope, this.readingState());
  }

  private updateFocusStatus(): void {
    const progress = this.focusRunProgress;
    this.statusEl.empty();
    if (!progress) return;
    const key = this.focus?.query.trim() ? "status.focus" : "status.focusNoKeywords";
    this.statusEl.createSpan({ text: t(key, { total: progress.total, scanned: progress.scanned, files: progress.files, units: progress.units, keywords: progress.keywords }) });
    if (progress.phase === "cancelled") this.statusEl.createSpan({ text: t("status.cancelled") });
    else if (progress.phase === "failed") this.statusEl.createSpan({ text: t("status.failed") });
    else if (progress.phase === "partial") this.statusEl.createSpan({ text: t("status.partial", { failed: progress.failed }) });
    this.focusBar?.render();
  }

  exitFocus(): void {
    const runtime = this.focus;
    this.abortOperations();
    this.cancelFocus(false);
    this.streamEl.removeClass("is-hidden");
    this.focusResultsEl.addClass("is-hidden");
    this.focusBar?.el.addClass("is-hidden");
    this.focusResults?.clear();
    this.focusRunProgress = undefined;
    // 聚焦期间集合可能已变化：退出时基于最新集合重建普通阅读。
    this.recomputeVisible(true);
    if (runtime?.normalAnchor) void this.readingPosition?.restore(runtime.normalAnchor, this.visible.slice(0, this.loadedCount).map((item) => item.path));
    this.focusBar?.focusInput();
  }

  private cancelFocus(silent: boolean): void {
    const runtime = this.focus;
    runtime?.controller?.abort();
    this.clearFocusPublish();
    if (!silent) {
      this.focus = undefined;
      this.focusGeneration++;
      this.focusRunProgress = undefined;
    } else {
      this.focus = undefined;
      this.focusGeneration++;
    }
  }

  // FocusBarHost
  getQuery(): string { return this.focus?.query ?? ""; }
  setQuery(query: string): void {
    if (!this.focus) { if (!query.trim()) return; this.enterFocus(); }
    this.focus!.query = query;
    void this.startFocus();
  }
  getKind(): FocusKind { return this.focus?.kind ?? "all"; }
  setKind(kind: FocusKind): void {
    if (!this.focus) { if (kind === "all") return; this.enterFocus(); }
    this.focus!.kind = kind;
    void this.startFocus();
  }
  isIncludeHidden(): boolean { return this.focus?.includeHidden ?? false; }
  toggleIncludeHidden(): void {
    if (!this.focus) this.enterFocus();
    this.focus!.includeHidden = !this.focus!.includeHidden;
    void this.startFocus();
  }
  hasResults(): boolean { return this.focusResults?.hasResults() ?? false; }
  progress(): FocusProgress | undefined { return this.focusRunProgress; }
  cancel(): void { this.focus?.controller?.abort(); }
  retry(): void { void this.startFocus(); }
  private focusEntries(results: readonly FocusResult[]): Array<{ key: string; index: number }> {
    // 展开为“结果 × 命中处”的可导航序列，便于逐处遍历同块命中。
    const entries: Array<{ key: string; index: number }> = [];
    for (const result of results) {
      const count = Math.max(1, result.occurrences?.length ?? 1);
      for (let index = 0; index < count; index++) entries.push({ key: result.key, index });
    }
    return entries;
  }
  move(delta: number): void {
    if (!this.focus) return;
    const entries = this.focusEntries(this.focusResults?.results() ?? []);
    if (!entries.length) return;
    this.focus.cursor = Math.max(0, Math.min(entries.length - 1, this.focus.cursor + delta));
    const entry = entries[this.focus.cursor];
    this.focusResults?.focusMatch(entry.key, entry.index);
  }

  // FocusResultsHost
  targetLabel(): string {
    const target = this.getTarget();
    if (!target) return "";
    try { return this.plugin.editors.path(target.fileRef); } catch { return target.path; }
  }

  private abortOperations(): void {
    for (const controller of this.operationControllers) controller.abort();
    this.operationControllers.clear();
    // 旧会话的拖拽令牌随切桌／关闭一起失效。
    for (const token of this.focusDragTokens) this.plugin.dragTokens.delete(token);
    this.focusDragTokens.clear();
  }

  async cite(result: FocusResult, action: "insert" | "copy", options: FocusCiteOptions = {}): Promise<void> {
    if (options.selectionInvalid) { this.feedbackEl.setText(t("error.SOURCE_MAPPING_UNSUPPORTED")); return; }
    const binding = this.getTarget();
    let ticket;
    if (action === "insert") {
      try { ticket = this.plugin.editors.ticket(binding); }
      catch (error) { this.feedbackEl.setText(t(`error.${error instanceof CitationError ? error.code : "TARGET_MISSING"}`)); return; }
    }
    await this.performFocusCitation(result, action, options, ticket,
      () => { if (binding) this.plugin.editors.show(binding); },
      ticket ? () => this.plugin.editors.ticket(binding) : undefined);
  }

  /** 从拖拽落点接收编辑器写入，实际目标以回执 ticket 为准。 */
  drag(result: FocusResult, options: FocusCiteOptions = {}): string | undefined {
    if (options.selectionInvalid) { this.feedbackEl.setText(t("error.SOURCE_MAPPING_UNSUPPORTED")); return; }
    const token = crypto.randomUUID();
    const deskId = this.deskId;
    const sessionId = this.focus?.sessionId;
    this.focusDragTokens.add(token);
    this.plugin.dragTokens.set(token, (ticket, error) => {
      this.plugin.dragTokens.delete(token);
      this.focusDragTokens.delete(token);
      if (error || !ticket) { this.feedbackEl.setText(t(`error.${error?.code ?? "DROP_POSITION_UNAVAILABLE"}`)); return; }
      // 拖拽令牌只在原会话内有效；切桌后旧拖拽不得写入新书桌的稿件。
      if (this.deskId !== deskId || this.focus?.sessionId !== sessionId) {
        this.feedbackEl.setText(t("error.OPERATION_CANCELLED"));
        return;
      }
      void this.performFocusCitation(result, "insert", options, ticket,
        () => { void this.plugin.app.workspace.openLinkText(this.plugin.editors.path(ticket.fileRef), "", false); });
    });
    return token;
  }

  private async resolveFocusCapture(
    result: FocusResult,
    options: FocusCiteOptions,
    signal: AbortSignal,
  ): Promise<{
    snapshot: SourceSnapshot;
    span: import("./citationTypes").OriginSpan;
    mode: "block" | "fragment";
    content: string;
    selectedRanges: TextRange[];
    sourcePath: string;
  } | undefined> {
    const item = this.collection?.items.find((candidate) => candidate.fileRef === result.sourceRef);
    if (!item) { this.feedbackEl.setText(t("error.SOURCE_MISSING")); return; }
    let text: string;
    try { text = await this.plugin.editors.readSource(result.sourceRef); }
    catch { this.feedbackEl.setText(t("error.SOURCE_READ_FAILED")); return; }
    if (signal.aborted) return;
    // 来源版本必须与结果生成时一致，否则旧预览不得冒充当前来源。
    if (result.sourceVersion !== this.plugin.searchReader.version(result.sourceRef)) {
      this.feedbackEl.setText(t("error.SOURCE_STALE") + " · " + t("focus.refresh"));
      return;
    }
    const snapshot = this.plugin.blockIds.capture(item.file, text, item.title);
    let span = snapshot.spans.find((candidate) => candidate.rawRange.from === result.originRange.from && candidate.rawRange.to === result.originRange.to);
    if (!span) span = snapshot.spans.filter((candidate) => candidate.rawRange.from <= result.originRange.from && candidate.rawRange.to >= result.originRange.to)
      .sort((a, b) => (a.rawRange.to - a.rawRange.from) - (b.rawRange.to - b.rawRange.from))[0];
    if (!span) { this.feedbackEl.setText(t("error.SOURCE_STALE")); return; }
    if (result.originHash && hashText(span.rawText) !== result.originHash) {
      this.feedbackEl.setText(t("error.SOURCE_STALE") + " · " + t("focus.refresh"));
      return;
    }
    const mode: "block" | "fragment" = options.wholeBlock ? "block" : "fragment";
    const preview = result.occurrences?.[options.matchIndex ?? 0] ?? result.preview;
    if (options.selection !== undefined && !preview?.text.includes(options.selection)) {
      this.feedbackEl.setText(t("error.SOURCE_MAPPING_UNSUPPORTED"));
      return;
    }
    const content = options.wholeBlock
      ? this.plugin.blockIds.content(span)
      : options.selection ?? preview?.text ?? this.plugin.blockIds.content(span);
    // 即使未收到版本通知，也核对展示文字仍真实存在于当前原文块，避免同长度改写被当作同一来源。
    if (!options.wholeBlock && span.kind !== "code") {
      const visible = visibleCharacters(span.rawText, 0).map((character) => character.value).join("");
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
      if (normalize(content) && !normalize(visible).includes(normalize(content))) {
        this.feedbackEl.setText(t("error.SOURCE_STALE") + " · " + t("focus.refresh"));
        return;
      }
    }
    const selectedRanges = options.wholeBlock
      ? [{ ...span.rawRange }]
      : options.selectedRanges?.length
        ? options.selectedRanges
        : preview?.sourceOffsets.length
          ? rangesFromOffsets(preview.sourceOffsets)
          : [{ ...span.rawRange }];
    return { snapshot, span, mode, content, selectedRanges, sourcePath: item.path };
  }

  private async performFocusCitation(result: FocusResult, action: "insert" | "copy", options: FocusCiteOptions,
    ticket: TargetTicket | undefined, showTarget: () => void,
    currentTicket?: () => TargetTicket): Promise<void> {
    const controller = new AbortController();
    this.operationControllers.add(controller);
    try {
      const resolved = await this.resolveFocusCapture(result, options, controller.signal);
      if (!resolved) return;
      const intent: CitationIntent = { operationId: crypto.randomUUID(), action, snapshot: resolved.snapshot, spans: [resolved.span],
        mode: resolved.mode, content: resolved.content,
        selectionKey: canonicalSelectionKey([resolved.span], resolved.selectedRanges),
        templateId: this.plugin.settings.defaultTemplate,
        customTemplate: this.plugin.settings.customTemplate, date: localDate() };
      await performCitation(this.plugin, intent, this.feedbackEl, ticket, controller.signal,
        showTarget, () => { this.feedbackEl.empty(); }, currentTicket);
    } catch {
      if (!controller.signal.aborted) this.feedbackEl.setText(t("state.error"));
    } finally {
      this.operationControllers.delete(controller);
    }
  }

  async collectToOutline(snapshot: SourceSnapshot, fragment: CapturedFragment): Promise<void>;
  async collectToOutline(result: FocusResult, options?: FocusCiteOptions): Promise<void>;
  async collectToOutline(
    first: SourceSnapshot | FocusResult,
    second?: CapturedFragment | FocusCiteOptions,
  ): Promise<void> {
    if ("spans" in first) {
      const fragment = second as CapturedFragment | undefined;
      if (!fragment) return;
      const sourcePath = this.plugin.editors.path(first.sourceRef);
      const evidenceSnapshot = buildEvidenceSnapshot({ sourcePath, sourceSnapshot: first, fragment });
      await this.beginCollect(first, fragment.spans, evidenceSnapshot);
      return;
    }
    const options = (second as FocusCiteOptions | undefined) ?? {};
    if (options.selectionInvalid) { this.feedbackEl.setText(t("error.SOURCE_MAPPING_UNSUPPORTED")); return; }
    const controller = new AbortController();
    this.operationControllers.add(controller);
    try {
      const resolved = await this.resolveFocusCapture(first, options, controller.signal);
      if (!resolved) return;
      const fragment: CapturedFragment = {
        spans: [resolved.span],
        content: resolved.content,
        mode: resolved.mode,
        selectionKey: canonicalSelectionKey([resolved.span], resolved.selectedRanges),
        selectedRanges: resolved.selectedRanges,
      };
      const evidenceSnapshot = buildEvidenceSnapshot({
        sourcePath: resolved.sourcePath,
        sourceSnapshot: resolved.snapshot,
        fragment,
      });
      await this.beginCollect(resolved.snapshot, [resolved.span], evidenceSnapshot);
    } finally {
      this.operationControllers.delete(controller);
    }
  }

  async collectActiveToOutline(): Promise<void> {
    if (this.activeMode === "outline") {
      this.feedbackEl.setText(t("outline.noActiveSelection"));
      return;
    }
    if (this.focus) {
      try {
        const active = this.focusResults?.activeCapture();
        if (!active) { this.feedbackEl.setText(t("outline.noActiveSelection")); return; }
        await this.collectToOutline(active.result, active.options);
      } catch (error) {
        const code = error instanceof CitationError ? error.code : "SOURCE_MAPPING_UNSUPPORTED";
        this.feedbackEl.setText(t(`error.${code}`));
      }
      return;
    }
    try {
      const captured = CardView.activeCaptureIn(this.streamEl);
      if (!captured) { this.feedbackEl.setText(t("outline.noActiveSelection")); return; }
      await this.plugin.blockIds.inspect(captured.snapshot, captured.fragment.spans);
      await this.collectToOutline(captured.snapshot, captured.fragment);
    } catch (error) {
      const code = error instanceof CitationError ? error.code : "CAPTURE_STALE";
      this.feedbackEl.setText(t(`error.${code}`));
    }
  }

  async expandSection(result: FocusResult, container: HTMLElement, button: HTMLButtonElement): Promise<void> {
    try {
      const text = await this.plugin.editors.readSource(result.sourceRef);
      const range = chapterRange(text, getFrontMatterInfo(text).contentStart, result.originRange.from);
      renderSectionPreview(container, text.slice(range.from, range.to), result.matches
        .filter((match) => match.from >= range.from && match.to <= range.to)
        .map((match) => ({ from: match.from - range.from, to: match.to - range.from })));
      button.setText(t("focus.collapse"));
    } catch {
      container.addClass("is-hidden");
      container.empty();
      button.setText(t("focus.expandSection"));
      this.feedbackEl.setText(t("error.SOURCE_READ_FAILED"));
    }
  }

  openSource(target: FocusResult | EvidenceEntry): void {
    if ("snapshot" in target) {
      const origin = target.snapshot.origins[0];
      const anchor = origin?.blockId ? `#^${origin.blockId}` : origin?.heading ? `#${origin.heading}` : "";
      void this.plugin.app.workspace.openLinkText(target.snapshot.source.path + anchor, "", false);
      return;
    }
    const anchor = target.heading ? `#${target.heading}` : "";
    void this.plugin.app.workspace.openLinkText(target.filePath + anchor, "", false);
  }

  // ------------------------------------------------------------- CardHost
  async readSource(card: CardModel): Promise<string> {
    return this.plugin.editors.readSource(this.plugin.editors.fileRef(card.file));
  }
  toggleCollapse(card: CardModel): void {
    const state = this.readingState();
    if (this.isCollapsed(card.path)) {
      state.collapsed = state.collapsed.filter((path) => path !== card.path);
      if (state.density === "compact" && !state.compactExpanded.includes(card.path)) state.compactExpanded.push(card.path);
    } else {
      if (!state.collapsed.includes(card.path)) state.collapsed.push(card.path);
      state.compactExpanded = state.compactExpanded.filter((path) => path !== card.path);
    }
    if (this.deskId) this.plugin.desks.markDirty(this.deskId, () => {});
    this.schedulePersist();
  }
  private isCollapsed(path: string): boolean {
    const state = this.readingState();
    return state.collapsed.includes(path) || (state.density === "compact" && this.plugin.settings.compactDefaultCollapsed && !state.compactExpanded.includes(path));
  }
  togglePin(card: CardModel): void {
    this.mutateReading((state) => {
      state.pinned = state.pinned.includes(card.path) ? state.pinned.filter((path) => path !== card.path) : [...state.pinned, card.path];
    });
    this.recomputeVisible(false);
  }
  dismiss(card: CardModel): void {
    this.mutateReading((state) => { if (!state.dismissed.includes(card.path)) state.dismissed.push(card.path); });
    this.recomputeVisible(false);
  }
  reselectSource(card: CardModel): void {
    this.mutateReading((state) => {
      state.density = "full";
      state.collapsed = state.collapsed.filter((path) => path !== card.path);
    });
    this.recomputeVisible(false);
  }
  getTarget(): TargetBinding | undefined { return this.binding; }
  getCitationFeedback(): HTMLElement { return this.feedbackEl; }
  refreshCitationContext(): void {
    this.targetBar?.render();
    this.stream?.refreshCitationContext();
    this.updateModeSwitch();
    if (this.activeMode === "outline" && !this.outlinePanel?.hasPendingNotes()) {
      this.outlinePanel?.render();
    }
  }
  bindTarget(editorId: string): void {
    try {
      this.binding = this.plugin.editors.bind(editorId, this.binding);
      if (this.deskId) { void this.plugin.desks.setTarget(this.deskId, this.binding.path); }
      this.refreshCitationContext();
      this.deskSelector?.render();
    } catch (error) { this.feedbackEl.setText(t(`error.${error instanceof CitationError ? error.code : "TARGET_MISSING"}`)); }
  }
  private currentTargetPath(): string | undefined {
    const desk = this.desk();
    if (desk?.targetPath) return desk.targetPath;
    if (this.temp.targetPath) return this.temp.targetPath;
    return undefined;
  }

  // ------------------------------------------------------------- ToolbarHost
  getDensity(): Density { return this.readingState().density; }
  setDensity(density: Density): void { this.mutateReading((state) => { state.density = density; }); this.recomputeVisible(false); }
  getSort(): SortKey { return this.readingState().sort; }
  getSortAsc(): boolean { return this.readingState().sortAsc; }
  setSort(key: SortKey): void {
    this.mutateReading((state) => { state.sort = key; });
    if (this.focus) { this.resortFocusResults(); return; }
    this.recomputeVisible(false);
  }
  setSortAsc(asc: boolean): void {
    this.mutateReading((state) => { state.sortAsc = asc; });
    if (this.focus) { this.resortFocusResults(); return; }
    this.recomputeVisible(false);
  }
  getFilter(): string { return this.readingState().filter; }
  setFilter(value: string): void {
    this.mutateReading((state) => { state.filter = value; });
    this.scopeRevision++;
    if (this.focus) { void this.startFocus(); return; }
    this.recomputeVisible(true);
  }
  toggleShowHidden(): void {
    this.mutateReading((state) => { state.showHidden = !state.showHidden; });
    this.scopeRevision++;
    if (this.focus) { void this.startFocus(); return; }
    this.recomputeVisible(true);
  }
  isShowHidden(): boolean { return this.readingState().showHidden; }
  collapseAll(): void {
    this.mutateReading((state) => {
      for (const item of this.visible) if (!state.collapsed.includes(item.path)) state.collapsed.push(item.path);
      state.compactExpanded = [];
    });
    this.stream?.collapseAll(true);
  }
  expandAll(): void {
    this.mutateReading((state) => { state.collapsed = []; if (state.density === "compact") state.compactExpanded = this.visible.map((item) => item.path); });
    this.stream?.collapseAll(false);
  }
  clearCache(): void { this.plugin.searchReader.clear(); this.plugin.renderService.clearCache(); new Notice(t("tb.clearCache")); this.refresh(); }
  isFocusActive(): boolean { return !!this.focus; }

  // ------------------------------------------------------------- SourceBarHost
  get app(): App { return this.plugin.app; }
  getRules(): DeskRule[] { return this.desk()?.rules ?? this.temp.rules; }
  getManualPaths(): string[] { return this.desk()?.manualPaths ?? this.temp.manualPaths; }
  addRule(spec: DeskRule["spec"]): void {
    if (this.deskId) this.plugin.desks.addRule(this.deskId, spec);
    else {
      const signature = JSON.stringify(spec);
      if (!this.temp.rules.some((rule) => JSON.stringify(rule.spec) === signature)) this.temp.rules.push({ id: `rule-${crypto.randomUUID()}`, spec });
    }
    this.schedulePersist();
    this.scopeRevision++;
    void this.refreshCollection();
  }
  removeRule(id: string): void {
    if (this.deskId) this.plugin.desks.removeRule(this.deskId, id);
    else this.temp.rules = this.temp.rules.filter((rule) => rule.id !== id);
    this.schedulePersist();
    this.scopeRevision++;
    void this.refreshCollection();
  }
  addManual(path: string): void {
    if (this.deskId) this.plugin.desks.addManual(this.deskId, path);
    else if (!this.temp.manualPaths.includes(path)) this.temp.manualPaths.push(path);
    this.schedulePersist();
    this.scopeRevision++;
    void this.refreshCollection();
  }
  removeManual(path: string): void {
    if (this.deskId) this.plugin.desks.removeManual(this.deskId, path);
    else this.temp.manualPaths = this.temp.manualPaths.filter((item) => item !== path);
    this.schedulePersist();
    this.scopeRevision++;
    void this.refreshCollection();
  }
  defaultFolder(): string { return this.plugin.app.workspace.getActiveFile()?.parent?.path ?? "/"; }
  activeFilePath(): string | null { return this.plugin.app.workspace.getActiveFile()?.path ?? null; }

  // ------------------------------------------------------------- DeskSelectorHost
  currentDesk(): Desk | undefined { return this.desk(); }
  desks(): Desk[] { return this.plugin.desks.list(); }
  recentDesks(): Desk[] { return this.plugin.desks.recent(); }
  isDirty(id?: string): boolean { return this.plugin.desks.isDirty(id ?? this.deskId ?? ""); }
  async openDesk(id: string): Promise<void> {
    if (this.deskId === id) return;
    if (!this.plugin.desks.exists(id)) {
      new Notice(t("desk.missing"));
      this.deskSelector?.render();
      return;
    }
    await this.outlinePanel?.flushPendingNotes();
    this.deskEpoch++;
    this.closeDraft();
    this.pendingCollectAfterCreate = undefined;
    if (this.focus) this.exitFocus();
    this.abortOperations();
    this.readingPosition?.cancelRestore();
    this.captureAnchor();
    if (this.binding) { this.plugin.editors.release(this.binding); this.binding = undefined; }
    this.deskId = id;
    await this.plugin.desks.open(id);
    this.deskSelector?.render();
    this.targetBar?.render();
    this.sourceBar?.update();
    this.toolbar?.update();
    this.updateModeSwitch();
    if (this.activeMode === "outline") this.outlinePanel?.render();
    this.temp = { rules: [], manualPaths: [], reading: defaultReadingState(), targetPath: "" };
    this.view.requestSaveState();
    await this.refreshCollection();
  }
  async createDesk(name: string, targetPath: string, operationId: string): Promise<DeskFormResult> {
    if (this.focus) this.exitFocus();
    const pendingCollect = this.pendingCollectAfterCreate;
    this.pendingCollectAfterCreate = undefined;
    const epoch = ++this.deskEpoch;
    const created = await this.plugin.desks.create({ id: operationId, name, targetPath, rules: this.getRules(), manualPaths: this.getManualPaths(), reading: this.readingState() });
    if (created.result !== "ok") return created.result;
    if (!created.saved || !created.desk) return "saveFailed";
    // 保存期间用户可能已选择其他书桌：迟到的创建不得把视图切回去。
    if (epoch !== this.deskEpoch) { this.deskSelector?.render(); return "ok"; }
    // 新书桌的目标可能不同于原绑定，必须释放旧目标，避免引用写入原来的稿件。
    if (this.binding) { this.plugin.editors.release(this.binding); this.binding = undefined; }
    this.deskId = created.desk.id;
    this.deskSelector?.render();
    this.targetBar?.render();
    this.sourceBar?.update();
    this.toolbar?.update();
    this.updateModeSwitch();
    if (this.activeMode === "outline") this.outlinePanel?.render();
    this.view.requestSaveState();
    await this.refreshCollection();
    if (pendingCollect && pendingCollect.epoch + 1 === this.deskEpoch && !this.destroyed && this.deskId === created.desk.id) {
      try {
        await this.plugin.blockIds.inspect(pendingCollect.sourceSnapshot, pendingCollect.spans);
        await this.performCollect(created.desk.id, pendingCollect.entryId, pendingCollect.evidenceSnapshot);
      } catch (error) {
        const code = error instanceof CitationError ? error.code : "CAPTURE_STALE";
        this.feedbackEl.setText(t(`error.${code}`));
      }
    }
    return "ok";
  }
  async renameDesk(id: string, name: string): Promise<DeskFormResult> {
    const result = await this.plugin.desks.rename(id, name);
    this.deskSelector?.render();
    return result;
  }
  async deleteDesk(id: string): Promise<void> {
    const wasCurrent = this.deskId === id;
    if (wasCurrent) {
      this.deskEpoch++;
      this.closeDraft();
      this.pendingCollectAfterCreate = undefined;
    }
    if (wasCurrent && this.focus) this.exitFocus();
    this.abortOperations();
    this.readingPosition?.cancelRestore();
    if (this.binding) { this.plugin.editors.release(this.binding); this.binding = undefined; }
    await this.plugin.desks.delete(id);
    if (wasCurrent) {
      this.deskId = undefined;
      this.temp = { rules: [], manualPaths: [], reading: defaultReadingState(), targetPath: "" };
      this.view.requestSaveState();
      await this.refreshCollection();
    }
    this.deskSelector?.render();
    this.targetBar?.render();
    this.sourceBar?.update();
    this.toolbar?.update();
    this.updateModeSwitch();
    if (this.activeMode === "outline") this.outlinePanel?.render();
  }
  markdownPaths(): string[] { return this.plugin.app.vault.getMarkdownFiles().map((file) => file.path); }
  suggestedTarget(): string | undefined {
    const active = this.plugin.app.workspace.getActiveFile();
    if (active) return active.path;
    return this.plugin.app.vault.getMarkdownFiles()[0]?.path;
  }
  suggestedName(): string {
    const active = this.plugin.app.workspace.getActiveFile();
    return active ? active.basename : t("desk.new");
  }

  // ------------------------------------------------------------- Outline & Modes
  private setMode(mode: "materials" | "outline"): void {
    if (this.activeMode === mode) return;
    if (mode === "outline") {
      if (!this.focus) this.captureAnchor();
      this.activeMode = "outline";
      this.applyModeVisibility();
      this.outlinePanel?.render();
    } else {
      void this.outlinePanel?.flushPendingNotes();
      this.activeMode = "materials";
      this.applyModeVisibility();
      if (!this.focus) void this.restoreAnchor();
    }
    this.updateModeSwitch();
  }

  private applyModeVisibility(): void {
    const outlineActive = this.activeMode === "outline";
    this.sourceBar?.el.toggleClass("is-hidden", outlineActive);
    this.toolbar?.el.toggleClass("is-hidden", outlineActive);
    this.focusBar?.el.toggleClass("is-hidden", outlineActive || !this.focus);
    this.streamEl?.toggleClass("is-hidden", outlineActive || !!this.focus);
    this.focusResultsEl?.toggleClass("is-hidden", outlineActive || !this.focus);
    this.outlinePanel?.el.toggleClass("is-hidden", !outlineActive);
  }

  private updateModeSwitch(): void {
    const count = this.desk()?.outline.entries.length ?? 0;
    this.outlineTabBtn?.setText(count > 0 ? `${t("outline.tabOutline")} (${count})` : t("outline.tabOutline"));
    this.materialsTabBtn?.toggleClass("is-active", this.activeMode === "materials");
    this.outlineTabBtn?.toggleClass("is-active", this.activeMode === "outline");
  }

  private async beginCollect(
    sourceSnapshot: SourceSnapshot,
    spans: readonly import("./citationTypes").OriginSpan[],
    evidenceSnapshot: EvidenceSnapshot,
  ): Promise<void> {
    if (this.plugin.store.readOnly) {
      this.feedbackEl.setText(t("error.OUTLINE_READONLY"));
      return;
    }
    const entryId = `entry-${crypto.randomUUID()}`;
    if (!this.deskId) {
      const epoch = this.deskEpoch;
      const choice = await citationPrompt(this.plugin.app, t("outline.saveDeskFirst"), [
        { id: "save", label: t("desk.saveAs") },
      ]);
      if (choice !== "save" || this.destroyed || epoch !== this.deskEpoch) return;
      this.pendingCollectAfterCreate = { epoch, entryId, sourceSnapshot, spans, evidenceSnapshot };
      this.openCreateDeskForm();
      return;
    }
    await this.performCollect(this.deskId, entryId, evidenceSnapshot);
  }

  private async performCollect(
    deskId: string,
    entryId: string,
    snapshot: EvidenceSnapshot,
  ): Promise<void> {
    const desk = this.plugin.desks.get(deskId);
    if (!desk || this.deskId !== deskId || !this.plugin.outline) {
      this.feedbackEl.setText(t("error.DESK_DELETED"));
      return;
    }
    const deskGeneration = this.plugin.desks.generation(deskId);
    const controller = new AbortController();
    this.operationControllers.add(controller);
    try {
      let res = await this.plugin.outline.collect({
        deskId,
        deskGeneration,
        expectedRevision: this.plugin.outline.outlineRevision(deskId),
        entryId,
        snapshot,
      });
      if (controller.signal.aborted || this.destroyed) return;
      if (res.code === "DUPLICATE_ENTRY" && res.duplicateEntryId) {
        const existingId = res.duplicateEntryId;
        const choice = await citationPrompt(
          this.plugin.app,
          `${t("outline.duplicatePrompt", { desk: desk.name })}\n${snapshot.content.slice(0, 160)}`,
          [
            { id: "view", label: t("outline.duplicateViewExisting") },
            { id: "collect", label: t("outline.duplicateStillCollect") },
          ],
          controller.signal,
        );
        if (controller.signal.aborted || this.destroyed || this.deskId !== deskId) return;
        if (choice === "view") {
          this.setMode("outline");
          this.outlinePanel?.selectEntry(existingId);
          return;
        }
        if (choice !== "collect") return;
        res = await this.plugin.outline.collect({
          deskId,
          deskGeneration,
          expectedRevision: this.plugin.outline.outlineRevision(deskId),
          entryId,
          snapshot,
          allowDuplicate: true,
        });
      }
      if (controller.signal.aborted || this.destroyed) return;
      this.updateModeSwitch();
      if (this.activeMode === "outline") this.outlinePanel?.render();
      this.feedbackEl.empty();
      if (res.ok && res.saved && res.entry) {
        this.feedbackEl.createDiv({ text: t("outline.addedToDesk", { desk: desk.name }) });
        this.feedbackEl.createEl("button", { cls: "slipstream-btn", text: t("outline.viewInOutline") })
          .addEventListener("click", () => {
            if (this.deskId === deskId) {
              this.setMode("outline");
              this.outlinePanel?.selectEntry(res.entry!.id);
            }
          });
      } else if (res.ok && !res.saved) {
        this.feedbackEl.createDiv({ text: t("outline.statusUnsaved") });
        const retryBtn = this.feedbackEl.createEl("button", { cls: "slipstream-btn", text: t("outline.retrySave") });
        retryBtn.addEventListener("click", () => {
          retryBtn.disabled = true;
          void this.plugin.outline.collect({
            deskId,
            deskGeneration,
            expectedRevision: this.plugin.outline.outlineRevision(deskId),
            entryId,
            snapshot,
          }).then((retryRes) => {
            if (this.destroyed) return;
            if (retryRes.ok && retryRes.saved) {
              this.feedbackEl.setText(t("outline.addedToDesk", { desk: desk.name }));
              if (this.activeMode === "outline") this.outlinePanel?.render();
            } else {
              retryBtn.disabled = false;
              this.feedbackEl.setText(t(`error.${retryRes.code ?? "OUTLINE_SAVE_FAILED"}`));
            }
          });
        });
      } else {
        this.feedbackEl.setText(t(`error.${res.code ?? "OUTLINE_SAVE_FAILED"}`));
      }
    } finally {
      this.operationControllers.delete(controller);
    }
  }

  // OutlinePanelHost
  currentDeskId(): string | undefined { return this.deskId; }
  getOutline(): { outline: EvidenceOutline; revision: number } | undefined {
    if (!this.deskId || !this.plugin.outline) return undefined;
    return this.plugin.outline.getOutline(this.deskId);
  }
  isReadOnly(): boolean { return this.plugin.store.readOnly; }
  recordingEnabled(): boolean { return this.plugin.history.enabled; }
  isSourceMissing(path: string): boolean {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    return !(file instanceof TFile) || file.extension !== "md";
  }
  switchToMaterials(): void { this.setMode("materials"); }
  openCreateDesk(): void { this.openCreateDeskForm(); }
  async retrySave(): Promise<void> {
    if (!this.deskId || !this.plugin.outline) return;
    await this.plugin.outline.save(this.deskId);
    this.deskSelector?.render();
  }
  async setNote(entryId: string, expectedContentRevision: number, note: string, persist = true): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.setNote({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      entryId,
      expectedContentRevision,
      note,
      persist,
    });
    this.deskSelector?.render();
    return res;
  }
  async createGroup(name: string, groupId?: string): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.createGroup({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      name,
      groupId,
    });
    this.deskSelector?.render();
    return res;
  }
  async renameGroup(groupId: string, name: string): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.renameGroup({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      groupId,
      name,
    });
    this.deskSelector?.render();
    return res;
  }
  async moveGroup(groupId: string, direction: "up" | "down"): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.moveGroup({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      groupId,
      direction,
    });
    this.deskSelector?.render();
    return res;
  }
  async removeGroup(groupId: string): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.removeGroup({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      groupId,
    });
    this.deskSelector?.render();
    return res;
  }
  async moveEntry(entryId: string, targetGroupId: string | null | undefined, direction?: "up" | "down"): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.moveEntry({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      entryId,
      targetGroupId,
      direction,
    });
    this.deskSelector?.render();
    return res;
  }
  async removeEntry(entryId: string): Promise<OutlineMutationResult> {
    if (!this.deskId || !this.plugin.outline) return { ok: false, saved: false, outlineRevision: 0, code: "DESK_DELETED" };
    const res = await this.plugin.outline.removeEntry({
      deskId: this.deskId,
      expectedRevision: this.plugin.outline.outlineRevision(this.deskId),
      entryId,
    });
    this.updateModeSwitch();
    this.deskSelector?.render();
    return res;
  }

  openPreview(scope: OutlineScope, existingDraft?: OutlinePreviewDraft): void {
    if (!this.deskId || !this.plugin.outline) {
      this.feedbackEl.setText(t("outline.saveDeskFirst"));
      return;
    }
    const selection = this.plugin.outline.selectEntries(this.deskId, scope);
    if (!selection || (selection.groups.length === 0 && selection.entries.length === 0)) {
      this.feedbackEl.setText(t("outline.emptyTitle"));
      return;
    }
    const deskId = this.deskId;
    new OutlineInsertModal({
      plugin: this.plugin,
      deskId,
      scope,
      draft: existingDraft,
      getTicket: () => {
        try { return this.plugin.editors.ticket(this.binding); }
        catch { return undefined; }
      },
      getTargetPath: () => this.currentTargetPath(),
      getTargetError: () => {
        try { this.plugin.editors.ticket(this.binding); return undefined; }
        catch (error) { return error instanceof CitationError ? error.code : "TARGET_MISSING"; }
      },
      getTemplateRevision: () => this.plugin.templateRevision ?? 0,
      renderMarkdown: (markdown, container, sourcePath, component) =>
        MarkdownRenderer.render(this.plugin.app, markdown, container, sourcePath, component),
      openTarget: (path) => {
        if (this.binding) {
          try { this.plugin.editors.show(this.binding); return; } catch { /* fallback to path */ }
        }
        const target = path ?? this.currentTargetPath();
        if (target) void this.plugin.app.workspace.openLinkText(target, "", false);
      },
      openSource: (path, anchor) => {
        void this.plugin.app.workspace.openLinkText(path + (anchor ?? ""), "", false);
      },
      onSuspend: (reason, draft, entryId) => {
        if (this.destroyed || this.deskId !== draft.deskId) return;
        this.previewDraft = { ...draft, state: reason === "target" ? "suspended-target" : "suspended-source", handoff: { kind: reason, entryId } };
        this.renderDraftBanner();
        if (reason === "target" && !this.binding && this.currentTargetPath()) {
          void this.plugin.app.workspace.openLinkText(this.currentTargetPath()!, "", false);
        } else if (reason === "source" && entryId) {
          const entry = this.plugin.outline.getEntry(draft.deskId, entryId);
          if (entry && !this.isSourceMissing(entry.snapshot.source.path)) {
            this.openSource(entry);
          }
        }
      },
      onCancel: (draftId) => {
        if (this.previewDraft?.draftId === draftId) this.closeDraft();
      },
      onCommitted: (outcome, committedDeskId) => {
        this.closeDraft();
        this.updateModeSwitch();
        if (this.activeMode === "outline") this.outlinePanel?.render();
        this.deskSelector?.render();
        this.reportBatchOutcome(outcome, committedDeskId);
      },
      onUncertain: (outcome, committedDeskId) => {
        this.closeDraft();
        this.reportUncertainBatchOutcome(outcome, committedDeskId);
      },
      onPartialSources: (outcome, committedDeskId) => {
        this.reportPartialSourceOutcome(outcome, committedDeskId);
      },
      onOutlineUpdated: () => {
        this.updateModeSwitch();
        if (this.activeMode === "outline") this.outlinePanel?.render();
        this.deskSelector?.render();
      },
    }).open();
  }

  private closeDraft(): void {
    if (this.previewDraft) {
      this.previewDraft.state = "closed";
      this.previewDraft = undefined;
    }
    this.renderDraftBanner();
  }

  private renderDraftBanner(): void {
    if (!this.draftBannerEl) return;
    this.draftBannerEl.empty();
    if (!this.previewDraft || this.previewDraft.deskId !== this.deskId) {
      this.draftBannerEl.addClass("is-hidden");
      return;
    }
    this.draftBannerEl.removeClass("is-hidden");
    const isSource = this.previewDraft.state === "suspended-source";
    this.draftBannerEl.createSpan({ text: t(isSource ? "outline.draftPendingSource" : "outline.draftPendingTarget") });
    this.draftBannerEl.createEl("button", {
      cls: "slipstream-btn",
      text: t(isSource ? "outline.draftReturnSource" : "outline.draftReturn"),
    }).addEventListener("click", () => { void this.resumeDraft(); });
    this.draftBannerEl.createEl("button", {
      cls: "slipstream-btn",
      text: t("outline.draftCancel"),
    }).addEventListener("click", () => this.closeDraft());
  }

  private async resumeDraft(): Promise<void> {
    const draft = this.previewDraft;
    if (!draft || this.destroyed || draft.deskId !== this.deskId || !this.plugin.outline) return;
    const validDesk = this.plugin.desks.exists(draft.deskId) &&
      this.plugin.desks.generation(draft.deskId) === draft.deskGeneration;
    const validScope = validDesk ? this.plugin.outline.selectEntries(draft.deskId, draft.scope) : undefined;
    if (!validDesk || !validScope) {
      this.closeDraft();
      this.feedbackEl.setText(t("outline.draftExpired"));
      return;
    }
    if (draft.state === "suspended-target") {
      this.openPreview(draft.scope, draft);
      return;
    }
    const entryId = draft.handoff?.entryId;
    const entry = entryId ? this.plugin.outline.getEntry(draft.deskId, entryId) : undefined;
    if (!entry) {
      this.closeDraft();
      this.feedbackEl.setText(t("outline.draftExpired"));
      return;
    }
    const candidates = this.collectOpenEditorSelections(entry);
    if (!candidates.length) {
      this.feedbackEl.setText(t("outline.reselectNone"));
      return;
    }
    new SourceReselectConfirmModal(this.plugin.app, entry, candidates, async (chosen) => {
      if (this.destroyed || this.deskId !== draft.deskId || this.previewDraft?.draftId !== draft.draftId) return;
      const latestEntry = this.plugin.outline.getEntry(draft.deskId, entry.id);
      if (!latestEntry) {
        this.closeDraft();
        this.feedbackEl.setText(t("outline.draftExpired"));
        return;
      }
      const res = await this.plugin.outline.refreshEntry({
        deskId: draft.deskId,
        expectedRevision: this.plugin.outline.outlineRevision(draft.deskId),
        entryId: latestEntry.id,
        expectedContentRevision: latestEntry.contentRevision,
        snapshot: chosen,
      });
      if (!res.ok) {
        this.feedbackEl.setText(t(`error.${res.code ?? "ENTRY_STALE"}`));
        return;
      }
      this.updateModeSwitch();
      if (this.activeMode === "outline") this.outlinePanel?.render();
      this.openPreview(draft.scope, draft);
    }).open();
  }

  private collectOpenEditorSelections(entry: EvidenceEntry): Array<{ path: string; snapshot: EvidenceSnapshot }> {
    const out: Array<{ path: string; snapshot: EvidenceSnapshot }> = [];
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !(view.file instanceof TFile) || view.file.extension !== "md") continue;
      if (view.getMode() !== "source") continue;
      const selText = view.editor.getSelection();
      if (!selText || !selText.trim()) continue;
      const fromOffset = view.editor.posToOffset(view.editor.getCursor("from"));
      const toOffset = view.editor.posToOffset(view.editor.getCursor("to"));
      const snapshot = this.captureEditorSelectionSnapshot(
        view.file,
        view.editor.getValue(),
        fromOffset,
        toOffset,
        entry.snapshot.source.capturedPath,
      );
      if (snapshot) out.push({ path: view.file.path, snapshot });
    }
    out.sort((a, b) => (a.path === entry.snapshot.source.path ? -1 : b.path === entry.snapshot.source.path ? 1 : 0));
    return out;
  }

  private captureEditorSelectionSnapshot(
    file: TFile,
    text: string,
    rawFrom: number,
    rawTo: number,
    capturedPath: string,
  ): EvidenceSnapshot | undefined {
    const from = Math.min(rawFrom, rawTo);
    const to = Math.max(rawFrom, rawTo);
    if (to <= from) return undefined;
    const live = this.plugin.blockIds.capture(file, text, file.basename);
    const overlapping = live.spans.filter((span) => span.rawRange.to > from && span.rawRange.from < to);
    const hasChildItem = overlapping.some((span) => span.kind === "list_item");
    const filtered = overlapping.filter((span) => !(hasChildItem && span.kind === "list"))
      .sort((a, b) => a.rawRange.from - b.rawRange.from || b.rawRange.to - a.rawRange.to);
    const origins: SavedOrigin[] = [];
    const selectedRanges: TextRange[] = [];
    let prevTo = 0;
    for (const span of filtered) {
      if (span.rawRange.from < prevTo) continue;
      const selFrom = Math.max(from, span.rawRange.from);
      const selTo = Math.min(to, span.rawRange.to);
      if (selTo <= selFrom) continue;
      prevTo = span.rawRange.to;
      origins.push({
        range: { ...span.rawRange },
        rawText: span.rawText,
        kind: span.kind,
        ...(span.existingBlockId ? { blockId: span.existingBlockId } : {}),
        ...(span.heading ? { heading: span.heading } : {}),
        before: sliceContextBefore(text, span.rawRange.from),
        after: sliceContextAfter(text, span.rawRange.to),
      });
      selectedRanges.push({ from: selFrom, to: selTo });
    }
    if (!origins.length || !selectedRanges.length) return undefined;
    const content = text.slice(from, to);
    if (!content.trim()) return undefined;
    return {
      content,
      mode: "selection",
      source: {
        path: file.path,
        capturedPath,
        title: live.title ?? file.basename,
        capturedAt: Date.now(),
        sourceLength: text.length,
        identity: "path-reference",
      },
      origins,
      selectedRanges,
    };
  }

  private reportPartialSourceOutcome(outcome: BatchCommitOutcome, committedDeskId: string): void {
    const details = outcome.sourceResults
      .filter((sr) => sr.createdIds.length > 0 || sr.kind === "unknown")
      .map((sr) => (sr.createdIds.length > 0
        ? t("outline.sourceCreated", { path: sr.sourcePath, ids: sr.createdIds.join(", ") })
        : t("outline.sourceUnknown", { path: sr.sourcePath })));
    const header = t("outline.commitPartialSources");
    if (this.destroyed || this.deskId !== committedDeskId) {
      new Notice([header, ...details].join("\n"));
      return;
    }
    this.feedbackEl.empty();
    this.feedbackEl.createDiv({ text: header });
    for (const line of details) {
      this.feedbackEl.createDiv({ text: line });
    }
  }

  private reportUncertainBatchOutcome(outcome: BatchCommitOutcome, committedDeskId: string): void {
    const targetPath = outcome.targetPath ?? this.currentTargetPath() ?? "";
    const message = t("outline.commitUncertain", { path: targetPath });
    if (this.destroyed || this.deskId !== committedDeskId) {
      new Notice(message);
      return;
    }
    this.feedbackEl.empty();
    this.feedbackEl.createDiv({ text: message });
    if (targetPath) {
      this.feedbackEl.createEl("button", { cls: "slipstream-btn", text: t("outline.openTarget") })
        .addEventListener("click", () => { void this.plugin.app.workspace.openLinkText(targetPath, "", false); });
    }
  }

  private reportBatchOutcome(outcome: BatchCommitOutcome, committedDeskId: string): void {
    const targetPath = outcome.targetPath ?? this.currentTargetPath() ?? "";
    const message = outcome.recording === "pending"
      ? t("outline.commitPartialRecord", { path: targetPath })
      : outcome.recording === "capacity-exceeded"
        ? t("outline.commitCapacityExceeded", { path: targetPath })
        : t("outline.commitSuccess", { path: targetPath, count: outcome.includedItemCount });
    const otherDesk = this.deskId !== committedDeskId;
    if (otherDesk) {
      new Notice(message);
      if (outcome.recording !== "pending") return;
    }
    if (this.destroyed) {
      if (!otherDesk) new Notice(message);
      return;
    }
    this.feedbackEl.empty();
    const statusLine = this.feedbackEl.createDiv({ text: message });
    if (outcome.recording === "disabled") {
      this.feedbackEl.createDiv({ text: t("outline.recordingDisabledNotice") });
    }
    if (outcome.recording === "pending") {
      const retry = this.feedbackEl.createEl("button", { cls: "slipstream-btn", text: t("outline.retryRecordOnly") });
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void this.plugin.history.retryBatch(outcome.batchId).then(
          (res) => {
            if (this.destroyed) return;
            if (res !== "pending") {
              outcome.recording = res;
              this.feedbackEl.setText(t(res === "capacity-exceeded" ? "outline.commitCapacityExceeded" : "citation.recordSaved", { path: targetPath }));
              if (this.activeMode === "outline") this.outlinePanel?.render();
            } else {
              retry.disabled = false;
            }
          },
          () => {
            if (this.destroyed) return;
            retry.disabled = false;
            statusLine.setText(t("data.saveFailed"));
          },
        );
      });
    }
    if (targetPath) {
      this.feedbackEl.createEl("button", { cls: "slipstream-btn", text: t("outline.openTarget") })
        .addEventListener("click", () => { void this.plugin.app.workspace.openLinkText(targetPath, "", false); });
    }
  }
}

class SourceReselectConfirmModal extends Modal {
  private selectedIdx = 0;

  constructor(
    app: App,
    private entry: EvidenceEntry,
    private candidates: Array<{ path: string; snapshot: EvidenceSnapshot }>,
    private onConfirm: (snapshot: EvidenceSnapshot) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: t("outline.refreshCompareTitle") });
    this.contentEl.createDiv({ text: t("outline.reselectPrompt") });
    if (this.candidates.length > 1) {
      const select = this.contentEl.createEl("select");
      this.candidates.forEach((cand, index) => {
        const opt = select.createEl("option", { value: String(index), text: cand.path });
        if (index === this.selectedIdx) opt.selected = true;
      });
      select.addEventListener("change", () => {
        this.selectedIdx = Number(select.value) || 0;
        this.render();
      });
    }
    const chosen = this.candidates[this.selectedIdx];
    if (chosen.path !== this.entry.snapshot.source.path) {
      this.contentEl.createDiv({ cls: "slipstream-desk-dirty", text: t("outline.newPathNotice", { path: chosen.path }) });
      this.contentEl.createDiv({ cls: "slipstream-anchor-status", text: t("outline.capturedPathNotice", { path: this.entry.snapshot.source.capturedPath }) });
    }
    const compare = this.contentEl.createDiv({ cls: "slipstream-outline-compare" });
    const oldBox = compare.createDiv({ cls: "slipstream-outline-modal-section" });
    oldBox.createDiv({ cls: "slipstream-card-title", text: t("outline.refreshOld") });
    oldBox.createDiv({ cls: "slipstream-outline-entry-content", text: this.entry.snapshot.content });
    const newBox = compare.createDiv({ cls: "slipstream-outline-modal-section" });
    newBox.createDiv({ cls: "slipstream-card-title", text: t("outline.refreshNew") });
    newBox.createDiv({ cls: "slipstream-outline-entry-content", text: chosen.snapshot.content });

    const actions = this.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
    actions.createEl("button", { cls: "slipstream-btn", text: t("common.cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "slipstream-btn", text: t("outline.refreshConfirm") }).addEventListener("click", () => {
      const snapshot = chosen.snapshot;
      this.close();
      void this.onConfirm(snapshot);
    });
  }
}
