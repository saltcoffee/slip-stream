import { Component } from "obsidian";
import type { CardModel } from "../domain/CardModel";
import { extractSnippet } from "../domain/CardModel";
import type { Snippet } from "../domain/CardModel";
import { groupRenderUnits, mapBlocks } from "../domain/BlockMapper";
import type { Density } from "../domain/types";
import type SlipStreamPlugin from "../main";
import { DragHandle } from "./DragHandle";
import { t } from "../util/i18n";

export interface CardHost {
  readSource(card: CardModel): Promise<string>;
  toggleCollapse(card: CardModel): void;
  togglePin(card: CardModel): void;
  dismiss(card: CardModel): void;
  copy(card: CardModel): void;
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
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.host.copy(card);
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
  }

  setCollapsed(collapsed: boolean): void {
    this.el.toggleClass("is-collapsed", collapsed);
    this.collapseEl.setText(collapsed ? "▶" : "▼");
    if (!collapsed && this.opts.density === "compact") void this.ensureRendered();
  }

  async ensureRendered(): Promise<void> {
    if (this.rendered || this.rendering) return;
    if (this.opts.density === "compact" && this.el.hasClass("is-collapsed")) return;
    this.rendering = true;
    this.bodyEl.setCssProps({ "--slipstream-min-height": "" });
    try {
      this.component = new Component();
      this.component.load();
      const source = await this.opts.host.readSource(this.opts.card);
      const lines = source.split("\n");
      if (this.opts.density === "snippet") {
        this.renderSnippet(source);
      } else {
        await this.renderFull(source, lines);
      }
      new DragHandle(this.opts.plugin).attach(this.bodyEl, this.opts.card, lines);
      this.rendered = true;
    } catch (e) {
      this.bodyEl.empty();
      const err = this.bodyEl.createDiv({ cls: "slipstream-state" });
      err.createDiv({ text: t("state.renderError") });
      const retry = err.createEl("button", { cls: "slipstream-btn", text: t("common.retry") });
      retry.addEventListener("click", () => {
        this.rendered = false;
        void this.ensureRendered();
      });
      this.opts.plugin.logger.error("render card failed", this.opts.card.path, e);
    } finally {
      this.rendering = false;
    }
  }

  unloadBody(): void {
    if (!this.rendered) return;
    const height = this.bodyEl.offsetHeight;
    this.bodyEl.setCssProps({ "--slipstream-min-height": `${height}px` });
    this.component?.unload();
    this.component = undefined;
    this.bodyEl.empty();
    this.rendered = false;
  }

  destroy(): void {
    this.component?.unload();
    this.component = undefined;
    this.el.empty();
  }

  private async renderFull(source: string, lines: string[]): Promise<void> {
    this.opts.card.wordCount = source.replace(/\s+/g, "").length;
    this.metaEl.setText(t("card.words", { n: this.opts.card.wordCount }));
    const blocks = mapBlocks(this.opts.plugin.app, this.opts.card.file, source);
    const units = groupRenderUnits(blocks, lines);
    for (const unit of units) {
      const wrapper = this.bodyEl.createDiv({ cls: "slipstream-block" });
      wrapper.setAttribute("data-src-start", String(unit.startLine));
      wrapper.setAttribute("data-src-end", String(unit.endLine));
      wrapper.setAttribute("data-block-type", unit.type);
      await this.opts.plugin.renderService.renderUnit(
        wrapper,
        unit,
        this.opts.card.file,
        this.component!,
        this.opts.plugin.settings
      );
    }
  }

  private renderSnippet(source: string): void {
    const s = this.opts.plugin.settings;
    const blocks = mapBlocks(this.opts.plugin.app, this.opts.card.file, source);
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
    wrapper.setAttribute("data-src-start", String(snippet.block.startLine));
    wrapper.setAttribute("data-src-end", String(snippet.block.endLine));
    wrapper.setAttribute("data-block-type", snippet.block.type);
    wrapper.createDiv({ cls, text: snippet.text });
  }

  private openFile(): void {
    const leaf = this.opts.plugin.app.workspace.getLeaf("tab");
    void leaf.openFile(this.opts.card.file);
  }
}
