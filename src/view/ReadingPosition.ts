import type { ReadingAnchor } from "../domain/deskTypes";

export interface ReadingHost {
  /** 卡片流的滚动容器。 */
  container: HTMLElement;
  /** 主动物化指定路径卡片并等待实际渲染完成。 */
  ensureRendered(path: string): Promise<void>;
}

export type RestoreStatus = "restored" | "missing" | "hidden";

function cardElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".slipstream-card[data-path]"));
}

/**
 * 从当前卡片流捕获／恢复普通阅读锚点。尽力保持阅读区域，
 * 不承诺像素一致，也绝不把该位置当作引用锚点。
 */
export class ReadingPosition {
  private generation = 0;

  constructor(private host: ReadingHost) {}

  /** 取消任何进行中的恢复，防止迟到任务覆盖新位置。 */
  cancelRestore(): void { this.generation++; }

  capture(paths: readonly string[]): ReadingAnchor | undefined {
    const container = this.host.container;
    const cards = cardElements(container);
    if (!cards.length) return undefined;
    const top = container.scrollTop + 8;
    let current = cards[0];
    for (const card of cards) {
      if (card.offsetTop <= top) current = card;
      else break;
    }
    const height = Math.max(1, current.offsetHeight);
    const inside = Math.min(height, Math.max(0, top - current.offsetTop));
    const path = current.getAttribute("data-path");
    if (!path) return undefined;
    const index = paths.indexOf(path);
    const neighborPaths: string[] = [];
    if (index > 0) neighborPaths.push(paths[index - 1]);
    if (index >= 0 && index < paths.length - 1) neighborPaths.push(paths[index + 1]);
    const block = current.querySelector<HTMLElement>(".slipstream-block");
    const hint = block ? this.hintFor(block) : undefined;
    return {
      filePath: path,
      ...(hint ? { blockHint: hint } : {}),
      cardRatio: Math.min(1, Math.max(0, inside / height)),
      viewportOffset: inside,
      neighborPaths,
    };
  }

  private hintFor(block: HTMLElement): ReadingAnchor["blockHint"] {
    const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
    const heading = block.closest(".slipstream-card")?.querySelector<HTMLElement>(".slipstream-card-title")?.textContent?.trim();
    if (!text && !heading) return undefined;
    return {
      ...(heading ? { heading } : {}),
      rawOffset: 0,
      before: text.slice(0, 80),
      after: text.slice(Math.max(0, text.length - 80)),
    };
  }

  async restore(anchor: ReadingAnchor, available: readonly string[]): Promise<RestoreStatus> {
    const generation = ++this.generation;
    if (!available.includes(anchor.filePath)) return "missing";
    await this.host.ensureRendered(anchor.filePath);
    // 等待渲染期间可能已切桌、刷新或再次恢复：旧任务不得写入滚动位置。
    if (generation !== this.generation) return "missing";
    const container = this.host.container;
    const card = cardElements(container).find((element) => element.getAttribute("data-path") === anchor.filePath);
    if (!card) return "missing";
    if (generation !== this.generation) return "missing";
    const target = Math.max(0, card.offsetTop + anchor.cardRatio * Math.max(1, card.offsetHeight));
    container.scrollTop = target;
    return "restored";
  }
}
