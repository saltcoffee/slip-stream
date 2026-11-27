import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingControl, SettingDefinition } from "obsidian";
import type SlipStreamPlugin from "../main";
import { citationPrompt } from "../view/CitationPrompt";
import { validateSettings } from "../infra/PluginDataStore";
import { t, setLanguage } from "../util/i18n";

export class SlipStreamSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SlipStreamPlugin) {
    super(app, plugin);
  }

  /** Declarative settings (Obsidian 1.13+): enables settings search. */
  getSettingDefinitions(): SettingDefinition[] {
    const d = (nameKey: string, control: SettingControl): SettingDefinition => ({
      name: t(nameKey),
      desc: this.description(nameKey),
      control,
    });
    return [
      {
        name: t("set.language"),
        // Control definitions retain the focused row on update(), including its old labels.
        render: (setting) => {
          setting.addDropdown((dropdown) => dropdown
            .addOptions({ auto: t("opt.followObsidian"), zh: "中文", en: "English" })
            .setValue(this.plugin.settings.language)
            .onChange(async (value) => { await this.setControlValue("language", value); }));
        },
      },
      d("set.density", {
        type: "dropdown",
        key: "defaultDensity",
        options: { full: t("tb.full"), snippet: t("tb.snippet"), compact: t("tb.compact") },
      }),
      d("set.placement", {
        type: "dropdown",
        key: "defaultPlacement",
        options: { "right-sidebar": t("opt.right"), split: t("opt.split") },
      }),
      d("set.includeSub", { type: "toggle", key: "includeSubfolders" }),
      d("set.exclude", { type: "text", key: "excludeGlobs" }),
      d("set.pageSize", { type: "number", key: "collectionPageSize", min: 1 }),
      d("set.excerpt", { type: "number", key: "excerptLength", min: 20 }),
      d("set.includeHighlights", { type: "toggle", key: "snippetIncludeHighlights" }),
      d("set.includeCallouts", { type: "toggle", key: "snippetIncludeCallouts" }),
      d("set.calloutLimit", { type: "number", key: "snippetCalloutLimit", min: 40 }),
      d("set.compactCollapsed", { type: "toggle", key: "compactDefaultCollapsed" }),
      d("set.blockPrecision", { type: "toggle", key: "blockPrecision" }),
      d("set.template", {
        type: "dropdown",
        key: "defaultTemplate",
        options: {
          A: t("template.A"),
          B: t("template.B"),
          C: t("template.C"),
          D: t("template.D"),
        },
      }),
      d("set.customTemplate", { type: "text", key: "customTemplate" }),
      d("set.dedupe", { type: "toggle", key: "dedupe" }),
      d("set.selection", {
        type: "dropdown",
        key: "selectionBehavior",
        options: { replace: t("opt.replace"), append: t("opt.append") },
      }),
      d("set.historyEnabled", { type: "toggle", key: "historyEnabled" }),
      d("set.historyLimit", { type: "number", key: "historyLimit", min: 10 }),
      d("set.virtualScroll", { type: "toggle", key: "virtualScroll" }),
      d("set.concurrency", { type: "number", key: "renderConcurrency", min: 1, max: 8 }),
      d("set.renderMode", {
        type: "dropdown",
        key: "renderMode",
        options: { block: t("opt.block"), whole: t("opt.whole") },
      }),
      d("set.cardWidth", {
        type: "dropdown",
        key: "cardWidth",
        options: {
          auto: t("opt.auto"),
          narrow: t("opt.narrow"),
          medium: t("opt.medium"),
          wide: t("opt.wide"),
        },
      }),
      d("set.fontScale", {
        type: "slider",
        key: "fontScale",
        min: 0.8,
        max: 1.6,
        step: 0.1,
      }),
      d("set.showDismissed", { type: "toggle", key: "showDismissed" }),
      d("set.debug", { type: "toggle", key: "debug" }),
      { name: t("set.snapshots"), render: (setting) => this.snapshotControls(setting.controlEl) },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!Object.hasOwn(this.plugin.settings, key)) return;
    const validated = validateSettings({ ...this.plugin.settings, [key]: value });
    if ((validated as unknown as Record<string, unknown>)[key] !== value) return;
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = (validated as unknown as Record<string, unknown>)[key];
    if (key === "language") {
      setLanguage(this.plugin.settings.language);
      this.plugin.relocalizeViews();
    }
    try { await this.plugin.persist(); } catch (error) { new Notice(t("data.saveFailed"), 0); throw error; }
    if (key === "language") this.update();
  }

  private description(key: string): string {
    const descriptions: Record<string, string> = { "set.blockPrecision": "set.anchorDesc", "set.dedupe": "set.dedupeDesc", "set.historyEnabled": "set.recordDesc", "set.pageSize": "set.pageSizeDesc" };
    return descriptions[key] ? t(descriptions[key]) : "";
  }
  openCitationManager(): void {
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      this.heading(modal.contentEl, "set.citation");
      this.addToggle(modal.contentEl, "set.blockPrecision", "blockPrecision");
      this.addToggle(modal.contentEl, "set.dedupe", "dedupe");
      this.addDropdown(modal.contentEl, "set.template", "defaultTemplate", [["A", t("template.A")], ["B", t("template.B")], ["C", t("template.C")], ["D", t("template.D")]]);
      this.addDropdown(modal.contentEl, "set.selection", "selectionBehavior", [["replace", t("opt.replace")], ["append", t("opt.append")]]);
      this.addText(modal.contentEl, "set.customTemplate", "customTemplate");
      this.addToggle(modal.contentEl, "set.historyEnabled", "historyEnabled");
      this.snapshotControls(modal.contentEl);
    };
    modal.open();
  }
  private snapshotControls(el: HTMLElement): void {
    const usage = this.plugin.history.usage;
    const group = el.createDiv();
    new Setting(group).setName(t("set.snapshots")).setDesc(t("set.snapshotUsage", { n: usage.count, size: `${(usage.bytes / 1024 / 1024).toFixed(2)} MiB` }))
      .addButton((button) => button.setButtonText(t("set.clearSnapshots")).onClick(async () => {
        const choice = await citationPrompt(this.app, t("set.clearSnapshotsConfirm"), [{ id: "clear", label: t("set.clearSnapshots") }]);
        if (!choice) return;
        try {
          await this.plugin.history.clearRelations();
          const parent = group.parentElement!;
          group.remove(); this.snapshotControls(parent);
        } catch { new Notice(t("data.saveFailed"), 0); }
      }));
  }
  private heading(el: HTMLElement, key: string): void {
    new Setting(el).setName(t(key)).setHeading();
  }

  private addToggle(
    el: HTMLElement,
    nameKey: string,
    key:
      | "includeSubfolders"
      | "snippetIncludeHighlights"
      | "snippetIncludeCallouts"
      | "compactDefaultCollapsed"
      | "blockPrecision"
      | "dedupe"
      | "historyEnabled"
      | "virtualScroll"
      | "showDismissed"
      | "debug"
  ): void {
    new Setting(el).setName(t(nameKey)).setDesc(this.description(nameKey)).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        await this.setControlValue(key, value);
      })
    );
  }

  private addText(el: HTMLElement, nameKey: string, key: "excludeGlobs" | "customTemplate"): void {
    new Setting(el).setName(t(nameKey)).addText((text) =>
      text.setValue(this.plugin.settings[key]).onChange(async (value) => {
        await this.setControlValue(key, value);
      })
    );
  }

  private addDropdown(
    el: HTMLElement,
    nameKey: string,
    key: "defaultDensity" | "defaultPlacement" | "defaultTemplate" | "selectionBehavior" | "renderMode" | "cardWidth",
    options: Array<[string, string]>
  ): void {
    new Setting(el).setName(t(nameKey)).addDropdown((dd) => {
      for (const [value, label] of options) dd.addOption(value, label);
      dd.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
        await this.setControlValue(key, value);
      });
    });
  }
}
