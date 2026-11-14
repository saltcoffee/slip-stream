import { Component } from "obsidian";
import type { CardModel } from "../domain/CardModel";
import { extractSnippet } from "../domain/SnippetExtractor";
import type { Snippet } from "../domain/SnippetExtractor";
import { groupRenderUnits, mapBlocks, originOf } from "../domain/BlockMapper";
import type { Density } from "../domain/types";
import type SlipStreamPlugin from "../main";
import { DragHandle } from "./DragHandle";
import { CitationActions } from "./CitationActions";
import type { SourceSnapshot, TargetBinding } from "../domain/citationTypes";
import { t } from "../util/i18n";

export interface CardHost {
  readSource(card: CardModel): Promise<string>;
  toggleCollapse(card: CardModel): void;
  togglePin(card: CardModel): void;
  dismiss(card: CardModel): void;
  getTarget(): TargetBinding | undefined;
  getCitationFeedback(): HTMLElement;
  reselectSource(card: CardModel): void;
}

export interface CardViewOptions {
  plugin: SlipStreamPlugin;
  card: CardModel;
  density: Density;
  collapsed: boolean;
  pinned: boolean;
  host: CardHost;
}

/** 单卡片 DOM：Header（折叠/标题/字数/Pin/复制/移除）+ Body（按密度渲染）。 */
export class CardView {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;
  private metaEl: HTMLElement;
  private collapseEl: HTMLElement;
  private component?: Component;
  private rendered = false;
  private rendering = false;
  private generation = 0;
  private disposed = false;
  private controlsEl: HTMLElement;
  private actions?: CitationActions;
  private snapshot?: SourceSnapshot;
  private elements: HTMLElement[] = [];

  constructor(private opts: CardViewOptions) {
    const { card, collapsed, pinned } = opts;
    this.el = createDiv({ cls: "slipstream-card" });
    if (pinned) this.el.addClass("is-pinned");
    if (collapsed) this.el.addClass("is-collapsed");

    const header = this.el.createDiv({ cls: "slipstream-card-header" });
    this.collapseEl = header.createSpan({ cls: "slipstream-card-collapse", text: collapsed ? "▶" : "▼" });
    header.createSpan({ cls: "slipstream-card-title", text: card.title }).addEventListener("click", (e) => {
      e.stopPropagation();
      this.openFile();
    });
    this.metaEl = header.createSpan({
      cls: "slipstream-card-meta",
      text: opts.density === "compact" && card.wordCount === 0
        ? ""
        : t("card.words", { n: card.wordCount }),
    });

    const actions = header.createDiv({ cls: "slipstream-card-actions" });
    const pinBtn = actions.createEl("button", {
      cls: "slipstream-btn",
      text: pinned ? "📌" : "📍",
      attr: { "aria-label": t(pinned ? "card.unpin" : "card.pin") },
    });
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.host.togglePin(card);
    });
    const copyBtn = actions.createEl("button", {
      cls: "slipstream-btn",
      text: "⧉",
      attr: { "aria-label": t("card.copy") },
    });
    copyBtn.addEventListener("pointerdown", () => this.actions?.selection());
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.el.hasClass("is-collapsed")) { this.opts.host.toggleCollapse(card); this.setCollapsed(false); }
      if (this.actions) void this.actions.copySelection();
      else this.opts.host.getCitationFeedback().setText(t("citation.selectFirst"));
    });
    const dismissBtn = actions.createEl("button", {
      cls: "slipstream-btn",
      text: "✕",
      attr: { "aria-label": t("card.dismiss") },
    });
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.host.dismiss(card);
    });

    header.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".slipstream-card-actions")) return;
      this.opts.host.toggleCollapse(card);
      this.setCollapsed(!this.el.hasClass("is-collapsed"));
    });

    this.bodyEl = this.el.createDiv({ cls: "slipstream-card-body" });
    this.controlsEl = this.el.createDiv({ cls: "slipstream-card-citation-controls", attr: { "data-no-cite": "true" } });
  }

  setCollapsed(collapsed: boolean): void {
    this.el.toggleClass("is-collapsed", collapsed);
    this.collapseEl.setText(collapsed ? "▶" : "▼");
    if (!collapsed && this.opts.density === "compact") void this.ensureRendered();
  }

  async ensureRendered(): Promise<void> {
    if (this.disposed || this.rendered || this.rendering) return;
    if (this.opts.density === "compact" && this.el.hasClass("is-collapsed")) return;
    this.rendering = true;
    const generation = ++this.generation;
    this.bodyEl.setCssProps({ "--slipstream-min-height": "" });
    try {
      this.component = new Component();
      this.component.load();
      const source = await this.opts.host.readSource(this.opts.card);
      if (this.disposed || generation !== this.generation) return;
      const lines = source.split("\n");
      this.snapshot = this.opts.plugin.blockIds.capture(this.opts.card.file, source, this.opts.card.title);
      this.actions = new CitationActions(this.opts.plugin, this.snapshot, this.bodyEl, this.controlsEl,
        () => this.opts.host.getTarget(), () => { this.opts.host.reselectSource(this.opts.card); }, this.opts.host.getCitationFeedback());
      if (this.opts.density === "snippet") {
        this.renderSnippet(source);
      } else {
        await this.renderFull(source, lines, generation);
      }
      if (this.disposed || generation !== this.generation) return;
      new DragHandle(this.opts.plugin).attach(this.bodyEl, this.elements, this.actions);
      this.rendered = true;
    } catch (e) {
      if (this.disposed || generation !== this.generation) return;
      this.bodyEl.empty();
      const err = this.bodyEl.createDiv({ cls: "slipstream-state" });
      err.createDiv({ text: t("state.renderError") });
      const retry = err.createEl("button", { cls: "slipstream-btn", text: t("common.retry") });
      retry.addEventListener("click", () => {
        this.rendered = false;
        void this.ensureRendered();
      });
      this.opts.plugin.logger.error("render card failed");
    } finally {
      if (generation === this.generation) this.rendering = false;
    }
  }

  unloadBody(): void {
    if (!this.rendered && !this.rendering) return;
    const height = this.bodyEl.offsetHeight;
    this.bodyEl.setCssProps({ "--slipstream-min-height": `${height}px` });
    this.generation++; this.rendering = false;
    this.actions?.destroy(); this.actions = undefined; this.elements = [];
    this.component?.unload();
    this.component = undefined;
    this.bodyEl.empty(); this.controlsEl.empty();
    this.rendered = false;
  }

  destroy(): void {
    this.disposed = true; this.generation++;
    this.actions?.destroy();
    this.component?.unload();
    this.component = undefined;
    this.el.empty();
  }

  private async renderFull(source: string, lines: string[], generation: number): Promise<void> {
    this.opts.card.wordCount = source.replace(/\s+/g, "").length;
    this.metaEl.setText(t("card.words", { n: this.opts.card.wordCount }));
    const blocks = mapBlocks(source, this.snapshot!.bodyStart);
    const units = groupRenderUnits(blocks, lines);
    for (const unit of units) {
      const wrapper = this.bodyEl.createDiv({ cls: "slipstream-block" });
      const content = wrapper.createDiv({ cls: "slipstream-citation-content" });
      await this.opts.plugin.renderService.renderUnit(
        content,
        unit,
        this.opts.card.file,
        this.component!,
        this.opts.plugin.settings
      );
      if (this.disposed || generation !== this.generation) return;
      const origin = originOf(unit);
      origin.rawText = source.slice(origin.rawRange.from, origin.rawRange.to);
      const original = this.snapshot!.spans.find((span) => span.blockKey === origin.blockKey)!;
      this.actions!.addUnit(content, { origin: original, content: this.opts.plugin.blockIds.content(original), mode: "block", key: unit.type });
      this.elements.push(content);
      if (unit.items) {
        const lis = content.querySelectorAll<HTMLElement>("li");
        unit.items.forEach((item, index) => {
          const li = lis[index];
          if (!li) return;
          const span = this.snapshot!.spans.find((candidate) => candidate.blockKey === item.blockKey)!;
          this.actions!.addUnit(li, { origin: span, content: this.opts.plugin.blockIds.content(span), mode: "block", key: `list-item:${index}` });
          this.elements.push(li);
        });
      }
    }
  }

  private renderSnippet(source: string): void {
    const s = this.opts.plugin.settings;
    const blocks = mapBlocks(source, this.snapshot!.bodyStart);
    const { excerpt, highlights, callouts, wordCount } = extractSnippet(
      source,
      blocks,
      s.excerptLength,
      s.snippetIncludeHighlights,
      s.snippetIncludeCallouts,
      s.snippetCalloutLimit
    );
    this.opts.card.wordCount = wordCount;
    this.metaEl.setText(t("card.words", { n: wordCount }));

    if (excerpt) {
      this.addTextBlock(excerpt, "slipstream-excerpt");
    }
    if (s.snippetIncludeHighlights) {
      for (const h of highlights) {
        this.addTextBlock(h, "slipstream-highlight");
      }
    }
    if (s.snippetIncludeCallouts) {
      for (const c of callouts) {
        this.addTextBlock(c, "slipstream-callout");
      }
    }
    if (!excerpt && highlights.length === 0 && callouts.length === 0) {
      this.bodyEl.createDiv({ cls: "slipstream-state", text: t("state.empty") });
    }
  }

  private addTextBlock(
    snippet: Snippet,
    cls: string
  ): void {
    const wrapper = this.bodyEl.createDiv({ cls: "slipstream-block" });
    const content = wrapper.createDiv({ cls: `${cls} slipstream-citation-content`, text: snippet.displayText });
    const origin = this.snapshot!.spans.find((span) => span.blockKey === snippet.origin.blockKey)!;
    const key = `${snippet.id.split(":")[0]}:${(snippet.projection[0] ?? snippet.origin.rawRange.from) - snippet.origin.rawRange.from}`;
    this.actions!.addUnit(content, { origin, content: snippet.displayText, mode: "fragment", key });
    this.elements.push(content);
    if (snippet.truncated) wrapper.createSpan({ cls: "slipstream-truncation", text: "…", attr: { "data-no-cite": "true", "aria-hidden": "true" } });
  }

  refreshCitationContext(): void { this.actions?.refreshContext(); }

  private openFile(): void {
    const leaf = this.opts.plugin.app.workspace.getLeaf("tab");
    void leaf.openFile(this.opts.card.file);
  }
}
