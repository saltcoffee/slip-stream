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
export class SuggestModal<T> {}
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
