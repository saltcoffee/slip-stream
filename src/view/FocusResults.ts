import type { FocusRequest, FocusResult, SearchPhase, SearchRun } from "../domain/FocusSearch";
import { DRAG_SENTINEL, MIME_SLIPSTREAM } from "../constants";
import { t } from "../util/i18n";

export interface FocusCiteOptions {
  wholeBlock?: boolean;
  selection?: string;
  selectionInvalid?: boolean;
  /** 当前正在查看的命中位置（用于按处引用）。 */
  matchIndex?: number;
}

export interface FocusResultsHost {
  cite(result: FocusResult, action: "insert" | "copy", options?: FocusCiteOptions): void;
  drag(result: FocusResult, options?: FocusCiteOptions): string | undefined;
  expandSection(result: FocusResult, container: HTMLElement, button: HTMLButtonElement): void;
  openSource(result: FocusResult): void;
  targetLabel(): string;
}

const GROUP_BATCH = 20;
const SOURCE_PAGE = 20;
type PreviewSelection = { element: HTMLElement; text: string } | { invalid: true };

/** 聚焦结果：按来源分组、组内分批、逐处命中导航、选区与整块引用。 */
export class FocusResults {
  readonly el: HTMLElement;
  private groups = new Map<string, { results: FocusResult[]; shown: number }>();
  private run?: SearchRun;
  private elements = new Map<string, HTMLElement>();
  private matchCursor = new Map<string, number>();
  private sourceOffset = 0;
  private lastSelection?: PreviewSelection;
  private selectionListener = (): void => this.captureSelection();
  private pointerListener = (event: PointerEvent): void => {
    const element = event.target instanceof Element ? event.target : undefined;
    if (!element || !this.el.contains(element) || !element.closest(".slipstream-focus-actions,.slipstream-focus-drag")) this.lastSelection = undefined;
  };

  constructor(private host: FocusResultsHost) {
    this.el = createDiv({ cls: "slipstream-focus-results" });
    this.el.ownerDocument.addEventListener("selectionchange", this.selectionListener);
    this.el.ownerDocument.addEventListener("pointerdown", this.pointerListener, true);
  }

  destroy(): void {
    this.el.ownerDocument.removeEventListener("selectionchange", this.selectionListener);
    this.el.ownerDocument.removeEventListener("pointerdown", this.pointerListener, true);
    this.lastSelection = undefined;
  }

  private captureSelection(): void {
    const selection = this.el.ownerDocument.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      this.lastSelection = this.readSelection(selection);
      return;
    }
    const active = this.el.ownerDocument.activeElement;
    if (!active || !this.el.contains(active) || !active.closest(".slipstream-focus-actions,.slipstream-focus-drag")) this.lastSelection = undefined;
  }

  private readSelection(selection: Selection): PreviewSelection | undefined {
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(this.el)) return;
    const node = range.startContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
    const preview = element?.closest<HTMLElement>(".slipstream-focus-preview");
    if (selection.rangeCount !== 1 || !preview || !this.el.contains(preview) || !preview.contains(range.endContainer)
      || Array.from(preview.querySelectorAll(".slipstream-truncation")).some((el) => range.intersectsNode(el))) return { invalid: true };
    const text = selection.toString();
    return text.trim() ? { element: preview, text } : undefined;
  }

  setRun(run: SearchRun, preserveMatches = false): void {
    this.run = run;
    if (!preserveMatches) this.matchCursor.clear();
    this.lastSelection = undefined;
    this.rebuild(true);
  }

  /** 检索未结束时增量发布已找到的结果。 */
  setPartial(results: readonly FocusResult[], phase: SearchPhase, total?: number): void {
    if (!results.length) this.sourceOffset = 0;
    const resolvedTotal = total ?? this.run?.total ?? results.length;
    this.run = {
      request: this.run?.request ?? ({ sessionId: "", scopeRevision: 0, collectionGeneration: 0, query: "", kind: "all", includeHidden: false } as FocusRequest),
      phase, total: resolvedTotal, scanned: this.run?.scanned ?? 0, failed: this.run?.failed ?? 0,
      results: [...results],
      progress: this.run?.progress ?? { total: resolvedTotal, scanned: 0, failed: 0, files: 0, units: results.length, keywords: 0, phase },
    };
    this.rebuild(true);
  }

  clear(): void { this.run = undefined; this.groups.clear(); this.elements.clear(); this.matchCursor.clear(); this.sourceOffset = 0; this.lastSelection = undefined; this.el.empty(); }
  hasResults(): boolean { return (this.run?.results.length ?? 0) > 0; }
  results(): FocusResult[] { return this.run?.results ?? []; }

  private rebuild(resetGroups: boolean): void {
    this.lastSelection = undefined;
    const scroller = this.el.parentElement;
    const scrollTop = scroller?.scrollTop ?? 0;
    const previousShown = new Map([...this.groups].map(([path, group]) => [path, group.shown]));
    this.el.empty();
    if (this.run && (resetGroups || !this.groups.size)) {
      this.groups.clear();
      for (const result of this.run.results) {
        const group = this.groups.get(result.filePath) ?? { results: [], shown: 0 };
        group.results.push(result);
        this.groups.set(result.filePath, group);
      }
      for (const [path, group] of this.groups) {
        const wanted = previousShown.get(path) ?? GROUP_BATCH;
        group.shown = Math.min(group.results.length, Math.max(Math.min(GROUP_BATCH, group.results.length), wanted));
      }
    }
    this.elements = new Map<string, HTMLElement>();
    if (!this.run) return;
    if (!this.run.results.length) {
      const key = this.run.phase === "running" ? "status.searching"
        : this.run.phase === "failed" ? "status.failed" : this.run.phase === "cancelled" ? "status.cancelled"
        : this.run.total === 0 ? "status.emptyRange" : "status.noMatch";
      this.el.createDiv({ cls: "slipstream-state", text: t(key) });
      if (scroller) scroller.scrollTop = scrollTop;
      return;
    }
    const groups = Array.from(this.groups);
    this.sourceOffset = Math.min(this.sourceOffset, Math.max(0, Math.floor((groups.length - 1) / SOURCE_PAGE) * SOURCE_PAGE));
    for (const [filePath, group] of groups.slice(this.sourceOffset, this.sourceOffset + SOURCE_PAGE)) {
      const section = this.el.createDiv({ cls: "slipstream-focus-group" });
      const header = section.createDiv({ cls: "slipstream-focus-group-header" });
      header.createSpan({ cls: "slipstream-focus-group-title", text: filePath });
      header.createSpan({ cls: "slipstream-focus-group-count", text: t("focus.units", { n: group.results.length }) });
      const list = section.createDiv({ cls: "slipstream-focus-group-list" });
      for (const result of group.results.slice(0, group.shown)) this.renderResult(list, result);
      if (group.shown < group.results.length) {
        list.createEl("button", { cls: "slipstream-btn", text: t("focus.loadMore") })
          .addEventListener("click", () => { group.shown = Math.min(group.results.length, group.shown + GROUP_BATCH); this.rebuild(true); });
      }
    }
    if (groups.length > SOURCE_PAGE) {
      const pages = this.el.createDiv({ cls: "slipstream-focus-actions slipstream-focus-source-pages", attr: { tabindex: "-1", "aria-label": t("src.title") } });
      pages.createSpan({ text: t("focus.sourceRange", { from: this.sourceOffset + 1, to: Math.min(groups.length, this.sourceOffset + SOURCE_PAGE), total: groups.length }) });
      const page = (offset: number): void => {
        this.sourceOffset = offset;
        this.rebuild(true);
        if (scroller) scroller.scrollTop = 0;
        this.el.querySelector<HTMLElement>(".slipstream-focus-source-pages")?.focus();
      };
      if (this.sourceOffset > 0) pages.createEl("button", { cls: "slipstream-btn", text: t("focus.previousSources") })
        .addEventListener("click", () => page(Math.max(0, this.sourceOffset - SOURCE_PAGE)));
      if (this.sourceOffset + SOURCE_PAGE < groups.length) pages.createEl("button", { cls: "slipstream-btn", text: t("focus.nextSources") })
        .addEventListener("click", () => page(this.sourceOffset + SOURCE_PAGE));
    }
    if (scroller) scroller.scrollTop = scrollTop;
  }

  private ensureShown(key: string): void {
    const result = this.run?.results.find((entry) => entry.key === key);
    const group = result ? this.groups.get(result.filePath) : undefined;
    if (!result || !group) return;
    const sourceIndex = Array.from(this.groups.keys()).indexOf(result.filePath);
    if (sourceIndex < this.sourceOffset || sourceIndex >= this.sourceOffset + SOURCE_PAGE) this.sourceOffset = Math.floor(sourceIndex / SOURCE_PAGE) * SOURCE_PAGE;
    const index = group.results.findIndex((entry) => entry.key === key);
    if (index >= group.shown) group.shown = Math.min(group.results.length, Math.ceil((index + 1) / GROUP_BATCH) * GROUP_BATCH);
  }

  /** 定位到某条结果的某个命中位置，必要时加载其所在批次。 */
  focusMatch(key: string, matchIndex: number): void {
    this.ensureShown(key);
    this.matchCursor.set(key, matchIndex);
    this.rebuild(true);
    const element = this.elements.get(key);
    if (!element) return;
    element.addClass("is-cursor");
    for (const [other, value] of this.elements) if (other !== key) value.removeClass("is-cursor");
    if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
  }

  scrollTo(key: string): FocusResult | undefined {
    this.focusMatch(key, this.matchCursor.get(key) ?? 0);
    return this.run?.results.find((result) => result.key === key);
  }

  private renderResult(container: HTMLElement, result: FocusResult): void {
    const item = container.createDiv({ cls: "slipstream-focus-result" });
    item.setAttribute("data-focus-key", result.key);
    this.elements.set(result.key, item);
    const handle = item.createDiv({ cls: "slipstream-focus-drag", attr: { draggable: "true", "data-no-cite": "true", "aria-label": t("focus.drag") } });
    let dragSelection: FocusCiteOptions | undefined;
    handle.addEventListener("pointerdown", () => { dragSelection = this.selectionWithin(previewEl); });
    handle.addEventListener("dragstart", (event: DragEvent) => {
      let token: string | undefined;
      try { token = this.host.drag(result, { ...dragSelection, matchIndex: this.matchCursor.get(result.key) ?? 0 }); } catch { token = undefined; }
      dragSelection = undefined;
      if (!token || !event.dataTransfer) { event.preventDefault(); return; }
      event.dataTransfer.setData(MIME_SLIPSTREAM, token);
      event.dataTransfer.setData("text/plain", DRAG_SENTINEL + token);
      event.dataTransfer.effectAllowed = "copy";
    });
    const meta = item.createDiv({ cls: "slipstream-focus-result-meta" });
    meta.createSpan({ cls: "slipstream-focus-heading", text: result.heading ?? t("focus.noHeading") });
    meta.createSpan({ cls: "slipstream-focus-type", text: t(`focus.type.${result.kind}`) });
    const previewEl = item.createDiv({ cls: "slipstream-focus-preview" });
    this.renderPreview(previewEl, result);
    const sectionEl = item.createDiv({ cls: "slipstream-focus-section" });
    sectionEl.addClass("is-hidden");
    const actions = item.createDiv({ cls: "slipstream-focus-actions" });
    let frozenSelection: FocusCiteOptions | undefined;
    const cite = actions.createEl("button", { cls: "slipstream-btn", text: t("focus.cite") });
    cite.addEventListener("pointerdown", () => { frozenSelection = this.selectionWithin(previewEl); });
    cite.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") frozenSelection = this.selectionWithin(previewEl);
    });
    cite.addEventListener("click", () => {
      const selection = frozenSelection ?? this.selectionWithin(previewEl);
      this.host.cite(result, "insert", { ...selection, matchIndex: this.matchCursor.get(result.key) ?? 0 });
      frozenSelection = undefined;
    });
    actions.createEl("button", { cls: "slipstream-btn", text: t("focus.citeBlock") }).addEventListener("click", () => this.host.cite(result, "insert", { wholeBlock: true }));
    const copy = actions.createEl("button", { cls: "slipstream-btn", text: t("focus.copy") });
    copy.addEventListener("pointerdown", () => { frozenSelection = this.selectionWithin(previewEl); });
    copy.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") frozenSelection = this.selectionWithin(previewEl);
    });
    copy.addEventListener("click", () => {
      const selection = frozenSelection ?? this.selectionWithin(previewEl);
      this.host.cite(result, "copy", { ...selection, matchIndex: this.matchCursor.get(result.key) ?? 0 });
      frozenSelection = undefined;
    });
    const expand = actions.createEl("button", { cls: "slipstream-btn", text: t("focus.expandSection") });
    expand.addEventListener("click", () => {
      if (!sectionEl.hasClass("is-hidden")) { sectionEl.addClass("is-hidden"); sectionEl.empty(); expand.setText(t("focus.expandSection")); return; }
      sectionEl.removeClass("is-hidden");
      this.host.expandSection(result, sectionEl, expand);
    });
    actions.createEl("button", { cls: "slipstream-btn", text: t("focus.openNote") }).addEventListener("click", () => this.host.openSource(result));
  }

  private selectionWithin(previewEl: HTMLElement): FocusCiteOptions {
    const selection = previewEl.ownerDocument.getSelection();
    const captured = selection && !selection.isCollapsed && selection.rangeCount ? this.readSelection(selection) : this.lastSelection;
    if (captured && "invalid" in captured) return { selectionInvalid: true };
    return captured?.element === previewEl ? { selection: captured.text } : {};
  }

  private renderPreview(container: HTMLElement, result: FocusResult): void {
    const index = this.matchCursor.get(result.key) ?? 0;
    const preview = result.occurrences?.[index] ?? result.preview;
    container.empty();
    if (!preview) return;
    const match = result.matches[index];
    const matchIndexes: Array<[number, number]> = [];
    for (const range of match ? [match] : result.matches) {
      const start = preview.sourceOffsets.indexOf(range.from);
      const lastIndex = preview.sourceOffsets.indexOf(Math.max(range.from, range.to - 1));
      if (start >= 0 && lastIndex >= start) matchIndexes.push([start, lastIndex + 1]);
    }
    matchIndexes.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [start, end] of matchIndexes) {
      if (start < cursor) continue;
      if (start > cursor) container.appendChild(container.ownerDocument.createTextNode(preview.text.slice(cursor, start)));
      container.createEl("mark", { text: preview.text.slice(start, end) });
      cursor = end;
    }
    if (cursor < preview.text.length) container.appendChild(container.ownerDocument.createTextNode(preview.text.slice(cursor)));
    if (preview.truncated) container.createSpan({ cls: "slipstream-truncation", text: "…" });
  }
}
