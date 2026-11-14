import { SuggestModal } from "obsidian";
import type { App } from "obsidian";
import type { TargetBinding } from "../domain/citationTypes";
import { CitationError } from "../domain/citationTypes";
import type { EditorGateway, TargetOption } from "../infra/EditorGateway";
import { t } from "../util/i18n";

export class TargetBar {
  readonly el: HTMLElement;
  private unsubscribe: () => void;
  constructor(private app: App, private editors: EditorGateway, private binding: () => TargetBinding | undefined,
    private choose: (editorId: string) => void, private precisionEnabled: () => boolean, private settings: () => void) {
    this.el = createDiv({ cls: "slipstream-targetbar" });
    this.unsubscribe = editors.subscribe(() => this.render());
    this.render();
  }
  render(): void {
    this.el.empty();
    const binding = this.binding();
    let label = t("target.none");
    if (binding) {
      try {
        const ticket = this.editors.ticket(binding);
        label = t("target.position", { path: this.editors.path(binding.fileRef), line: ticket.baselineText.slice(0, ticket.range.from).split("\n").length });
      } catch (error) {
        let path = "";
        try { path = this.editors.path(binding.fileRef); } catch { path = binding.path; }
        label = `${path} · ${t(`error.${error instanceof CitationError ? error.code : "TARGET_STALE"}`)}`;
      }
    }
    this.el.createDiv({ cls: "slipstream-target-status", text: label, attr: { role: "status" } });
    this.el.createEl("button", { cls: "slipstream-btn", text: t("target.choose") }).addEventListener("click", () => this.openChooser());
    if (binding) this.el.createEl("button", { cls: "slipstream-btn", text: t("target.show") }).addEventListener("click", () => {
      try { this.editors.show(binding); } catch { this.openChooser(); }
    });
    this.el.createDiv({ cls: "slipstream-anchor-status", text: t(this.precisionEnabled() ? "anchor.enabled" : "anchor.disabled") });
    this.el.createEl("button", { cls: "slipstream-btn", text: t("target.settings") }).addEventListener("click", this.settings);
  }
  openChooser(): void {
    const options = this.editors.options();
    const choose = this.choose;
    class Chooser extends SuggestModal<TargetOption> {
      getSuggestions(query: string): TargetOption[] { return options.filter((option) => option.label.toLowerCase().includes(query.toLowerCase())); }
      renderSuggestion(option: TargetOption, el: HTMLElement): void { el.setText(option.label); }
      onChooseSuggestion(option: TargetOption): void { choose(option.editorId); }
    }
    const modal = new Chooser(this.app);
    modal.setPlaceholder(t(options.length ? "target.choose" : "target.openFirst"));
    modal.emptyStateText = t("target.empty");
    modal.open();
  }
  destroy(): void { this.unsubscribe(); }
}
