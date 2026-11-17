import type { FocusKind, FocusProgress } from "../domain/FocusSearch";
import { t } from "../util/i18n";

export interface FocusBarHost {
  getQuery(): string;
  setQuery(query: string): void;
  getKind(): FocusKind;
  setKind(kind: FocusKind): void;
  isIncludeHidden(): boolean;
  toggleIncludeHidden(): void;
  exitFocus(): void;
  move(delta: number): void;
  hasResults(): boolean;
  progress(): FocusProgress | undefined;
  cancel(): void;
  retry(): void;
}

const KINDS: FocusKind[] = ["all", "highlight", "callout", "either"];

/** 正文查找入口：独立于元数据过滤；输入法组合期间不启动中间查询。 */
export class FocusBar {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private kindSelect: HTMLSelectElement;
  private includeHidden: HTMLInputElement;
  private progressEl: HTMLElement;
  private prevButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private composing = false;
  private timer: number | null = null;

  constructor(private host: FocusBarHost) {
    this.el = createDiv({ cls: "slipstream-focusbar" });
    this.input = this.el.createEl("input", { type: "text", attr: { placeholder: t("tb.searchPlaceholder"), "aria-label": t("tb.search") } });
    this.input.value = host.getQuery();
    this.input.addEventListener("compositionstart", () => { this.composing = true; this.clearTimer(); });
    this.input.addEventListener("compositionend", () => { this.composing = false; this.schedule(true); });
    this.input.addEventListener("input", () => { if (!this.composing) this.schedule(false); });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !this.composing) { event.preventDefault(); this.clearTimer(); this.host.setQuery(this.input.value); }
      if (event.key === "Escape") { event.preventDefault(); this.host.exitFocus(); }
    });

    this.kindSelect = this.el.createEl("select", { attr: { "aria-label": t("tb.search") } });
    for (const kind of KINDS) this.kindSelect.createEl("option", { value: kind, text: t(`tb.kind.${kind}`) });
    this.kindSelect.value = host.getKind();
    this.kindSelect.addEventListener("change", () => this.host.setKind(this.kindSelect.value as FocusKind));

    const hiddenLabel = this.el.createEl("label", { cls: "slipstream-focus-hidden" });
    this.includeHidden = hiddenLabel.createEl("input", { type: "checkbox" });
    this.includeHidden.checked = host.isIncludeHidden();
    this.includeHidden.addEventListener("change", () => this.host.toggleIncludeHidden());
    hiddenLabel.createSpan({ text: t("tb.includeHidden") });

    this.progressEl = this.el.createDiv({ cls: "slipstream-focus-progress", attr: { role: "status", "aria-live": "polite" } });
    this.prevButton = this.el.createEl("button", { cls: "slipstream-btn", text: "◀", attr: { "aria-label": t("tb.prevHit") } });
    this.prevButton.addEventListener("click", () => this.host.move(-1));
    this.nextButton = this.el.createEl("button", { cls: "slipstream-btn", text: "▶", attr: { "aria-label": t("tb.nextHit") } });
    this.nextButton.addEventListener("click", () => this.host.move(1));
    this.cancelButton = this.el.createEl("button", { cls: "slipstream-btn", text: t("common.cancel") });
    this.cancelButton.addEventListener("click", () => { if (this.host.progress()?.phase === "running") this.host.cancel(); else this.host.exitFocus(); });
    this.el.createEl("button", { cls: "slipstream-btn", text: t("tb.exitFocus") }).addEventListener("click", () => this.host.exitFocus());

    this.render();
  }

  focusInput(): void { this.input.focus(); }

  private clearTimer(): void { if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; } }

  private schedule(immediate: boolean): void {
    this.clearTimer();
    const value = this.input.value;
    if (immediate) { this.host.setQuery(value); return; }
    this.timer = window.setTimeout(() => { this.timer = null; this.host.setQuery(value); }, 150);
  }

  render(): void {
    const progress = this.host.progress();
    this.kindSelect.value = this.host.getKind();
    this.includeHidden.checked = this.host.isIncludeHidden();
    if (!progress) { this.progressEl.setText(""); this.prevButton.disabled = true; this.nextButton.disabled = true; this.cancelButton.setText(t("common.cancel")); return; }
    const { total, scanned, failed, files, units, keywords, phase } = progress;
    const key = this.host.getQuery().trim() ? "status.focus" : "status.focusNoKeywords";
    const base = t(key, { total, scanned, files, units, keywords });
    let suffix = "";
    if (phase === "running") suffix = ` · ${t("status.searching")}`;
    else if (phase === "cancelled") suffix = ` · ${t("status.cancelled")}`;
    else if (phase === "failed") suffix = ` · ${t("status.failed")}`;
    else if (phase === "partial") suffix = ` · ${t("status.partial", { failed })}`;
    this.progressEl.setText(base + suffix);
    this.prevButton.disabled = !this.host.hasResults();
    this.nextButton.disabled = !this.host.hasResults();
    this.cancelButton.setText(phase === "running" ? t("common.cancel") : t("tb.exitFocus"));
  }

  destroy(): void { this.clearTimer(); }
}
