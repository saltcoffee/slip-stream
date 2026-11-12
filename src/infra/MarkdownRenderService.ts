import type { App, TFile } from "obsidian";
import { Component, MarkdownRenderer } from "obsidian";
import type { RenderUnit } from "../domain/types";
import type { Settings } from "../settings/settings";

interface CacheEntry {
  mtime: number;
  sig: string;
  html: string;
}

const CACHE_LIMIT = 50;

/** 封装 MarkdownRenderer.render（官方渲染）+ LRU 缓存 + 并发控制。 */
export class MarkdownRenderService {
  private cache = new Map<string, CacheEntry>();
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private app: App) {}

  clearCache(): void {
    this.cache.clear();
  }

  async renderUnit(
    container: HTMLElement,
    unit: RenderUnit,
    file: TFile,
    component: Component,
    settings: Settings
  ): Promise<void> {
    const sig = settings.renderMode;
    const key = `${file.path}::${unit.startLine}-${unit.endLine}::${unit.type}`;
    const cacheable = this.isCacheable(unit);
    const cached = cacheable ? this.cache.get(key) : undefined;
    if (cached && cached.mtime === file.stat.mtime && cached.sig === sig) {
      container.innerHTML = cached.html;
      this.annotateList(container, unit);
      return;
    }

    await this.acquire(settings.renderConcurrency);
    try {
      container.innerHTML = "";
      await MarkdownRenderer.render(this.app, unit.content, container, file.path, component);
      this.annotateList(container, unit);
      if (cacheable) {
        this.store(key, { mtime: file.stat.mtime, sig, html: container.innerHTML });
      }
    } finally {
      this.release();
    }
  }

  /** 含嵌入 / 动态查询 / 原始 HTML 的块不缓存，避免 innerHTML 还原后丢失交互与组件生命周期 */
  private isCacheable(unit: RenderUnit): boolean {
    return !/!\[\[|```(?:dataview|dataviewjs|query|js-engine)|<iframe|<img|<video|<audio/i.test(
      unit.content
    );
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

  private store(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
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
