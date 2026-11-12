import type { App, TFile } from "obsidian";
import { Component, MarkdownRenderer } from "obsidian";
import type { RenderUnit } from "../domain/types";
import type { Settings } from "../settings/settings";

/** 封装 MarkdownRenderer.render（官方渲染）+ 并发控制。 */
export class MarkdownRenderService {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private app: App) {}

  clearCache(): void {
    // 保留接口：当前不缓存渲染结果（避免 HTML 注入与组件生命周期问题）
  }

  async renderUnit(
    container: HTMLElement,
    unit: RenderUnit,
    file: TFile,
    component: Component,
    settings: Settings
  ): Promise<void> {
    await this.acquire(settings.renderConcurrency);
    try {
      container.empty();
      await MarkdownRenderer.render(this.app, unit.content, container, file.path, component);
      this.annotateList(container, unit);
    } finally {
      this.release();
    }
  }

  private annotateList(container: HTMLElement, unit: RenderUnit): void {
    if (unit.type !== "list" || !unit.items) return;
    const lis = container.querySelectorAll("li");
    unit.items.forEach((it, idx) => {
      const li = lis[idx] as HTMLElement | undefined;
      if (!li) return;
      li.classList.add("slipstream-block");
      li.setAttribute("data-src-start", String(it.startLine));
      li.setAttribute("data-src-end", String(it.endLine));
      li.setAttribute("data-block-type", "list_item");
    });
  }

  private async acquire(max: number): Promise<void> {
    const limit = Math.max(1, max);
    if (this.active >= limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
