import { Modal, Notice, Setting } from "obsidian";
import type SlipStreamPlugin from "../main";
import { getLang, t } from "../util/i18n";

export class HistoryModal extends Modal {
  constructor(private plugin: SlipStreamPlugin) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.empty();
    new Setting(this.contentEl).setName(t("history.title")).setHeading();
    const feedback = this.contentEl.createDiv({ attr: { role: "status" } });
    const records = this.plugin.history.list();
    const list = this.contentEl.createDiv({ cls: "slipstream-history-list" });
    if (!records.length) list.createDiv({ cls: "slipstream-state", text: t("history.empty") });
    for (const record of records) {
      const item = list.createDiv({ cls: "slipstream-history-item" });
      const main = item.createDiv({ cls: "slipstream-history-main" });
      main.createDiv({ cls: "slipstream-history-title", text: record.sourcePath });
      main.createDiv({ text: `${t(`history.${record.action}`)} · ${new Date(record.at).toLocaleString(getLang() === "zh" ? "zh-CN" : "en")}${record.precision ? ` · ${t(`precision.${record.precision}`)}` : ""}${record.targetPath ? ` → ${record.targetPath}` : ""}` });
      main.createDiv({ cls: "slipstream-history-snippet", text: record.snippet });
      item.createEl("button", { cls: "slipstream-btn", text: t("history.jump") }).addEventListener("click", () => {
        const anchor = record.blockId ? `#^${record.blockId}` : record.heading ? `#${record.heading}` : "";
        void this.plugin.app.workspace.openLinkText(record.sourcePath + anchor, "", false);
      });
      if (record.targetPath) item.createEl("button", { cls: "slipstream-btn", text: t("history.openTarget") }).addEventListener("click", () => { void this.plugin.app.workspace.openLinkText(record.targetPath!, "", false); });
      item.createEl("button", { cls: "slipstream-btn", text: t("history.recopy") }).addEventListener("click", async () => {
        try { await this.plugin.editors.copy(record.text ?? record.snippet); feedback.setText(t("notice.copied")); }
        catch { feedback.setText(t("error.CLIPBOARD_DENIED")); }
      });
    }
    this.contentEl.createDiv({ text: t("set.clearHistoryDesc") });
    this.contentEl.createEl("button", { cls: "slipstream-btn", text: t("history.clear") }).addEventListener("click", async () => {
      try { await this.plugin.history.clearHistory(); this.onOpen(); } catch { new Notice(t("data.saveFailed"), 0); }
    });
  }
  onClose(): void { this.contentEl.empty(); }
}
