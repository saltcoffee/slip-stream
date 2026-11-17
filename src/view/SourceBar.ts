import { App, Menu, Notice, SuggestModal, TFile, TFolder } from "obsidian";
import type { DeskRule } from "../domain/deskTypes";
import { t } from "../util/i18n";

export interface SourceBarHost {
  readonly app: App;
  getRules(): DeskRule[];
  getManualPaths(): string[];
  addRule(spec: DeskRule["spec"]): void;
  removeRule(id: string): void;
  addManual(path: string): void;
  removeManual(path: string): void;
  defaultFolder(): string;
  activeFilePath(): string | null;
}

/** 来源组合编辑：文件夹／标签／入链／出链／手动笔记，可多条并显示实际范围。 */
export class SourceBar {
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor(private host: SourceBarHost) {
    this.el = createDiv({ cls: "slipstream-sourcebar" });
    this.el.createSpan({ cls: "slipstream-sourcebar-title", text: t("src.title") });
    this.list = this.el.createDiv({ cls: "slipstream-source-chips" });
    const add = this.el.createEl("button", { cls: "slipstream-btn", text: t("src.add") });
    add.addEventListener("click", (event) => this.openMenu(event));
    this.update();
  }

  update(): void {
    this.list.empty();
    const rules = this.host.getRules();
    const manual = this.host.getManualPaths();
    if (!rules.length && !manual.length) {
      this.list.createSpan({ cls: "slipstream-source-empty", text: t("src.noRules") });
      return;
    }
    for (const rule of rules) {
      const chip = this.list.createSpan({ cls: "slipstream-source-chip" });
      chip.createSpan({ text: `${t(`sb.${rule.spec.kind}`)} · ${rule.spec.value || "—"}` });
      const remove = chip.createEl("button", { cls: "slipstream-chip-remove", text: "✕", attr: { "aria-label": t("src.remove") } });
      remove.addEventListener("click", () => { this.host.removeRule(rule.id); this.update(); });
    }
    for (const path of manual) {
      const chip = this.list.createSpan({ cls: "slipstream-source-chip is-manual" });
      chip.createSpan({ text: `${t("src.manualTag")} · ${path}` });
      const remove = chip.createEl("button", { cls: "slipstream-chip-remove", text: "✕", attr: { "aria-label": t("src.remove") } });
      remove.addEventListener("click", () => { this.host.removeManual(path); this.update(); });
    }
  }

  private openMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(t("src.addFolder")).setIcon("folder").onClick(() => this.chooseFolder()));
    menu.addItem((item) => item.setTitle(t("src.addTag")).setIcon("tag").onClick(() => this.chooseTag()));
    menu.addItem((item) => item.setTitle(t("src.addBacklinks")).setIcon("links-going-out").onClick(() => this.chooseLink("backlinks")));
    menu.addItem((item) => item.setTitle(t("src.addOutlinks")).setIcon("links-coming-in").onClick(() => this.chooseLink("outlinks")));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(t("src.addManual")).setIcon("file-plus").onClick(() => this.chooseManual()));
    menu.showAtMouseEvent(event);
  }

  private chooseFolder(): void {
    new FolderSuggestModal(this.host.app, (path) => {
      this.host.addRule({ kind: "folder", value: path, options: { includeSubfolders: true } });
      this.update();
    }, this.host.defaultFolder()).open();
  }

  private chooseTag(): void {
    new TagSuggestModal(this.host.app, (tag) => {
      this.host.addRule({ kind: "tag", value: tag, options: { matchChildren: true } });
      this.update();
    }).open();
  }

  private chooseLink(kind: "backlinks" | "outlinks"): void {
    const active = this.host.activeFilePath();
    if (!active) { new Notice(t("src.needAnchor")); return; }
    this.host.addRule({ kind, value: active, anchorFile: active });
    this.update();
  }

  private chooseManual(): void {
    new FileSuggestModal(this.host.app, (path) => { this.host.addManual(path); this.update(); }).open();
  }
}

class FolderSuggestModal extends SuggestModal<TFolder> {
  constructor(app: App, private onChoose: (path: string) => void, private defaultValue: string) {
    super(app);
    this.setPlaceholder(t("sb.promptFolder"));
    this.inputEl.value = defaultValue;
  }
  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder)
      .filter((folder) => folder.path.toLowerCase().includes(q)).slice(0, 100);
  }
  renderSuggestion(folder: TFolder, el: HTMLElement): void { el.setText(folder.path); }
  onChooseSuggestion(folder: TFolder): void { this.onChoose(folder.path); }
}

class TagSuggestModal extends SuggestModal<string> {
  private tags: string[];
  constructor(app: App, private onChoose: (tag: string) => void) {
    super(app);
    this.setPlaceholder(t("sb.promptTag"));
    this.tags = collectTags(app);
  }
  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.tags.filter((tag) => tag.toLowerCase().includes(q)).slice(0, 100);
  }
  renderSuggestion(tag: string, el: HTMLElement): void { el.setText(tag); }
  onChooseSuggestion(tag: string): void { this.onChoose(tag); }
}

class FileSuggestModal extends SuggestModal<TFile> {
  constructor(app: App, private onChoose: (path: string) => void) { super(app); this.setPlaceholder(t("src.promptManual")); }
  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    return this.app.vault.getMarkdownFiles().filter((file) => file.path.toLowerCase().includes(q)).slice(0, 100);
  }
  renderSuggestion(file: TFile, el: HTMLElement): void { el.setText(file.path); }
  onChooseSuggestion(file: TFile): void { this.onChoose(file.path); }
}

function collectTags(app: App): string[] {
  const set = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    for (const tag of cache?.tags ?? []) set.add(tag.tag);
    const fm: unknown = cache?.frontmatter?.tags;
    if (typeof fm === "string") set.add("#" + fm.replace(/^#/, ""));
    else if (Array.isArray(fm)) for (const value of fm) if (typeof value === "string") set.add("#" + value.replace(/^#/, ""));
  }
  return Array.from(set).sort();
}
