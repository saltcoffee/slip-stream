import type { TextRange } from "../domain/citationTypes";
import { t } from "../util/i18n";

const CHUNK_SIZE = 3000;

/** 从当前命中附近开始，按用户操作向前／向后加载同一章节的完整原文。 */
export function renderSectionPreview(container: HTMLElement, text: string, matches: readonly TextRange[]): void {
  container.empty();
  const ordered = [...matches].sort((a, b) => a.from - b.from);
  const match = ordered[0];
  let end = Math.min(text.length, Math.max(CHUNK_SIZE, (match?.to ?? 0) + CHUNK_SIZE / 2));
  let start = Math.max(0, end - CHUNK_SIZE);
  if (match) start = Math.min(start, match.from);
  const status = container.createDiv({ cls: "slipstream-section-status", attr: { role: "status" } });
  const pre = container.createEl("pre", { cls: "slipstream-section-text", attr: { tabindex: "0", "aria-label": t("focus.section") } });
  const controls = container.createDiv({ cls: "slipstream-section-controls" });

  const render = (prepend = false): void => {
    const previousTop = pre.scrollTop;
    const previousHeight = pre.scrollHeight;
    pre.empty();
    let cursor = start;
    for (const range of ordered) {
      const from = Math.max(start, range.from);
      const to = Math.min(end, range.to);
      if (from >= to || from < cursor) continue;
      pre.appendChild(container.ownerDocument.createTextNode(text.slice(cursor, from)));
      pre.createEl("mark", { text: text.slice(from, to) });
      cursor = to;
    }
    pre.appendChild(container.ownerDocument.createTextNode(text.slice(cursor, end)));
    pre.scrollTop = previousTop + (prepend ? pre.scrollHeight - previousHeight : 0);
    status.setText(t("focus.sectionRange", { from: start + 1, to: end, total: text.length }));
    controls.empty();
    if (start > 0) {
      const previous = controls.createEl("button", { cls: "slipstream-btn", text: t("focus.loadPrevious") });
      previous.addEventListener("click", () => {
        start = Math.max(0, start - CHUNK_SIZE);
        render(true);
        (controls.querySelector<HTMLButtonElement>("button") ?? pre).focus();
      });
    }
    if (end < text.length) {
      const next = controls.createEl("button", { cls: "slipstream-btn", text: t("focus.loadMore") });
      next.addEventListener("click", () => {
        end = Math.min(text.length, end + CHUNK_SIZE);
        render();
        (controls.querySelector<HTMLButtonElement>("button:last-child") ?? pre).focus();
      });
    }
  };
  render();
}
