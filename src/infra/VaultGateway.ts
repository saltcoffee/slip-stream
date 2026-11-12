import type { App, CachedMetadata, TFile } from "obsidian";

/**
 * 封装 vault / metadataCache 读取，隔离原生 API（见开发文档 §3 依赖规则）。
 */
export class VaultGateway {
  constructor(public readonly app: App) {}

  getMarkdownFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.app.metadataCache.getFileCache(file);
  }

  async read(file: TFile): Promise<string> {
    return this.app.vault.cachedRead(file);
  }

  getAbstractFileByPath(path: string): unknown {
    return this.app.vault.getAbstractFileByPath(path);
  }

  getFirstLinkpathDest(link: string, sourcePath: string): TFile | null {
    return this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
  }

  getResolvedLinks(): Record<string, Record<string, number>> {
    return this.app.metadataCache.resolvedLinks;
  }
}
