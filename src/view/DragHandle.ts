import { DRAG_SENTINEL, MIME_SLIPSTREAM } from "../constants";
import type SlipStreamPlugin from "../main";
import type { CitationActions } from "./CitationActions";
import type { CapturedFragment } from "./CitationSelection";

/** The external drag payload contains only a short-lived, current-window token. */
export class DragHandle {
  constructor(private plugin: SlipStreamPlugin) {}
  attach(body: HTMLElement, elements: HTMLElement[], actions: CitationActions): void {
    const handle = body.createDiv({ cls: "slipstream-drag-handle", attr: { draggable: "true", "data-no-cite": "true" } });
    let current: HTMLElement | undefined;
    let token: string | undefined;
    let prepared: CapturedFragment | undefined;
    let pointerCaptured = false;
    for (const element of elements) element.addEventListener("mouseenter", (event) => {
      event.stopPropagation();
      current = element;
      handle.setCssProps({ "--slipstream-handle-top": `${element.getBoundingClientRect().top - body.getBoundingClientRect().top}px` });
      handle.classList.add("is-visible");
    });
    body.addEventListener("mouseleave", () => handle.classList.remove("is-visible"));
    handle.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      pointerCaptured = true;
      try { prepared = current ? actions.fragment(current) : undefined; } catch { prepared = undefined; }
    });
    handle.addEventListener("dragstart", (event: DragEvent) => {
      try { token = current && (!pointerCaptured || prepared) ? actions.createDrag(current, prepared) : undefined; } catch { token = undefined; }
      prepared = undefined; pointerCaptured = false;
      if (!token || !event.dataTransfer) { event.preventDefault(); return; }
      event.dataTransfer.setData(MIME_SLIPSTREAM, token);
      event.dataTransfer.setData("text/plain", DRAG_SENTINEL + token);
      event.dataTransfer.effectAllowed = "copy";
    });
    handle.addEventListener("dragend", () => { if (token) this.plugin.dragTokens.delete(token); token = undefined; });
  }
}
