import { Modal, Notice, SuggestModal } from "obsidian";
import type { App } from "obsidian";
import type { Desk } from "../domain/deskTypes";
import { t } from "../util/i18n";

export type DeskFormResult = "ok" | "duplicateName" | "invalidName" | "missing" | "saveFailed";

export interface DeskSelectorHost {
  readonly app: App;
  currentDesk(): Desk | undefined;
  desks(): Desk[];
  recentDesks(): Desk[];
  isDirty(id: string): boolean;
  openDesk(id: string): Promise<void>;
  createDesk(name: string, targetPath: string, operationId: string): Promise<DeskFormResult>;
  renameDesk(id: string, name: string): Promise<DeskFormResult>;
  deleteDesk(id: string): Promise<void>;
  markdownPaths(): string[];
  suggestedTarget(): string | undefined;
  suggestedName(): string;
}

/** 书桌选择／创建／管理入口；不自行保存根数据。 */
export class DeskSelector {
  readonly el: HTMLElement;
  private label: HTMLElement;
  private saveButton: HTMLElement;
  private manageButton: HTMLElement;

  constructor(private host: DeskSelectorHost) {
    this.el = createDiv({ cls: "slipstream-deskbar" });
    this.label = this.el.createSpan({ cls: "slipstream-desk-label" });
    this.el.createEl("button", { cls: "slipstream-btn", text: t("desk.select"), attr: { "aria-label": t("desk.select") } })
      .addEventListener("click", () => this.openList());
    this.saveButton = this.el.createEl("button", { cls: "slipstream-btn", text: t("desk.saveAs") });
    this.saveButton.addEventListener("click", () => this.openForm());
    this.manageButton = this.el.createEl("button", { cls: "slipstream-btn", text: t("desk.manage") });
    this.manageButton.addEventListener("click", () => new DeskManageModal(this.host).open());
    this.render();
  }

  render(): void {
    const desk = this.host.currentDesk();
    this.label.setText(desk ? t("desk.label", { name: desk.name }) : t("desk.none"));
    this.label.setAttribute("aria-label", desk ? desk.name : t("desk.none"));
    this.saveButton.toggleClass("is-hidden", !!desk);
    this.manageButton.toggleClass("is-hidden", !this.host.desks().length);
  }

  openList(): void {
    new DeskListModal(this.host, (desk) => this.host.openDesk(desk.id), () => this.openForm()).open();
  }

  openForm(): void {
    new DeskFormModal(this.host).open();
  }
}

class DeskListModal extends SuggestModal<Desk> {
  constructor(private host: DeskSelectorHost, private choose: (desk: Desk) => Promise<void>, private create: () => void) {
    super(host.app);
    this.setPlaceholder(t("desk.manage"));
    this.emptyStateText = t("desk.empty");
  }
  getSuggestions(query: string): Desk[] {
    const q = query.trim().toLowerCase();
    const recent = this.host.recentDesks();
    const all = [...recent, ...this.host.desks().filter((desk) => !recent.some((item) => item.id === desk.id))];
    return q ? all.filter((desk) => `${desk.name} ${desk.targetPath}`.toLowerCase().includes(q)) : all;
  }
  renderSuggestion(desk: Desk, el: HTMLElement): void {
    el.createDiv({ text: desk.name });
    el.createDiv({ cls: "slipstream-desk-target", text: desk.targetPath || t("desk.noTarget") });
  }
  onChooseSuggestion(desk: Desk): void {
    void this.choose(desk).catch(() => { new Notice(t("state.error")); });
  }
  onClose(): void { super.onClose(); }
  open(): void { super.open(); }
  // Provide a create entry from the command palette path.
  private createButton(): void { this.create(); }
}

class DeskFormModal extends Modal {
  private name: string;
  private target: string;
  /** 本次创建操作的身份；重试复用，重新打开表单则生成新身份。 */
  private readonly operationId = crypto.randomUUID();
  private error?: HTMLElement;
  constructor(private host: DeskSelectorHost) {
    super(host.app);
    this.name = host.suggestedName();
    this.target = host.suggestedTarget() ?? "";
  }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: t("desk.create") });
    const nameRow = this.contentEl.createDiv({ cls: "slipstream-form-row" });
    nameRow.createEl("label", { text: t("desk.name") });
    const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: t("desk.namePlaceholder"), "aria-label": t("desk.name") } });
    nameInput.value = this.name;
    nameInput.addEventListener("input", () => { this.name = nameInput.value; });

    const targetRow = this.contentEl.createDiv({ cls: "slipstream-form-row" });
    targetRow.createEl("label", { text: t("desk.target") });
    const select = targetRow.createEl("select", { attr: { "aria-label": t("desk.target") } });
    const paths = this.host.markdownPaths();
    if (!this.target && paths.length === 1) this.target = paths[0];
    if (!this.target) select.createEl("option", { value: "", text: t("desk.targetPlaceholder") });
    for (const path of paths) {
      const option = select.createEl("option", { value: path, text: path });
      if (path === this.target) option.selected = true;
    }
    select.addEventListener("change", () => { this.target = select.value; });

    this.error = this.contentEl.createDiv({ cls: "slipstream-form-error", attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
    actions.createEl("button", { cls: "slipstream-btn", text: t("common.cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "slipstream-btn", text: t("desk.save") }).addEventListener("click", () => { void this.submit(); });
  }
  private async submit(): Promise<void> {
    if (!this.name.trim()) { this.showError(t("desk.nameEmpty")); return; }
    if (this.name.trim().length > 80) { this.showError(t("desk.nameTooLong")); return; }
    if (!this.target) { this.showError(t("desk.targetRequired")); return; }
    const result = await this.host.createDesk(this.name, this.target, this.operationId);
    if (result === "ok") { this.close(); return; }
    this.showError(t(result === "duplicateName" ? "desk.nameDuplicate" : result === "invalidName" ? "desk.nameTooLong" : "error.DESK_SAVE_FAILED"));
  }
  private showError(message: string): void { this.error?.setText(message); }
}

export class DeskManageModal extends Modal {
  constructor(private host: DeskSelectorHost) { super(host.app); }
  onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: t("desk.manage") });
    const desks = this.host.desks();
    if (!desks.length) {
      this.contentEl.createDiv({ cls: "slipstream-state", text: t("desk.empty") });
      return;
    }
    for (const desk of desks) {
      const row = this.contentEl.createDiv({ cls: "slipstream-desk-manage-row" });
      const main = row.createDiv({ cls: "slipstream-desk-manage-main" });
      main.createDiv({ text: desk.name });
      main.createDiv({ cls: "slipstream-desk-target", text: desk.targetPath || t("desk.noTarget") });
      if (this.host.isDirty(desk.id)) main.createDiv({ cls: "slipstream-desk-dirty", text: t("desk.unsaved") });
      row.createEl("button", { cls: "slipstream-btn", text: t("desk.open") }).addEventListener("click", () => {
        void this.host.openDesk(desk.id).then(() => { this.close(); }, () => { new Notice(t("state.error")); });
      });
      row.createEl("button", { cls: "slipstream-btn", text: t("desk.rename") }).addEventListener("click", () => { new RenameModal(this.host, desk, () => this.render()).open(); });
      row.createEl("button", { cls: "slipstream-btn", text: t("desk.delete") }).addEventListener("click", () => { void this.remove(desk); });
    }
  }
  private async remove(desk: Desk): Promise<void> {
    const modal = new Modal(this.host.app);
    modal.onOpen = () => {
      modal.contentEl.createEl("p", { text: t("desk.deleteConfirm") });
      const actions = modal.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
      actions.createEl("button", { cls: "slipstream-btn", text: t("common.cancel") }).addEventListener("click", () => modal.close());
      actions.createEl("button", { cls: "slipstream-btn", text: t("desk.delete") }).addEventListener("click", () => {
        void this.host.deleteDesk(desk.id).then(
          () => { modal.close(); this.render(); new Notice(t("desk.deleted")); },
          () => { new Notice(t("error.DESK_SAVE_FAILED")); }
        );
      });
    };
    modal.open();
  }
}

class RenameModal extends Modal {
  constructor(private host: DeskSelectorHost, private desk: Desk, private done: () => void) { super(host.app); }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: t("desk.rename") });
    const input = this.contentEl.createEl("input", { type: "text", attr: { "aria-label": t("desk.renamePrompt") } });
    input.value = this.desk.name;
    const error = this.contentEl.createDiv({ cls: "slipstream-form-error", attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
    actions.createEl("button", { cls: "slipstream-btn", text: t("common.cancel") }).addEventListener("click", () => this.close());
    actions.createEl("button", { cls: "slipstream-btn", text: t("common.ok") }).addEventListener("click", () => {
      void this.host.renameDesk(this.desk.id, input.value).then(
        (result) => {
          if (result === "ok") { this.close(); this.done(); return; }
          error.setText(t(result === "duplicateName" ? "desk.nameDuplicate" : "desk.nameTooLong"));
        },
        () => { error.setText(t("error.DESK_SAVE_FAILED")); }
      );
    });
  }
}
