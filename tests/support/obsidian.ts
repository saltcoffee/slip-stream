import { StateField } from "@codemirror/state";
/** Minimal Obsidian runtime stub for unit tests. */
export class TFile {
  extension: string;
  basename: string;
  stat = { mtime: 0, ctime: 0 };
  parent: { path: string };

  constructor(public path = "note.md") {
    const name = path.split("/").pop() ?? path;
    this.extension = name.split(".").pop() ?? "";
    this.basename = name.slice(0, -(this.extension.length + 1));
    this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/" };
  }
}

export class TFolder {}
export class App {}
export class Menu {}
export class Component {
  load(): void {}
  unload(): void {}
}

export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
}

export function getLanguage(): string {
  return "en";
}

export const moment = {
  locale: (): string => "en",
};

export function getFrontMatterInfo(content: string) {
  const match = content.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  return { exists: !!match, contentStart: match?.[0].length ?? 0 };
}
export function parseLinktext(link: string) {
  const split = link.indexOf("#");
  return { path: split < 0 ? link : link.slice(0, split), subpath: split < 0 ? "" : link.slice(split) };
}
export function resolveSubpath(cache: any, subpath: string) {
  return subpath.startsWith("#^") ? cache.blocks?.[subpath.slice(2)] ?? null : cache.headings?.find((h: any) => h.heading === subpath.slice(1)) ?? null;
}
export class MarkdownView {
  mode = "source";
  constructor(public file: TFile, public editor: any, public containerEl: HTMLElement) {}
  getMode() { return this.mode; }
}
export class Modal {
  contentEl = document.createElement("div");
  constructor(public app: unknown) {}
  open() { document.body.appendChild(this.contentEl); this.onOpen(); }
  close() { this.onClose(); this.contentEl.remove(); }
  onOpen() {}
  onClose() {}
}

export const editorInfoField = StateField.define<any>({ create: () => null, update: (value) => value });

export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class Setting {
  constructor(private parent: HTMLElement) {}
  setName(name: string) { this.parent.createDiv({ text: name }); return this; }
  setHeading() { return this; }
}
export function setTooltip(element: HTMLElement, text: string) { element.setAttribute("aria-label", text); }

export class SuggestModal<T> extends Modal {
  static last: SuggestModal<unknown>;
  emptyStateText = "";
  inputEl = document.createElement("input");
  setPlaceholder(value: string) { this.inputEl.placeholder = value; }
  open() { SuggestModal.last = this; super.open(); }
}
