import { DRAG_SENTINEL, MIME_SLIPSTREAM } from "../constants";
import type { DragPayload } from "../domain/types";
import type { CardModel } from "../domain/CardModel";
import type SlipStreamPlugin from "../main";

/** 段落级拖拽手柄：悬停块级元素显示抓手，dragstart 生成 payload。 */
export class DragHandle {
  constructor(private plugin: SlipStreamPlugin) {}

  attach(bodyEl: HTMLElement, card: CardModel, lines: string[]): void {
    const handle = bodyEl.createDiv({ cls: "slipstream-drag-handle" });
    handle.setAttribute("draggable", "true");

    let current: HTMLElement | null = null;
    const position = () => {
      if (!current) return;
      handle.setCssProps({ top: `${current.offsetTop}px` });
    };

    bodyEl.querySelectorAll<HTMLElement>(".slipstream-block").forEach((block) => {
      block.addEventListener("mouseenter", () => {
        current = block;
        position();
        handle.classList.add("is-visible");
      });
    });

    bodyEl.addEventListener("mouseleave", () => handle.classList.remove("is-visible"));
    bodyEl.addEventListener("scroll", position);

    handle.addEventListener("dragstart", (e: DragEvent) => {
      const payload = this.buildPayload(bodyEl, current, card, lines);
      if (!payload) {
        e.preventDefault();
        return;
      }
      this.plugin.isDragging = true;
      const json = JSON.stringify(payload);
      e.dataTransfer?.setData(MIME_SLIPSTREAM, json);
      e.dataTransfer?.setData("text/plain", DRAG_SENTINEL + json);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });

    handle.addEventListener("dragend", () => {
      this.plugin.isDragging = false;
    });
  }

  private buildPayload(
    bodyEl: HTMLElement,
    block: HTMLElement | null,
    card: CardModel,
    lines: string[]
  ): DragPayload | null {
    if (!block) return null;
    const start = Number(block.getAttribute("data-src-start"));
    const end = Number(block.getAttribute("data-src-end"));
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

    let mode: DragPayload["mode"] = "block";
    let content = lines.slice(start, end).join("\n");

    const sel = window.getSelection();
    const selText = sel && sel.rangeCount > 0 ? sel.toString().trim() : "";
    if (selText && sel?.anchorNode && bodyEl.contains(sel.anchorNode)) {
      mode = "selection";
      content = selText;
    }

    return {
      filePath: card.path,
      startLine: start,
      endLine: end,
      content,
      title: card.title,
      mode,
      blockType: (block.getAttribute("data-block-type") as DragPayload["blockType"]) ?? undefined,
      heading: this.deriveHeading(card, start),
    };
  }

  private deriveHeading(card: CardModel, startLine: number): string | undefined {
    const cache = this.plugin.app.metadataCache.getFileCache(card.file);
    const headings = cache?.headings ?? [];
    let current: string | undefined;
    for (const h of headings) {
      if (h.position.start.line <= startLine) current = h.heading;
      else break;
    }
    return current;
  }
}
