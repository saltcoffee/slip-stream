import {
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  TFile,
  TFolder,
  setTooltip,
} from "obsidian";
import { VIEW_TYPE_SLIPSTREAM } from "./constants";
import type { Command } from "obsidian";
import type { Settings } from "./settings/settings";
import { SlipStreamSettingsTab } from "./settings/SettingsTab";
import { VaultGateway } from "./infra/VaultGateway";
import { MarkdownRenderService } from "./infra/MarkdownRenderService";
import { BlockIdService } from "./infra/BlockIdService";
import { CitationEngine } from "./domain/CitationEngine";
import { CitationRecordsService } from "./domain/CitationRecords";
import { PluginDataStore } from "./infra/PluginDataStore";
import { EditorGateway } from "./infra/EditorGateway";
import { CitationLinkService } from "./infra/CitationLinkService";
import { HistoryModal } from "./view/HistoryModal";
import type { CitationError, TargetTicket } from "./domain/citationTypes";
import type { SourceSpec } from "./domain/types";
import { SlipStreamView } from "./view/SlipStreamView";
import { Logger } from "./util/logger";
import { t, setLanguage } from "./util/i18n";

export default class SlipStreamPlugin extends Plugin {
  store!: PluginDataStore;
  declare settings: Settings;
  editors!: EditorGateway;
  gateway!: VaultGateway;
  renderService!: MarkdownRenderService;
  blockIds!: BlockIdService;
  cite!: CitationEngine;
  history!: CitationRecordsService;
  logger!: Logger;

  citationBusy = 0;
  readonly dragTokens = new Map<string, (ticket?: TargetTicket, error?: CitationError) => void>();

  private refreshTimer: number | null = null;
  private commandIds: string[] = [];
  private ribbon?: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = new Logger(() => this.settings.debug);
    this.gateway = new VaultGateway(this.app);
    this.renderService = new MarkdownRenderService(this.app);
    this.editors = new EditorGateway(this.app, () => this.settings.selectionBehavior, (token) => token ? this.dragTokens.has(token) : this.dragTokens.size > 0);
    this.blockIds = new BlockIdService(this.app, this.editors, () => this.scheduleRefresh());
    this.history = new CitationRecordsService(this.store);
    this.cite = new CitationEngine({ settings: () => this.settings,
      consentAccepted: () => this.store.blockIdConsentAccepted,
      anchorWritesEnabled: () => !this.store.readOnly,
      sources: this.blockIds, editors: this.editors, links: new CitationLinkService(this.app, this.editors), records: this.history });
    this.editors.onDrop = (token, ticket, error) => {
      const submit = this.dragTokens.get(token);
      this.dragTokens.delete(token);
      submit?.(ticket, error);
    };
    this.registerEditorExtension(this.editors.extension());

    this.registerView(VIEW_TYPE_SLIPSTREAM, (leaf) => new SlipStreamView(leaf, this));
    this.addSettingTab(new SlipStreamSettingsTab(this.app, this));
    this.ribbon = this.addRibbonIcon("layers", t("cmd.open"), () => void this.activateView());

    this.registerCommands();
    this.registerMenus();
    this.registerMetadataRefresh();
  }

  onunload(): void {
    this.dragTokens.clear();
    void this.store?.flush().catch(() => this.logger?.error("pending plugin data could not be saved"));
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.store = new PluginDataStore({ load: () => this.loadData(), save: (data) => this.saveData(data),
      backup: async (raw) => {
        const dir = this.manifest.dir;
        if (!dir) throw new Error("PLUGIN_DIRECTORY_UNAVAILABLE");
        await this.app.vault.adapter.write(`${dir}/data-backup-${Date.now()}-${crypto.randomUUID()}.json`, JSON.stringify(raw, null, 2));
      } });
    await this.store.load();
    this.settings = this.store.data.settings;
    setLanguage(this.settings.language);
    if (this.store.warning) new Notice(t(this.store.warning), 0);
  }

  /** 语言切换后重建所有打开的 SlipStream 视图文案 */
  relocalizeViews(): void {
    this.registerCommands();
    if (this.ribbon) setTooltip(this.ribbon, t("cmd.open"));
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) {
      (leaf.view as SlipStreamView).relocalize?.();
    }
  }

  async persist(): Promise<void> {
    this.history?.settingsChanged();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) (leaf.view as SlipStreamView).refreshCitationContext();
    await this.store.save();
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

  openCitationSettings(): void {
    new SlipStreamSettingsTab(this.app, this).openCitationManager();
  }

  private registerCommands(): void {
    for (const id of this.commandIds) this.removeCommand(id);
    this.commandIds = [];
    const addCommand = (command: Command) => {
      this.commandIds.push(command.id);
      this.addCommand(command);
    };
    addCommand({ id: "set-citation-target", name: t("cmd.setTarget"), editorCallback: (editor) => {
      const editorId = this.editors.editorId(editor);
      if (!editorId) { new Notice(t("error.TARGET_READONLY")); return; }
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) (leaf.view as SlipStreamView).bindTarget(editorId);
      if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM).length) {
        void this.activateView().then(() => {
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) (leaf.view as SlipStreamView).bindTarget(editorId);
        });
      }
    } });
    addCommand({
      id: "open",
      name: t("cmd.open"),
      callback: () => void this.activateView(),
    });

    addCommand({
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
      addCommand({
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

    addCommand({
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

  private registerMetadataRefresh(): void {
    const schedule = () => this.scheduleRefresh();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        schedule();
      })
    );
    this.registerEvent(this.app.vault.on("delete", () => schedule()));
    this.registerEvent(this.app.vault.on("rename", () => schedule()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        schedule();
      })
    );
  }

  /** 防抖刷新：静默期 250ms，避免逐文件变更时反复全量重算 */
  scheduleRefresh(): void {
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
