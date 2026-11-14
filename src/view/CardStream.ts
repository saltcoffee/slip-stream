import type { CardModel } from "../domain/CardModel";
import type { Density } from "../domain/types";
import type SlipStreamPlugin from "../main";
import { CardView } from "./CardView";
import type { CardHost } from "./CardView";

/** 卡片流容器 + 虚拟滚动调度（IntersectionObserver 懒渲染 / 离屏卸载）。 */
export class CardStream {
  private views = new Map<string, CardView>();
  private observer: IntersectionObserver | null = null;

  constructor(
    private plugin: SlipStreamPlugin,
    private container: HTMLElement,
    private host: CardHost,
    private density: () => Density,
    private isCollapsed: (path: string) => boolean,
    private isPinned: (path: string) => boolean
  ) {}

  setCards(cards: CardModel[]): void {
    this.destroy();
    this.container.empty();

    if (this.plugin.settings.virtualScroll) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const view = (entry.target as HTMLElement & { _cardView?: CardView })._cardView;
            if (!view) continue;
            if (entry.isIntersecting) void view.ensureRendered();
            else view.unloadBody();
          }
        },
        { root: this.container, rootMargin: "400px" }
      );
    }

    for (const card of cards) {
      const view = new CardView({
        plugin: this.plugin,
        card,
        density: this.density(),
        collapsed: this.isCollapsed(card.path),
        pinned: this.isPinned(card.path),
        host: this.host,
      });
      (view.el as HTMLElement & { _cardView?: CardView })._cardView = view;
      this.views.set(card.path, view);
      this.container.appendChild(view.el);
      if (this.observer) this.observer.observe(view.el);
      else void view.ensureRendered();
    }
  }

  collapseAll(collapsed: boolean): void {
    for (const view of this.views.values()) {
      view.setCollapsed(collapsed);
    }
  }

  refreshCitationContext(): void { this.views.forEach((view) => view.refreshCitationContext()); }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
  }
}
