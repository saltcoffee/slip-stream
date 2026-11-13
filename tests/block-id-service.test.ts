import { describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { BlockIdService } from "../src/infra/BlockIdService";

function fixture(source: string, cache: unknown = null) {
  let data = source;
  const file = new TFile("note.md");
  const written = vi.fn();
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: vi.fn(async (_file: TFile, update: (value: string) => string) => {
        data = update(data);
        return data;
      }),
    },
    metadataCache: { getFileCache: () => cache },
  };
  return {
    service: new BlockIdService(app as never, written),
    read: () => data,
    write: (value: string) => { data = value; },
    written,
  };
}

describe("BlockIdService", () => {
  it("keeps a callout's closing code fence intact and puts its ID outside", async () => {
    const source = "> [!note] Example\n> ```js\n> const value = 1;\n> ```";
    const f = fixture(source + "\n\nFollowing paragraph");
    const id = await f.service.ensure("note.md", 0, 4, source, "callout");
    expect(id).toBeTruthy();
    expect(f.read()).toContain(`${source}\n\n^${id}\n\nFollowing paragraph`);
  });

  it("does not append an ID to a list item's nested code fence", async () => {
    const source = "- Parent\n  ```js\n  const value = 1;\n  ```";
    const f = fixture(source);
    const id = await f.service.ensure("note.md", 0, 4, source, "list_item");
    expect(id).toBeTruthy();
    expect(f.read()).toContain("\n  ```");
    expect(f.read()).not.toContain("``` ^");
  });

  it("reuses an inline ID with the pre-write snapshot", async () => {
    const source = "Same paragraph";
    const f = fixture(source);
    const first = await f.service.ensure("note.md", 0, 1, source, "paragraph");
    const second = await f.service.ensure("note.md", 0, 1, source, "paragraph");
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(f.read()).toBe(`${source} ^${first}`);
    expect(f.written).toHaveBeenCalledTimes(1);
  });

  it("leaves a code-only list item unchanged when no inline anchor is available", async () => {
    const source = "- ```js\n  const value = 1;\n  ```";
    const f = fixture(source);
    expect(await f.service.ensure("note.md", 0, 3, source, "list_item")).toBeUndefined();
    expect(f.read()).toBe(source);
  });

  it("reuses a standalone ID without inserting another marker", async () => {
    const source = "> [!note] Example\n> Text";
    const f = fixture(source + "\n\nFollowing");
    const first = await f.service.ensure("note.md", 0, 2, source, "callout");
    const after = f.read();
    expect(await f.service.ensure("note.md", 0, 2, source, "callout")).toBe(first);
    expect(f.read()).toBe(after);
  });

  it("leaves the file untouched when a snapshot's lines have shifted", async () => {
    const f = fixture("New paragraph\n\nParagraph A\n\nParagraph B");
    const before = f.read();
    expect(await f.service.ensure("note.md", 2, 3, "Paragraph B", "paragraph")).toBeUndefined();
    expect(f.read()).toBe(before);
  });

  it("does not treat added text as only a block ID change", async () => {
    const f = fixture("Paragraph changed ^abc123");
    expect(await f.service.ensure("note.md", 0, 1, "Paragraph", "paragraph")).toBeUndefined();
    expect(f.read()).toBe("Paragraph changed ^abc123");
  });

  it("preserves an existing list ID on a continuation line", async () => {
    const source = "- Parent\n\n  Continued ^oldref";
    const f = fixture(source, { blocks: { oldref: { id: "oldref", position: { start: { line: 0 } } } } });
    expect(await f.service.ensure("note.md", 0, 3, source, "list_item")).toBe("oldref");
    expect(f.read()).toBe(source);
    expect(f.written).not.toHaveBeenCalled();
  });

  it("preserves CRLF and trailing spaces while reusing a paragraph ID", async () => {
    const source = "First line  \r\nSecond line  ";
    const f = fixture(source);
    const id = await f.service.ensure("note.md", 0, 2, source, "paragraph");
    expect(f.read()).toBe(`${source} ^${id}`);
    expect(await f.service.ensure("note.md", 0, 2, source, "paragraph")).toBe(id);
  });
});
