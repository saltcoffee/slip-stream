import { Modal } from "obsidian";
import type { App } from "obsidian";
import { t } from "../util/i18n";

/** Closing the modal, Escape, or an aborted view always resolves to cancel. */
export function citationPrompt(app: App, message: string, choices: Array<{ id: string; label: string }>, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    class Prompt extends Modal {
      private value?: string;
      private abort = () => this.close();
      onOpen(): void {
        this.contentEl.addClass("slipstream-citation-prompt");
        this.contentEl.createEl("p", { text: message, cls: "slipstream-prompt-message" });
        const actions = this.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
        const cancel = actions.createEl("button", { text: t("common.cancel"), cls: "slipstream-btn" });
        cancel.addEventListener("click", () => this.close());
        for (const choice of choices) {
          const button = actions.createEl("button", { text: choice.label, cls: "slipstream-btn" });
          button.addEventListener("click", () => { this.value = choice.id; this.close(); });
        }
        signal?.addEventListener("abort", this.abort, { once: true });
        cancel.focus();
        if (signal?.aborted) this.close();
      }
      onClose(): void { signal?.removeEventListener("abort", this.abort); resolve(this.value); }
    }
    new Prompt(app).open();
  });
}
