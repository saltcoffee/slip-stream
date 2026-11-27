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
import { DeskService } from "./domain/DeskService";
import { OutlineService } from "./domain/OutlineService";
import { EvidenceResolver } from "./domain/EvidenceResolver";
import { CollectionService } from "./domain/CollectionService";
import { SearchDocumentReader } from "./infra/SearchDocumentReader";
import { FocusSearch } from "./domain/FocusSearch";
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
  desks!: DeskService;
  outline!: OutlineService;
  evidence!: EvidenceResolver;
  collections!: CollectionService;
  searchReader!: SearchDocumentReader;
  focusSearch!: FocusSearch;
  logger!: Logger;

  citationBusy = 0;
  templateRevision = 0;
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
    this.searchReader = new SearchDocumentReader(this.editors);
    this.focusSearch = new FocusSearch(this.searchReader);
    this.desks = new DeskService(this.store);
    this.outline = new OutlineService(this.desks, this.store);
    this.collections = new CollectionService({ app: this.app, gateway: this.gateway,
      fileRef: (file) => this.editors.fileRef(file),
      globalExcludeGlobs: () => this.settings.excludeGlobs.split(",").map((glob) => glob.trim()).filter(Boolean) });
    this.editors.onContentChanged((ref) => { this.searchReader.invalidate(ref); this.scheduleRefresh(); });
    this.blockIds = new BlockIdService(this.app, this.editors, () => this.scheduleRefresh());
    this.evidence = new EvidenceResolver({
      resolveRef: (path) => {
        const abstract = this.app.vault.getAbstractFileByPath(path);
        return abstract instanceof TFile && abstract.extension === "md" ? this.editors.fileRef(abstract) : undefined;
      },
      read: (fileRef, signal) => this.searchReader.read(fileRef, signal),
      capture: (fileRef, text) => this.blockIds.capture(this.editors.file(fileRef), text),
    });
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
    this.templateRevision++;
    this.history?.settingsChanged();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)) (leaf.view as SlipStreamView).refreshCitationContext();
    await this.store.save();
  }

  async activateView(source?: SourceSpec): Promise<void> {
    const { workspace } = this.app;
    // 打开单一来源进入临时浏览：另开视图，绝不覆盖当前命名书桌的来源。
    if (source) {
      const leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_SLIPSTREAM, active: true, state: { source } });
      void workspace.revealLeaf(leaf);
      return;
    }
    const existing = workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM)[0];
    const leaf = existing ??
      (this.settings.defaultPlacement === "split"
        ? workspace.getLeaf("split", "vertical")
        : workspace.getRightLeaf(true) ?? workspace.getLeaf("tab"));
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_SLIPSTREAM, active: true, state: {} });
    void workspace.revealLeaf(leaf);
  }

  openHistory(): void {
    new HistoryModal(this).open();
  }

  openCitationSettings(): void {
    new SlipStreamSettingsTab(this.app, this).openCitationManager();
  }

  private activeView(): SlipStreamView | undefined {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM);
    const active = this.app.workspace.activeLeaf;
    const current = leaves.find((leaf) => leaf.view === active?.view);
    if (current) return current.view as SlipStreamView;
    // 多视图且活动视图不是 SlipStream 时不猜测目标，避免改错书桌。
    return leaves.length === 1 ? leaves[0].view as SlipStreamView : undefined;
  }

  private async ensureView(): Promise<SlipStreamView | undefined> {
    if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM).length) {
      await this.activateView();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    return this.activeView();
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
      // 目标命令只作用于明确的活动视图，绝不广播修改所有书桌目标。
      const view = this.activeView();
      if (view) { view.bindTarget(editorId); return; }
      if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM).length) {
        void this.activateView().then(() => this.activeView()?.bindTarget(editorId));
        return;
      }
      new Notice(t("error.TARGET_DESK_AMBIGUOUS"));
    } });
    addCommand({ id: "open", name: t("cmd.open"), callback: () => void this.activateView() });

    addCommand({ id: "save-desk", name: t("cmd.saveDesk"), callback: () => { void this.ensureView().then((view) => view?.openCreateDeskForm()); } });
    addCommand({ id: "open-desk", name: t("cmd.openDesk"), callback: () => { void this.ensureView().then((view) => view?.openDeskSelector()); } });
    addCommand({ id: "find-in-desk", name: t("cmd.findInDesk"), callback: () => { void this.ensureView().then((view) => view?.focusSearchInput()); } });
    addCommand({ id: "next-hit", name: t("cmd.nextHit"), callback: () => { this.activeView()?.moveFocus(1); } });
    addCommand({ id: "prev-hit", name: t("cmd.prevHit"), callback: () => { this.activeView()?.moveFocus(-1); } });

    addCommand({
      id: "open-folder",
      name: t("cmd.openFolder"),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file?.parent) return false;
        if (!checking) {
          void this.activateView({ kind: "folder", value: file.parent.path,
            options: { includeSubfolders: this.settings.includeSubfolders } });
        }
        return true;
      },
    });

    const linkCommand = (id: string, name: string, kind: "backlinks" | "outlinks") => {
      addCommand({ id, name, checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.activateView({ kind, value: file.path, anchorFile: file.path });
        return true;
      } });
    };
    linkCommand("open-backlinks", t("cmd.openBacklinks"), "backlinks");
    linkCommand("open-outlinks", t("cmd.openOutlinks"), "outlinks");

    addCommand({ id: "history", name: t("cmd.history"), callback: () => this.openHistory() });
    const runOnTargetView = (action: (view: SlipStreamView) => void, allowCreate = true) => {
      const view = this.activeView();
      if (view) { action(view); return; }
      if (allowCreate && !this.app.workspace.getLeavesOfType(VIEW_TYPE_SLIPSTREAM).length) {
        void this.ensureView().then((created) => { if (created) action(created); });
        return;
      }
      new Notice(t("error.TARGET_DESK_AMBIGUOUS"));
    };
    addCommand({ id: "open-outline", name: t("cmd.openOutline"), callback: () => runOnTargetView((view) => view.openOutline()) });
    addCommand({ id: "collect-to-outline", name: t("cmd.collectToOutline"), callback: () => runOnTargetView((view) => view.collectActiveToOutline(), false) });
    addCommand({ id: "new-outline-group", name: t("cmd.newOutlineGroup"), callback: () => runOnTargetView((view) => view.openNewOutlineGroup()) });
    addCommand({ id: "preview-outline", name: t("cmd.previewOutline"), callback: () => runOnTargetView((view) => view.previewOutline()) });
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
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      this.searchReader.invalidate(this.editors.fileRef(file));
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      this.searchReader.invalidate(this.editors.fileRef(file));
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.searchReader.invalidatePath(file.path);
      void this.desks.markSourceDeleted(file.path, !(file instanceof TFile));
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      const isFolder = !(file instanceof TFile);
      this.searchReader.invalidatePath(oldPath);
      void this.handleRename(oldPath, file.path, isFolder);
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.metadataCache.on("changed", () => { this.scheduleRefresh(); }));
  }

  /** 真实改名：精确文件或目录前缀边界更新书桌、历史与关系快照的路径提示。 */
  private async handleRename(oldPath: string, newPath: string, isFolder: boolean): Promise<void> {
    const map = (path: string): string => {
      if (path === oldPath) return newPath;
      if (isFolder && path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
      return path;
    };
    let changed = false;
    for (const entry of this.store.data.history) {
      if (typeof entry.sourcePath === "string") { const value = map(entry.sourcePath); if (value !== entry.sourcePath) { entry.sourcePath = value; changed = true; } }
      if (typeof entry.targetPath === "string") { const value = map(entry.targetPath); if (value !== entry.targetPath) { entry.targetPath = value; changed = true; } }
    }
    for (const relation of this.store.data.relations) {
      const sourcePath = map(relation.sourcePath);
      const targetPath = map(relation.targetPath);
      if (sourcePath !== relation.sourcePath) { relation.sourcePath = sourcePath; changed = true; }
      if (targetPath !== relation.targetPath) { relation.targetPath = targetPath; changed = true; }
    }
    await this.desks.renamePaths(oldPath, newPath, isFolder);
    if (changed) { this.store.touch(); try { await this.store.save(); } catch { /* 保留内存修改，下次保存重试 */ } }
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
