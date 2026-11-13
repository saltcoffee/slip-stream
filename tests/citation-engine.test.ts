// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notice, TFile } from "./support/obsidian";
import { CitationEngine } from "../src/domain/CitationEngine";
import { BlockIdService } from "../src/infra/BlockIdService";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import type { CitationRecord, DragPayload } from "../src/domain/types";

function fixture(source = "Original paragraph", cache: unknown = null) {
  let data = source;
  const file = new TFile("Sources/Note.md");
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async (_file: TFile, update: (value: string) => string) => { data = update(data); },
    },
    metadataCache: { getFileCache: () => cache },
  };
  const record = vi.fn(async (_record: Omit<CitationRecord, "id" | "at">) => {});
  const settings = { ...DEFAULT_SETTINGS };
  const engine = new CitationEngine({
    app, settings, history: { record }, blockIds: new BlockIdService(app as never),
  } as never);
  const editor = { replaceSelection: vi.fn() };
  const payload: DragPayload = {
    filePath: file.path, title: "Note", startLine: 0, endLine: 1,
    content: source, sourceContent: source, mode: "block", blockType: "paragraph",
  };
  return { engine, editor, payload, record, settings, read: () => data };
}

beforeEach(() => { Notice.messages = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("CitationEngine", () => {
  it("does not anchor a stale selection to another paragraph", async () => {
    const f = fixture("New paragraph\n\nParagraph A\n\nParagraph B");
    const before = f.read();
    await f.engine.emit({
      ...f.payload, startLine: 2, endLine: 3, content: "B",
      sourceContent: "Paragraph B", mode: "selection",
    }, f.editor as never, {} as DragEvent);
    expect(f.read()).toBe(before);
    expect(f.editor.replaceSelection).toHaveBeenCalledWith(
      "> B\n> — [[Sources/Note.md|Note]]"
    );
    expect(f.record.mock.calls[0][0].blockId).toBeUndefined();
  });

  it("does not write a block ID for a selection with no source snapshot", async () => {
    const f = fixture();
    await f.engine.emit({ ...f.payload, mode: "selection", sourceContent: undefined }, f.editor as never, {} as DragEvent);
    expect(f.read()).toBe("Original paragraph");
    expect(f.editor.replaceSelection.mock.calls[0][0]).not.toContain("#^");
  });

  it("keeps repeat citations precise and deduplicates after the source refreshes", async () => {
    const f = fixture();
    await f.engine.emit(f.payload, f.editor as never, {} as DragEvent);
    const firstText = f.editor.replaceSelection.mock.calls[0][0];
    expect(firstText).toContain("[[Sources/Note.md#^");
    await f.engine.emit(f.payload, f.editor as never, {} as DragEvent);
    await f.engine.emit({ ...f.payload, content: f.read(), sourceContent: f.read() }, f.editor as never, {} as DragEvent);
    expect(f.editor.replaceSelection).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledTimes(1);
  });

  it("reports a clipboard failure without history or dedupe and allows retry", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard unavailable")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const f = fixture();
    await f.engine.copy(f.payload);
    expect(f.record).not.toHaveBeenCalled();
    expect(Notice.messages).toEqual(["Failed to copy citation. Try again."]);
    await f.engine.copy(f.payload);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(f.record).toHaveBeenCalledTimes(1);
    expect(Notice.messages.at(-1)).toBe("Citation copied");
    expect(writeText.mock.calls[1][0]).toBe(writeText.mock.calls[0][0]);
  });

  it("reuses a list's existing continuation ID without quoting the marker", async () => {
    const source = "- Parent\n\n  Continued ^oldref";
    const f = fixture(source, { blocks: { oldref: { id: "oldref", position: { start: { line: 0 } } } } });
    await f.engine.emit({ ...f.payload, endLine: 3, blockType: "list_item" }, f.editor as never, {} as DragEvent);
    expect(f.read()).toBe(source);
    expect(f.editor.replaceSelection).toHaveBeenCalledWith(
      "> - Parent\n\n  Continued\n> — [[Sources/Note.md#^oldref|Note]]"
    );
  });
});
