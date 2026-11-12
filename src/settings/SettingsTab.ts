import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingControl, SettingDefinition } from "obsidian";
import type SlipStreamPlugin from "../main";
import { t, setLanguage } from "../util/i18n";

export class SlipStreamSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SlipStreamPlugin) {
    super(app, plugin);
  }

  /** Declarative settings (Obsidian 1.13+): enables settings search. */
  getSettingDefinitions(): SettingDefinition[] {
    const d = (nameKey: string, control: SettingControl): SettingDefinition => ({
      name: t(nameKey),
      control,
    });
    return [
      d("set.language", {
        type: "dropdown",
        key: "language",
        options: {
          auto: t("opt.followObsidian"),
          zh: "中文",
          en: "English",
        },
      }),
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
      d("set.limit", { type: "number", key: "collectionLimit", min: 1 }),
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
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    if (key === "language") {
      setLanguage(this.plugin.settings.language);
      this.plugin.relocalizeViews();
    }
    await this.plugin.persist();
  }

  /** Imperative settings for Obsidian < 1.13 (declarative API not available). */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.heading(containerEl, "set.general");
    this.addLanguage(containerEl);
    this.addDropdown(containerEl, "set.density", "defaultDensity", [
      ["full", t("tb.full")],
      ["snippet", t("tb.snippet")],
      ["compact", t("tb.compact")],
    ]);
    this.addDropdown(containerEl, "set.placement", "defaultPlacement", [
      ["right-sidebar", t("opt.right")],
      ["split", t("opt.split")],
    ]);

    this.heading(containerEl, "set.sources");
    this.addToggle(containerEl, "set.includeSub", "includeSubfolders");
    this.addText(containerEl, "set.exclude", "excludeGlobs");
    this.addNumber(containerEl, "set.limit", "collectionLimit");

    this.heading(containerEl, "set.card");
    this.addNumber(containerEl, "set.excerpt", "excerptLength");
    this.addToggle(containerEl, "set.includeHighlights", "snippetIncludeHighlights");
    this.addToggle(containerEl, "set.includeCallouts", "snippetIncludeCallouts");
    this.addNumber(containerEl, "set.calloutLimit", "snippetCalloutLimit");
    this.addToggle(containerEl, "set.compactCollapsed", "compactDefaultCollapsed");

    this.heading(containerEl, "set.citation");
    this.addToggle(containerEl, "set.blockPrecision", "blockPrecision");
    this.addDropdown(containerEl, "set.template", "defaultTemplate", [
      ["A", t("template.A")],
      ["B", t("template.B")],
      ["C", t("template.C")],
      ["D", t("template.D")],
    ]);
    this.addText(containerEl, "set.customTemplate", "customTemplate");
    this.addToggle(containerEl, "set.dedupe", "dedupe");
    this.addDropdown(containerEl, "set.selection", "selectionBehavior", [
      ["replace", t("opt.replace")],
      ["append", t("opt.append")],
    ]);
    this.addToggle(containerEl, "set.historyEnabled", "historyEnabled");
    this.addNumber(containerEl, "set.historyLimit", "historyLimit");

    this.heading(containerEl, "set.performance");
    this.addToggle(containerEl, "set.virtualScroll", "virtualScroll");
    this.addNumber(containerEl, "set.concurrency", "renderConcurrency");
    this.addDropdown(containerEl, "set.renderMode", "renderMode", [
      ["block", t("opt.block")],
      ["whole", t("opt.whole")],
    ]);

    this.heading(containerEl, "set.appearance");
    this.addDropdown(containerEl, "set.cardWidth", "cardWidth", [
      ["auto", t("opt.auto")],
      ["narrow", t("opt.narrow")],
      ["medium", t("opt.medium")],
      ["wide", t("opt.wide")],
    ]);
    this.addSlider(containerEl, "set.fontScale", "fontScale");

    this.heading(containerEl, "set.advanced");
    this.addToggle(containerEl, "set.showDismissed", "showDismissed");
    this.addToggle(containerEl, "set.debug", "debug");
  }

  private heading(el: HTMLElement, key: string): void {
    new Setting(el).setName(t(key)).setHeading();
  }

  private addLanguage(el: HTMLElement): void {
    new Setting(el).setName(t("set.language")).addDropdown((dd) => {
      dd.addOption("auto", t("opt.followObsidian"));
      dd.addOption("zh", "中文");
      dd.addOption("en", "English");
      dd.setValue(this.plugin.settings.language).onChange(async (value) => {
        this.plugin.settings.language = value as "auto" | "zh" | "en";
        setLanguage(this.plugin.settings.language);
        await this.plugin.persist();
        this.plugin.relocalizeViews();
        this.display();
      });
    });
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
    new Setting(el).setName(t(nameKey)).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.persist();
      })
    );
  }

  private addText(el: HTMLElement, nameKey: string, key: "excludeGlobs" | "customTemplate"): void {
    new Setting(el).setName(t(nameKey)).addText((text) =>
      text.setValue(this.plugin.settings[key]).onChange(async (value) => {
        this.plugin.settings[key] = value;
        await this.plugin.persist();
      })
    );
  }

  private addNumber(
    el: HTMLElement,
    nameKey: string,
    key: "collectionLimit" | "excerptLength" | "snippetCalloutLimit" | "historyLimit" | "renderConcurrency"
  ): void {
    new Setting(el).setName(t(nameKey)).addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) {
          this.plugin.settings[key] = n;
          await this.plugin.persist();
        }
      });
    });
  }

  private addSlider(el: HTMLElement, nameKey: string, key: "fontScale"): void {
    new Setting(el).setName(t(nameKey)).addSlider((slider) =>
      slider
        .setLimits(0.8, 1.6, 0.1)
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.persist();
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
        (this.plugin.settings as unknown as Record<string, string>)[key] = value;
        await this.plugin.persist();
      });
    });
  }
}
