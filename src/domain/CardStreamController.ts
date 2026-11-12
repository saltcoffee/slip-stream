import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import type { CardModel } from "./CardModel";
import { buildCardModel } from "./CardModel";
import { mapBlocks } from "./BlockMapper";
import type { Density, SortKey, SourceSpec } from "./types";
import { createResolver } from "./sources/SourceResolver";
import type SlipStreamPlugin from "../main";
import type { SlipStreamView } from "../view/SlipStreamView";
import { CardStream } from "../view/CardStream";
import { Toolbar } from "../view/Toolbar";
import type { ToolbarHost } from "../view/Toolbar";
import { SourceBar } from "../view/SourceBar";
import type { SourceBarHost } from "../view/SourceBar";
import type { CardHost } from "../view/CardView";
import { renderEmpty, renderError, renderSkeleton } from "../view/states";
import { t } from "../util/i18n";

interface StreamState {
  source?: SourceSpec;
  density: Density;
  sort: SortKey;
  sortAsc: boolean;
  filter: string;
  showHidden: boolean;
  collapsed: Set<string>;
  dismissed: Set<string>;
  pinned: Set<string>;
  customOrder: string[];
}

function compareCards(a: CardModel, b: CardModel, key: SortKey, asc: boolean): number {
  let r = 0;
  if (key === "name") r = a.title.localeCompare(b.title);
  else if (key === "ctime") r = a.ctime - b.ctime;
  else r = a.mtime - b.mtime;
  return asc ? r : -r;
}

/** 编排：数据源 → CardModel[] → 过滤/排序 → CardStream 渲染。 */
export class CardStreamController implements ToolbarHost, SourceBarHost, CardHost {
  private state!: StreamState;
  private cards: CardModel[] = [];
  private stream!: CardStream;
  private streamEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private sourceBar?: SourceBar;
  private saveTimer: number | null = null;

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.view.requestSaveState();
    }, 300);
  }

  constructor(private plugin: SlipStreamPlugin, private view: SlipStreamView) {}

  async restore(viewState: unknown): Promise<void> {
    const s = (viewState ?? {}) as Partial<Record<string, unknown>>;
    this.state = {
      source: (s.source as SourceSpec | undefined) ?? undefined,
      density: (s.density as Density) ?? this.plugin.settings.defaultDensity,
      sort: (s.sort as SortKey) ?? "mtime",
      sortAsc: typeof s.sortAsc === "boolean" ? s.sortAsc : false,
      filter: typeof s.filter === "string" ? s.filter : "",
      showHidden: typeof s.showHidden === "boolean" ? s.showHidden : this.plugin.settings.showDismissed,
      collapsed: new Set(Array.isArray(s.collapsed) ? (s.collapsed as string[]) : []),
      dismissed: new Set(Array.isArray(s.dismissed) ? (s.dismissed as string[]) : []),
      pinned: new Set(Array.isArray(s.pinned) ? (s.pinned as string[]) : []),
      customOrder: Array.isArray(s.customOrder) ? (s.customOrder as string[]) : [],
    };
  }

  serializeViewState(): Record<string, unknown> {
    return {
      source: this.state.source,
      density: this.state.density,
      sort: this.state.sort,
      sortAsc: this.state.sortAsc,
      filter: this.state.filter,
      showHidden: this.state.showHidden,
      collapsed: Array.from(this.state.collapsed),
      dismissed: Array.from(this.state.dismissed),
      pinned: Array.from(this.state.pinned),
      customOrder: this.state.customOrder,
    };
  }

  async mount(root: HTMLElement): Promise<void> {
    this.stream?.destroy();
    root.empty();
    root.addClass("slipstream-root");
    root.appendChild(new Toolbar(this).el);
    this.sourceBar = new SourceBar(this);
    root.appendChild(this.sourceBar.el);
    this.streamEl = root.createDiv({ cls: "slipstream-stream" });
    this.statusEl = root.createDiv({ cls: "slipstream-statusbar" });
    this.stream = new CardStream(
      this.plugin,
      this.streamEl,
      this,
      () => this.state.density,
      (path) => this.state.collapsed.has(path),
      (path) => this.state.pinned.has(path)
    );
    await this.refreshData();
  }

  destroy(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stream?.destroy();
  }

  // ---- 数据 ----
  refresh(): void {
    void this.refreshData();
  }

  refreshSilent(): void {
    void this.refreshData(true);
  }

  private async refreshData(silent = false): Promise<void> {
    const source = this.state.source;
    if (!source) {
      renderEmpty(this.streamEl, t("state.noSource"));
      this.updateStatus();
      return;
    }
    this.stream?.destroy();
    if (!silent) renderSkeleton(this.streamEl, 4);
    try {
      const resolver = createResolver(source.kind);
      const anchor = source.anchorFile
        ? ((this.plugin.app.vault.getAbstractFileByPath(source.anchorFile) as TFile | null) ?? undefined)
        : undefined;
      let files = await resolver.resolve(source, {
        app: this.plugin.app,
        gateway: this.plugin.gateway,
        anchorFile: anchor,
      });
      if (files.length > this.plugin.settings.collectionLimit) {
        files = files.slice(0, this.plugin.settings.collectionLimit);
      }
      this.cards = files.map((f) => buildCardModel(this.plugin.gateway, f));
      this.renderCards();
    } catch (e) {
      this.plugin.logger.error("resolve source failed", e);
      renderError(this.streamEl, t("state.error"), () => this.refresh(), t("common.retry"));
      this.updateStatus();
    }
  }

  private visibleCards(): CardModel[] {
    const kw = this.state.filter.trim().toLowerCase();
    return this.cards.filter((c) => {
      if (this.state.dismissed.has(c.path) && !this.state.showHidden) return false;
      if (!kw) return true;
      const hay = `${c.title} ${c.tags.join(" ")} ${c.path}`.toLowerCase();
      return hay.includes(kw);
    });
  }

  private orderedCards(): CardModel[] {
    const visible = this.visibleCards();
    let base: CardModel[];
    if (this.state.sort === "custom") {
      const order = this.state.customOrder;
      base = [...visible].sort((a, b) => {
        const ia = order.indexOf(a.path);
        const ib = order.indexOf(b.path);
        return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      });
    } else {
      base = [...visible].sort((a, b) =>
        compareCards(a, b, this.state.sort, this.state.sortAsc)
      );
    }
    const pinned = base.filter((c) => this.state.pinned.has(c.path));
    const rest = base.filter((c) => !this.state.pinned.has(c.path));
    return [...pinned, ...rest];
  }

  private renderCards(): void {
    const ordered = this.orderedCards();
    if (ordered.length === 0) {
      this.stream?.destroy();
      if (this.cards.length === 0) renderEmpty(this.streamEl, t("state.empty"));
      else if (this.state.dismissed.size > 0 && !this.state.showHidden)
        renderEmpty(this.streamEl, t("state.allHidden"));
      else renderEmpty(this.streamEl, t("state.filterEmpty"));
      this.updateStatus();
      return;
    }
    this.stream.setCards(ordered);
    this.updateStatus();
  }

  private updateStatus(): void {
    const total = this.cards.length;
    const hidden = this.cards.filter((c) => this.state.dismissed.has(c.path)).length;
    const citations = this.plugin.history.list().length;
    this.statusEl.empty();
    const link = this.statusEl.createSpan({
      cls: "slipstream-status-link",
      text: t("status.summary", { n: total, hidden, citations }),
    });
    link.setAttribute("aria-label", t("history.title"));
    link.addEventListener("click", () => this.plugin.openHistory());
  }

  // ---- CardHost ----
  async readSource(card: CardModel): Promise<string> {
    return this.plugin.gateway.read(card.file);
  }

  toggleCollapse(card: CardModel): void {
    if (this.state.collapsed.has(card.path)) this.state.collapsed.delete(card.path);
    else this.state.collapsed.add(card.path);
    this.scheduleSave();
  }

  togglePin(card: CardModel): void {
    if (this.state.pinned.has(card.path)) this.state.pinned.delete(card.path);
    else this.state.pinned.add(card.path);
    this.scheduleSave();
    this.renderCards();
  }

  dismiss(card: CardModel): void {
    this.state.dismissed.add(card.path);
    this.scheduleSave();
    this.renderCards();
  }

  copy(card: CardModel): void {
    void this.copyAsync(card);
  }

  private async copyAsync(card: CardModel): Promise<void> {
    const source = await this.plugin.gateway.read(card.file);
    const blocks = mapBlocks(this.plugin.app, card.file, source);
    const b = blocks[0];
    await this.plugin.cite.copy({
      filePath: card.path,
      startLine: b ? b.startLine : 0,
      endLine: b ? b.endLine : 1,
      content: b ? b.content : source.slice(0, 200),
      title: card.title,
      mode: "block",
    });
  }

  // ---- ToolbarHost ----
  getDensity(): Density {
    return this.state.density;
  }
  setDensity(d: Density): void {
    this.state.density = d;
    this.scheduleSave();
    this.renderCards();
  }
  getSort(): SortKey {
    return this.state.sort;
  }
  getSortAsc(): boolean {
    return this.state.sortAsc;
  }
  setSort(key: SortKey): void {
    this.state.sort = key;
    this.scheduleSave();
    this.renderCards();
  }
  setSortAsc(asc: boolean): void {
    this.state.sortAsc = asc;
    this.scheduleSave();
    this.renderCards();
  }
  setFilter(value: string): void {
    this.state.filter = value;
    this.renderCards();
  }
  getFilter(): string {
    return this.state.filter;
  }
  toggleShowHidden(): void {
    this.state.showHidden = !this.state.showHidden;
    this.scheduleSave();
    this.renderCards();
  }
  isShowHidden(): boolean {
    return this.state.showHidden;
  }
  collapseAll(): void {
    for (const c of this.orderedCards()) this.state.collapsed.add(c.path);
    this.stream?.collapseAll(true);
    this.scheduleSave();
  }
  expandAll(): void {
    this.state.collapsed.clear();
    this.stream?.collapseAll(false);
    this.scheduleSave();
  }
  clearCache(): void {
    this.plugin.renderService.clearCache();
    new Notice(t("tb.clearCache"));
    this.refresh();
  }

  // ---- SourceBarHost ----
  get app(): App {
    return this.plugin.app;
  }
  getSource(): SourceSpec | undefined {
    return this.state.source;
  }
  setSource(spec: SourceSpec): void {
    this.state.source = spec;
    this.sourceBar?.update();
    this.refresh();
  }
  defaultFolder(): string {
    const active = this.plugin.app.workspace.getActiveFile();
    return active?.parent?.path ?? "/";
  }
  activeFilePath(): string | null {
    return this.plugin.app.workspace.getActiveFile()?.path ?? null;
  }
}
