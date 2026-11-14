import { App, Notice, SuggestModal, TFolder } from "obsidian";
import type { SourceSpec } from "../domain/types";
import { t } from "../util/i18n";

export interface SourceBarHost {
  readonly app: App;
  getSource(): SourceSpec | undefined;
  setSource(spec: SourceSpec): void;
  defaultFolder(): string;
  activeFilePath(): string | null;
}

interface SourceButton {
  el: HTMLElement;
  kind: SourceSpec["kind"];
}

/** 顶部数据源切换器：文件夹 / 标签 / 入链 / 出链。 */
export class SourceBar {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private buttons: SourceButton[] = [];

  constructor(private host: SourceBarHost) {
    this.el = createDiv({ cls: "slipstream-sourcebar" });
    this.titleEl = this.el.createSpan({ cls: "slipstream-sourcebar-title" });

    this.addButton("sb.folder", "folder", () => this.chooseFolder());
    this.addButton("sb.tag", "tag", () => this.chooseTag());
    this.addButton("sb.backlinks", "backlinks", () =>
      this.chooseLink("backlinks")
    );
    this.addButton("sb.outlinks", "outlinks", () =>
      this.chooseLink("outlinks")
    );

    this.update();
  }

  update(): void {
    const source = this.host.getSource();
    if (!source) {
      this.titleEl.setText(t("state.noSource"));
    } else {
      this.titleEl.setText(`${t(`sb.${source.kind}`)} · ${source.value || "—"}`);
    }
    for (const btn of this.buttons) {
      btn.el.toggleClass("is-active", !!source && source.kind === btn.kind);
    }
  }

  private addButton(labelKey: string, kind: SourceSpec["kind"], onClick: () => void): void {
    const btn = this.el.createEl("button", { cls: "slipstream-btn", text: t(labelKey) });
    btn.addEventListener("click", onClick);
    this.buttons.push({ el: btn, kind });
  }

  private chooseFolder(): void {
    new FolderSuggestModal(this.host.app, (path) => {
      this.host.setSource({
        kind: "folder",
        value: path,
        options: { includeSubfolders: true },
      });
      this.update();
    }, this.host.defaultFolder()).open();
  }

  private chooseTag(): void {
    new TagSuggestModal(this.host.app, (tag) => {
      this.host.setSource({ kind: "tag", value: tag, options: { matchChildren: true } });
      this.update();
    }).open();
  }

  private chooseLink(kind: "backlinks" | "outlinks"): void {
    const active = this.host.activeFilePath();
    if (!active) {
      new Notice(t("sb.needActive"));
      return;
    }
    this.host.setSource({ kind, value: active, anchorFile: active });
    this.update();
  }
}

class FolderSuggestModal extends SuggestModal<TFolder> {
  constructor(
    app: App,
    private onChoose: (path: string) => void,
    private defaultValue: string
  ) {
    super(app);
    this.setPlaceholder(t("sb.promptFolder"));
    this.inputEl.value = defaultValue;
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    return this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .filter((f) => f.path.toLowerCase().includes(q))
      .slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  onChooseSuggestion(folder: TFolder): void {
    this.onChoose(folder.path);
  }
}

class TagSuggestModal extends SuggestModal<string> {
  private tags: string[];

  constructor(app: App, private onChoose: (tag: string) => void) {
    super(app);
    this.setPlaceholder(t("sb.promptTag"));
    this.tags = this.collectTags(app);
  }

  private collectTags(app: App): string[] {
    const set = new Set<string>();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      for (const t of cache?.tags ?? []) set.add(t.tag);
      const fm: unknown = cache?.frontmatter?.tags;
      if (typeof fm === "string") set.add("#" + fm.replace(/^#/, ""));
      else if (Array.isArray(fm)) {
        for (const v of fm) if (typeof v === "string") set.add("#" + v.replace(/^#/, ""));
      }
    }
    return Array.from(set).sort();
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.tags.filter((tag) => tag.toLowerCase().includes(q)).slice(0, 100);
  }

  renderSuggestion(tag: string, el: HTMLElement): void {
    el.setText(tag);
  }

  onChooseSuggestion(tag: string): void {
    this.onChoose(tag);
  }
}
