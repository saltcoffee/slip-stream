import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { RenderUnit } from "../domain/types";
import { inlineBlockId, stripInlineBlockId } from "../domain/BlockReference";

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
    expected: string,
    blockType: RenderUnit["type"]
  ): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md") return undefined;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 0 || endLine <= startLine) return undefined;
    if (typeof expected !== "string" || !["paragraph", "list_item", "list", "blockquote", "callout"].includes(blockType)) return undefined;

    const cache = this.app.metadataCache.getFileCache(file);
    const fmEnd = cache?.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;
    if (startLine < fmEnd) return undefined; // Frontmatter 保护

    let result: string | undefined;
    let written = false;

    await this.app.vault.process(file, (data) => {
      const newline = data.includes("\r\n") ? "\r\n" : "\n";
      const lines = data.split(/\r?\n/);
      if (endLine > lines.length) return data;
      const current = lines.slice(startLine, endLine).join("\n");
      const cachedId = Object.values(cache?.blocks ?? {}).find((block) =>
        block.position.start.line === startLine &&
        current.split("\n").some((line) => line.match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/)?.[1] === block.id)
      )?.id;
      const inline = inlineBlockId(current, blockType) ?? cachedId;
      if (stripInlineBlockId(current, blockType, inline) !== stripInlineBlockId(expected, blockType, inline)) return data;
      if (blockType === "list_item") {
        const item = lines[startLine].match(/^\s*(?:[-+*]|\d+[.)])(?:[ \t]+(.*))?$/);
        // 代码作为列表项首块时没有可写入行内标记的正文，安全降级为文件链接。
        if (!item?.[1]?.trim() || /^(?:`{3,}|~{3,})/.test(item[1])) return data;
      }

      let anchor = endLine - 1;
      while (anchor > startLine && (lines[anchor] ?? "").trim() === "") anchor--;
      if (!lines[anchor]) return data;

      let next = anchor + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      const standalone = next > anchor + 1 ? lines[next]?.match(/^\^([A-Za-z0-9-]+)\s*$/)?.[1] : undefined;
      const existing = inline ?? standalone;
      if (existing) {
        result = existing;
        return data;
      }

      const id = this.uniqueId(data);
      if (blockType === "paragraph" || blockType === "list_item") {
        const line = blockType === "list_item" ? startLine : anchor;
        lines[line] += ` ^${id}`;
      } else {
        // 结构块的标记独立于正文，避免修改 Callout/列表中的代码围栏。
        lines.splice(anchor + 1, 0, "", `^${id}`);
        if (lines[anchor + 3]?.trim() !== "") lines.splice(anchor + 3, 0, "");
      }
      result = id;
      written = true;
      return lines.join(newline);
    });

    if (written) this.onWritten?.(filePath);
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
