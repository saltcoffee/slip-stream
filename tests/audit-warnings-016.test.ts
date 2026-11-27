// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import { SlipStreamSettingsTab } from "../src/settings/SettingsTab";
import { DeskManageModal, DeskSelector } from "../src/view/DeskSelector";
import type { DeskSelectorHost } from "../src/view/DeskSelector";
import { createDesk } from "../src/domain/deskTypes";
import { setLanguage, t } from "../src/util/i18n";
import { installObsidianDom } from "./support/dom";
import { Notice, SuggestModal } from "./support/obsidian";

installObsidianDom();

afterEach(() => {
  setLanguage("auto");
  document.body.replaceChildren();
  Notice.messages.length = 0;
});

function deskHost(overrides: Partial<DeskSelectorHost> = {}): DeskSelectorHost {
  const desk = createDesk({ id: "desk-1", name: "Research", targetPath: "Draft.md" });
  return {
    app: {} as never,
    currentDesk: () => undefined,
    desks: () => [desk],
    recentDesks: () => [desk],
    isDirty: () => false,
    openDesk: vi.fn(async () => {}),
    createDesk: vi.fn(async () => "ok"),
    renameDesk: vi.fn(async () => "ok"),
    deleteDesk: vi.fn(async () => {}),
    markdownPaths: () => ["Draft.md"],
    suggestedTarget: () => "Draft.md",
    suggestedName: () => "Research",
    ...overrides,
  };
}

describe("16-04 audit and CSS fixes", () => {
  it("handles DeskSelectorHost.openDesk completion and rejection in list and manage modals", async () => {
    const openDesk = vi.fn(async () => {});
    const selector = new DeskSelector(deskHost({ openDesk }));
    selector.openList();
    SuggestModal.last.onChooseSuggestion(createDesk({ id: "desk-1", name: "Research", targetPath: "Draft.md" }), new MouseEvent("click"));
    await vi.waitFor(() => expect(openDesk).toHaveBeenCalledWith("desk-1"));
    SuggestModal.last.close();

    const failingOpen = vi.fn(async () => { throw new Error("boom"); });
    const failingSelector = new DeskSelector(deskHost({ openDesk: failingOpen }));
    failingSelector.openList();
    SuggestModal.last.onChooseSuggestion(createDesk({ id: "desk-1", name: "Research", targetPath: "Draft.md" }), new MouseEvent("click"));
    await vi.waitFor(() => expect(Notice.messages).toContain(t("state.error")));
    SuggestModal.last.close();

    Notice.messages.length = 0;
    const manageOk = new DeskManageModal(deskHost({ openDesk }));
    const closeOk = vi.spyOn(manageOk, "close");
    manageOk.open();
    manageOk.contentEl.querySelector<HTMLButtonElement>(".slipstream-desk-manage-row button")!.click();
    await vi.waitFor(() => expect(closeOk).toHaveBeenCalledOnce());

    const manageFail = new DeskManageModal(deskHost({ openDesk: failingOpen }));
    const closeFail = vi.spyOn(manageFail, "close");
    manageFail.open();
    manageFail.contentEl.querySelector<HTMLButtonElement>(".slipstream-desk-manage-row button")!.click();
    await vi.waitFor(() => expect(Notice.messages).toContain(t("state.error")));
    expect(closeFail).not.toHaveBeenCalled();
    manageFail.close();
  });

  it("uses declarative settings definitions without deprecated display() and refreshes via update() on language change", async () => {
    const plugin = {
      settings: { ...DEFAULT_SETTINGS },
      persist: vi.fn(async () => {}),
      relocalizeViews: vi.fn(),
      history: { usage: { count: 0, bytes: 0 }, clearRelations: vi.fn(async () => {}) },
    };
    const tab = new SlipStreamSettingsTab({} as never, plugin as never);
    expect(Object.hasOwn(SlipStreamSettingsTab.prototype, "display")).toBe(false);
    const definitions = tab.getSettingDefinitions();
    expect(definitions.length).toBeGreaterThan(20);
    expect(tab.getControlValue("language")).toBe("auto");

    const updateSpy = vi.fn();
    tab.update = updateSpy;
    await tab.setControlValue("language", "zh");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(plugin.relocalizeViews).toHaveBeenCalledTimes(1);
    expect(tab.getSettingDefinitions().find((item) => item.name === "界面语言")).toBeTruthy();

    await tab.setControlValue("language", "en");
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(tab.getSettingDefinitions().find((item) => item.name === "Language")).toBeTruthy();
  });

  it("hides SlipStream controls with .is-hidden without !important and unhides when removed", () => {
    const css = readFileSync(resolve(process.cwd(), "styles.css"), "utf8");
    expect(css).not.toContain("!important");

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.className = "slipstream-root";
    const deskbar = document.createElement("div");
    deskbar.className = "slipstream-deskbar";
    const saveBtn = document.createElement("button");
    saveBtn.className = "slipstream-btn is-hidden";
    deskbar.appendChild(saveBtn);
    const focusBar = document.createElement("div");
    focusBar.className = "slipstream-focusbar is-hidden";
    const stream = document.createElement("div");
    stream.className = "slipstream-stream is-hidden";
    const focusResults = document.createElement("div");
    focusResults.className = "slipstream-focus-results-wrap is-hidden";
    const section = document.createElement("div");
    section.className = "slipstream-focus-section is-hidden";
    focusResults.appendChild(section);
    root.append(deskbar, focusBar, stream, focusResults);
    document.body.appendChild(root);

    expect(getComputedStyle(saveBtn).display).toBe("none");
    expect(getComputedStyle(focusBar).display).toBe("none");
    expect(getComputedStyle(stream).display).toBe("none");
    expect(getComputedStyle(focusResults).display).toBe("none");
    expect(getComputedStyle(section).display).toBe("none");

    saveBtn.classList.remove("is-hidden");
    focusBar.classList.remove("is-hidden");
    expect(getComputedStyle(saveBtn).display).not.toBe("none");
    expect(getComputedStyle(focusBar).display).toBe("flex");
  });
});
