import type { Editor } from "obsidian";
import { Notice, TFile } from "obsidian";
import type { DragPayload } from "./types";
import type SlipStreamPlugin from "../main";
import { buildCitation, resolveTemplateId } from "./DropTemplate";
import { t } from "../util/i18n";

interface BuiltCitation {
  text: string;
  blockId?: string;
}

/** 拖拽引文落盘引擎：生成文本、插入编辑器 / 复制、写入历史。 */
export class CitationEngine {
  private recentlyCited = new Set<string>();

  constructor(private plugin: SlipStreamPlugin) {}

  get currentTemplateId(): string {
    return resolveTemplateId(this.plugin.settings);
  }

  async emit(payload: DragPayload, editor: Editor, evt: DragEvent): Promise<void> {
    const { text, blockId } = await this.build(payload);
    if (this.plugin.settings.dedupe && this.recentlyCited.has(text)) {
      new Notice(t("notice.duplicate"));
      return;
    }

    try {
      const cm = (editor as unknown as {
        cm?: { posAtCoords?: (p: { x: number; y: number }) => number | { line: number; ch: number } | null };
      }).cm;
      const pos = cm?.posAtCoords?.({ x: evt.clientX, y: evt.clientY });
      if (typeof pos === "number") {
        editor.setCursor(editor.offsetToPos(pos));
      } else if (pos && typeof pos.line === "number" && typeof pos.ch === "number") {
        editor.setCursor({ line: pos.line, ch: pos.ch });
      }
    } catch {
      // 内部 API 失败则使用当前光标
    }

    editor.replaceSelection(text);
    this.recentlyCited.add(text);
    await this.record(payload, blockId, text);
    new Notice(t("notice.inserted"));
  }

  async copy(payload: DragPayload): Promise<void> {
    const { text, blockId } = await this.build(payload);
    if (this.plugin.settings.dedupe && this.recentlyCited.has(text)) {
      new Notice(t("notice.duplicate"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 忽略剪贴板失败
    }
    this.recentlyCited.add(text);
    await this.record(payload, blockId, text);
    new Notice(t("notice.copied"));
  }

  private async build(payload: DragPayload): Promise<BuiltCitation> {
    let blockId: string | undefined;
    const allowed = ["paragraph", "list_item", "list", "blockquote", "callout"];
    const typeOk = !payload.blockType || allowed.includes(payload.blockType);
    if (this.plugin.settings.blockPrecision && typeOk) {
      // 划词模式内容与整块源码不一致，不做原文比对，直接锚定该块
      const expected = payload.mode === "block" ? payload.content : undefined;
      blockId = await this.plugin.blockIds.ensure(
        payload.filePath,
        payload.startLine,
        payload.endLine,
        expected
      );
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(payload.filePath);
    const filename = file instanceof TFile ? file.basename : payload.title;
    const text = buildCitation(this.plugin.settings, {
      content: payload.content,
      filename,
      path: payload.filePath,
      title: payload.title,
      blockId: blockId ?? "",
      heading: payload.heading ?? "",
      url: `obsidian://open?file=${encodeURIComponent(payload.filePath)}`,
      date: new Date().toISOString().slice(0, 10),
    });
    return { text, blockId };
  }

  private async record(payload: DragPayload, blockId: string | undefined, text: string): Promise<void> {
    await this.plugin.history.record({
      sourcePath: payload.filePath,
      blockId,
      heading: payload.heading,
      template: this.currentTemplateId,
      snippet: payload.content.slice(0, 120),
      text,
    });
  }
}
