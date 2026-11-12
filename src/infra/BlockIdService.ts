import type { App } from "obsidian";
import { TFile } from "obsidian";

function randomBase36(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** 原子写 Block ID（Vault.process），带 Frontmatter / 类型 / 冲突防护。 */
export class BlockIdService {
  constructor(private app: App, private onWritten?: (filePath: string) => void) {}

  async ensure(
    filePath: string,
    startLine: number,
    endLine: number,
    expected?: string
  ): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return undefined;

    const cache = this.app.metadataCache.getFileCache(file);
    const fmEnd = cache?.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;
    if (startLine < fmEnd) return undefined; // Frontmatter 保护

    let result: string | undefined;
    let stale = false;

    await this.app.vault.process(file, (data) => {
      const lines = data.split("\n");
      if (expected != null && lines.slice(startLine, endLine).join("\n") !== expected) {
        stale = true;
        return data;
      }

      let anchor = endLine - 1;
      while (anchor > startLine && (lines[anchor] ?? "").trim() === "") anchor--;
      if (!lines[anchor]) return data;

      const existing = lines[anchor].match(/\s\^([A-Za-z0-9-]{4,})\s*$/);
      if (existing) {
        result = existing[1];
        return data;
      }

      const id = this.uniqueId(data);
      lines[anchor] = lines[anchor].replace(/\s+$/, "") + ` ^${id}`;
      result = id;
      return lines.join("\n");
    });

    if (stale) return undefined;
    if (result) this.onWritten?.(filePath);
    return result;
  }

  private uniqueId(source: string): string {
    const used = new Set(
      (source.match(/\^([A-Za-z0-9-]{4,})/g) ?? []).map((s) => s.slice(1))
    );
    let id: string;
    do {
      id = randomBase36(6);
    } while (used.has(id));
    return id;
  }
}
