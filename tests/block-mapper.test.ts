import { describe, expect, it } from "vitest";
import { groupRenderUnits, mapBlocks } from "../src/domain/BlockMapper";

const fakeApp = { metadataCache: { getFileCache: () => null } } as never;
const fakeFile = { path: "note.md", stat: { mtime: 0 } } as never;

describe("BlockMapper", () => {
  it("maps paragraph and list items with line ranges", () => {
    const source = "hello\n\n- a\n- b";
    const blocks = mapBlocks(source);
    expect(blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(blocks.filter((b) => b.type === "list_item")).toHaveLength(2);
    const list = blocks.find((b) => b.type === "list_item");
    expect(list?.startLine).toBe(2);
    expect(list?.endLine).toBe(3);
  });

  it("groups consecutive list items into one list unit", () => {
    const source = "hello\n\n- a\n- b";
    const lines = source.split("\n");
    const blocks = mapBlocks(source);
    const units = groupRenderUnits(blocks, lines);
    const listUnit = units.find((u) => u.type === "list");
    expect(listUnit).toBeTruthy();
    expect(listUnit?.items).toHaveLength(2);
  });

  it("detects existing block id", () => {
    const blocks = mapBlocks("hello ^abc123");
    expect(blocks[0].hasBlockId).toBe(true);
    expect(blocks[0].blockId).toBe("abc123");
  });

  it("keeps a parent list item's continuation after its nested list", () => {
    const source = "- Parent\n  - Child\n\n  Parent continuation";
    const blocks = mapBlocks(source);
    const units = groupRenderUnits(blocks, source.split("\n"));
    expect(units).toHaveLength(1);
    expect(units[0].content).toBe(source);
    expect(units[0].endLine).toBe(4);
  });

  it("does not expose standalone block markers as draggable paragraphs", () => {
    const source = "> [!note] Text\n> Body\n\n^abc123\n\nNext paragraph";
    const blocks = mapBlocks(source);
    expect(blocks.map((b) => b.content)).toEqual(["> [!note] Text\n> Body", "Next paragraph"]);
  });
});
