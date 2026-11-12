import {
  Editor,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  Setting,
  TFile,
  TFolder,
} from "obsidian";
import { DRAG_SENTINEL, MIME_SLIPSTREAM, VIEW_TYPE_SLIPSTREAM } from "./constants";
import { DEFAULT_SETTINGS } from "./settings/settings";
import type { Settings } from "./settings/settings";
import { SlipStreamSettingsTab } from "./settings/SettingsTab";
import { VaultGateway } from "./infra/VaultGateway";
import { MarkdownRenderService } from "./infra/MarkdownRenderService";
import { BlockIdService } from "./infra/BlockIdService";
import { CitationEngine } from "./domain/CitationEngine";
import { CitationHistoryService } from "./domain/CitationHistory";
import type { CitationRecord, DragPayload, SourceSpec } from "./domain/types";
import { SlipStreamView } from "./view/SlipStreamView";
import { Logger } from "./util/logger";
import { t, setLanguage } from "./util/i18n";

export default class SlipStreamPlugin extends Plugin {
  declare settings: Settings;
  gateway!: VaultGateway;
  renderService!: MarkdownRenderService;
  blockIds!: BlockIdService;
  cite!: CitationEngine;
  history!: CitationHistoryService;
  logger!: Logger;

  /** DragHandle 在 dragstart 时置真，用于 dragover 兜底 */
  isDragging = false;

  private rawData: unknown = undefined;
  private suppressed = new Map<string, number>();
  private refreshTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = new Logger(() => this.settings.debug);
    this.gateway = new VaultGateway(this.app);
    this.renderService = new MarkdownRenderService(this.app);
    this.blockIds = new BlockIdService(this.app, (path) => this.suppressOnce(path));
    this.cite = new CitationEngine(this);
    this.history = new CitationHistoryService(this.app, this);
    this.history.load((this.rawData as { history?: CitationRecord[] } | undefined)?.history);

    this.registerView(VIEW_TYPE_SLIPSTREAM, (leaf) => new SlipStreamView(leaf, this));
    this.addSettingTab(new SlipStreamSettingsTab(this.app, this));
    this.addRibbonIcon("layers", t("cmd.open"), () => void this.activateView());

    this.registerCommands();
    this.registerMenus();
    this.registerDropHandling();
    this.registerMetadataRefresh();
  }

  onunload(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.rawData = await this.loadData();
    const data = this.rawData as { settings?: Partial<Settings> } | undefined;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    setLanguage(this.settings.language);
  }

  /** 语言切换后重建所有打开的 SlipStream 视图文案 */
  relocalizeViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) {
      (leaf.view as SlipStreamView).relocalize?.();
    }
  }

  async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, history: this.history.serialize() });
  }

  async activateView(source?: SourceSpec): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)[0];
    const leaf =
      existing ??
      (this.settings.defaultPlacement === "split"
        ? workspace.getLeaf("split", "vertical")
        : workspace.getRightLeaf(true) ?? workspace.getLeaf("tab"));
    if (!existing || source) {
      await leaf.setViewState({
        type: VIEW_TYPE_SLIPSTREAM,
        active: true,
        state: { source },
      });
    }
    void workspace.revealLeaf(leaf);
  }

  openHistory(): void {
    new HistoryModal(this).open();
  }

  suppressOnce(path: string): void {
    this.suppressed.set(path, Date.now());
  }

  private isSuppressed(path: string): boolean {
    const ts = this.suppressed.get(path);
    if (ts === undefined) return false;
    if (Date.now() - ts > 2000) {
      this.suppressed.delete(path);
      return false;
    }
    return true;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open",
      name: t("cmd.open"),
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "open-folder",
      name: t("cmd.openFolder"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.parent) return false;
        if (!checking) {
          void this.activateView({
            kind: "folder",
            value: file.parent.path,
            options: { includeSubfolders: this.settings.includeSubfolders },
          });
        }
        return true;
      },
    });

    const linkCommand = (id: string, name: string, kind: "backlinks" | "outlinks") => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return false;
          if (!checking) {
            void this.activateView({ kind, value: file.path, anchorFile: file.path });
          }
          return true;
        },
      });
    };
    linkCommand("open-backlinks", t("cmd.openBacklinks"), "backlinks");
    linkCommand("open-outlinks", t("cmd.openOutlinks"), "outlinks");

    this.addCommand({
      id: "history",
      name: t("cmd.history"),
      callback: () => this.openHistory(),
    });
  }

  private registerMenus(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle(t("menu.openFolder"))
              .setIcon("layers")
              .onClick(() =>
                void this.activateView({
                  kind: "folder",
                  value: file.path,
                  options: { includeSubfolders: this.settings.includeSubfolders },
                })
              )
          );
        }
      })
    );

    this.registerEvent(
      (this.app.workspace.on as unknown as (
        name: string,
        cb: (menu: Menu, editor: Editor, view: MarkdownView) => void
      ) => { name: string })("editor-menu", (menu, _editor, view) => {
        const path = view.file?.path;
        if (!path) return;
        menu.addItem((item) =>
          item
            .setTitle(t("menu.viewRelated"))
            .setIcon("layers")
            .onClick(() =>
              void this.activateView({ kind: "backlinks", value: path, anchorFile: path })
            )
        );
      })
    );
  }

  private registerDropHandling(): void {
    this.registerDomEvent(
      document,
      "dragover",
      (e: DragEvent) => {
        if (e.dataTransfer?.types.includes(MIME_SLIPSTREAM) || this.isDragging) {
          e.preventDefault();
        }
      },
      { capture: true }
    );

    this.registerDomEvent(
      document,
      "drop",
      (e: DragEvent) => {
        if (!this.isDragging && !e.dataTransfer?.types.includes(MIME_SLIPSTREAM)) return;
        const payload = this.readPayload(e);
        if (!payload) return;
        const editor = this.resolveEditorForDrop(e.target as HTMLElement);
        if (!editor) {
          new Notice(t("notice.noEditor"));
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void this.cite.emit(payload, editor, e);
      },
      { capture: true }
    );

    this.registerDomEvent(
      document,
      "dragend",
      () => {
        this.isDragging = false;
      },
      { capture: true }
    );
  }

  private readPayload(e: DragEvent): DragPayload | null {
    const dt = e.dataTransfer;
    if (!dt) return null;
    let raw = dt.getData(MIME_SLIPSTREAM);
    if (!raw) {
      const plain = dt.getData("text/plain");
      if (plain.startsWith(DRAG_SENTINEL)) raw = plain.slice(DRAG_SENTINEL.length);
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  }

  private resolveEditorForDrop(target: HTMLElement): Editor | null {
    const cmEl = target.closest(".cm-editor");
    if (!cmEl) return null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.containerEl.contains(cmEl)) {
        return view.editor;
      }
    }
    return null;
  }

  private registerMetadataRefresh(): void {
    const schedule = () => this.scheduleRefresh();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (this.isSuppressed(file.path)) return;
        schedule();
      })
    );
    this.registerEvent(this.app.vault.on("delete", () => schedule()));
    this.registerEvent(this.app.vault.on("rename", () => schedule()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.isSuppressed(file.path)) return;
        schedule();
      })
    );
  }

  /** 防抖刷新：静默期 250ms，避免逐文件变更时反复全量重算 */
  private scheduleRefresh(): void {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM).length === 0) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) {
        (leaf.view as SlipStreamView).refreshFromExternal?.();
      }
    }, 250);
  }
}

class HistoryModal extends Modal {
  constructor(private plugin: SlipStreamPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("history.title")).setHeading();

    const list = contentEl.createDiv({ cls: "slipstream-history-list" });
    const records = this.plugin.history.list();
    if (records.length === 0) {
      list.createDiv({ cls: "slipstream-state", text: t("history.empty") });
    } else {
      for (const record of records) {
        const item = list.createDiv({ cls: "slipstream-history-item" });
        const main = item.createDiv({ cls: "slipstream-history-main" });
        main.createDiv({ cls: "slipstream-history-title", text: record.sourcePath });
        main.createDiv({ cls: "slipstream-history-snippet", text: record.snippet });

        const jump = item.createEl("button", { cls: "slipstream-btn", text: t("history.jump") });
        jump.addEventListener("click", () => {
          this.plugin.history.jumpBack(record);
          this.close();
        });

        if (record.targetPath) {
          const targetPath = record.targetPath;
          const open = item.createEl("button", {
            cls: "slipstream-btn",
            text: t("history.openTarget"),
          });
          open.addEventListener("click", () => {
            void this.plugin.app.workspace.openLinkText(targetPath, "", false);
            this.close();
          });
        }

        const recopy = item.createEl("button", {
          cls: "slipstream-btn",
          text: t("history.recopy"),
        });
        recopy.addEventListener("click", () => {
          void navigator.clipboard.writeText(record.text ?? record.snippet);
        });
      }
    }

    const clear = contentEl.createEl("button", { cls: "slipstream-btn", text: t("history.clear") });
    clear.addEventListener("click", () => {
      void this.plugin.history.clear().then(() => this.close());
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
