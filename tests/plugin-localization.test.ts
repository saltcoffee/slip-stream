// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "obsidian";
import SlipStreamPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { setLanguage, t } from "../src/util/i18n";
import { SlipStreamSettingsTab } from "../src/settings/SettingsTab";
import { TargetBar } from "../src/view/TargetBar";
import { SuggestModal } from "./support/obsidian";
import { HistoryModal } from "../src/view/HistoryModal";
import { installObsidianDom } from "./support/dom";

installObsidianDom();
afterEach(() => { setLanguage("auto"); document.body.replaceChildren(); });
describe("runtime localization", () => {
  it("updates registered command names after changing plugin language", () => {
    setLanguage("en");
    const plugin = new SlipStreamPlugin({} as never, {} as never);
    plugin.app = { workspace: { getLeavesOfType: () => [] } } as never;
    const commands = new Map<string, Command>();
    plugin.addCommand = vi.fn((command) => { commands.set(command.id, command); return command; });
    plugin.removeCommand = vi.fn((id) => { commands.delete(id); });
    (plugin as any).registerCommands();
    expect(commands.get("set-citation-target")?.name).toBe("Set current note as citation target");
    setLanguage("zh"); plugin.relocalizeViews();
    expect(commands.get("set-citation-target")?.name).toBe("将当前笔记设为引用目标");
    expect(commands.size).toBe(6);
    setLanguage("en"); plugin.relocalizeViews();
    expect(commands.get("set-citation-target")?.name).toBe("Set current note as citation target");
  });
  it.each(["en", "zh"] as const)("renders action, precision and timestamps in %s", (language) => {
    setLanguage(language);
    const at = new Date(2026, 10, 14, 15, 16, 17).valueOf();
    const modal = new HistoryModal({ settings: { ...DEFAULT_SETTINGS, language }, app: {}, history: { list: () => [{
      id: "op", operationId: "op", at, action: "copy", sourcePath: "Notes/来源.md", template: "A", snippet: "User text", precision: "file",
    }] } } as never);
    modal.onOpen();
    expect(modal.contentEl.textContent).toContain(t("history.copy"));
    expect(modal.contentEl.textContent).toContain(t("precision.file"));
    expect(modal.contentEl.textContent).toContain(new Date(at).toLocaleString(language === "zh" ? "zh-CN" : "en"));
  });
  it.each(["en", "zh"] as const)("uses plugin language for the target chooser's empty state in %s", (language) => {
    setLanguage(language);
    const bar = new TargetBar({} as never, { subscribe: () => () => {}, options: () => [] } as never,
      () => undefined, () => {}, () => false, () => {});
    bar.openChooser();
    expect(SuggestModal.last.emptyStateText).toBe(t("target.empty"));
    expect(SuggestModal.last.inputEl.placeholder).toBe(t("target.openFirst"));
    SuggestModal.last.close(); bar.destroy();
  });
  it("refreshes declarative setting labels after a language change", async () => {
    const plugin = { settings: { ...DEFAULT_SETTINGS }, persist: vi.fn(async () => {}), relocalizeViews: vi.fn() };
    const tab = new SlipStreamSettingsTab({} as never, plugin as never);
    tab.update = vi.fn();
    await tab.setControlValue("language", "zh");
    expect(tab.update).toHaveBeenCalledOnce();
    expect(tab.getSettingDefinitions().some((setting) => setting.name === "引用快照")).toBe(true);
    await tab.setControlValue("language", "en");
    expect(tab.getSettingDefinitions().some((setting) => setting.name === "Citation snapshots")).toBe(true);
    expect(plugin.relocalizeViews).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid setting values without replacing a valid preference", async () => {
    const plugin = { settings: { ...DEFAULT_SETTINGS, historyLimit: 50 }, persist: vi.fn(async () => {}), relocalizeViews: vi.fn() };
    const tab = new SlipStreamSettingsTab({} as never, plugin as never);
    await tab.setControlValue("historyLimit", 0);
    await tab.setControlValue("historyLimit", Infinity);
    await tab.setControlValue("language", "fr");
    expect(plugin.settings.historyLimit).toBe(50); expect(plugin.settings.language).toBe("auto");
    expect(plugin.persist).not.toHaveBeenCalled();
  });

});
