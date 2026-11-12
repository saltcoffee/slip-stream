import type { App } from "obsidian";
import type { CitationRecord } from "./types";
import type SlipStreamPlugin from "../main";

function randomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** 引用历史：记录、查询、跳回原文、持久化（随 data.json）。 */
export class CitationHistoryService {
  private records: CitationRecord[] = [];

  constructor(private app: App, private plugin: SlipStreamPlugin) {}

  load(records: CitationRecord[] | undefined): void {
    this.records = Array.isArray(records) ? records : [];
  }

  serialize(): CitationRecord[] {
    return this.records;
  }

  async record(rec: Omit<CitationRecord, "id" | "at">): Promise<void> {
    if (!this.plugin.settings.historyEnabled) return;
    this.records.unshift({ ...rec, id: randomId(), at: Date.now() });
    this.records = this.records.slice(0, Math.max(1, this.plugin.settings.historyLimit));
    await this.plugin.persist();
  }

  list(filter = ""): CitationRecord[] {
    const f = filter.trim().toLowerCase();
    if (!f) return this.records.slice();
    return this.records.filter((r) =>
      `${r.snippet} ${r.sourcePath} ${r.heading ?? ""}`.toLowerCase().includes(f)
    );
  }

  jumpBack(rec: CitationRecord): void {
    const link = rec.blockId
      ? `${rec.sourcePath}#^${rec.blockId}`
      : rec.heading
      ? `${rec.sourcePath}#${rec.heading}`
      : rec.sourcePath;
    void this.app.workspace.openLinkText(link, "", false);
  }

  async clear(): Promise<void> {
    this.records = [];
    await this.plugin.persist();
  }
}
