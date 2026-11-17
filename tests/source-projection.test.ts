import { describe, expect, it } from "vitest";
import { findMatches, foldAscii, projectDocument } from "../src/domain/SourceProjection";

describe("SourceProjection", () => {
  it("projects visible text while keeping original UTF-16 offsets", () => {
    const text = "First **bold** paragraph.";
    const projection = projectDocument(text, 0);
    const segment = projection.segments.find((part) => part.kind === "body")!;
    expect(segment.text).toBe("First bold paragraph.");
    expect(segment.text.length).toBe(segment.sourceOffsets.length);
    const boldIndex = segment.text.indexOf("bold");
    expect(text.slice(segment.sourceOffsets[boldIndex], segment.sourceOffsets[boldIndex + 3] + 1)).toBe("bold");
  });

  it("matches ASCII case-insensitively without changing length and matches Chinese literally", () => {
    expect(foldAscii("AbC")).toBe("abc");
    expect(foldAscii("中文Ab")).toBe("中文ab");
    const text = "Alpha beta ALPHA.";
    const projection = projectDocument(text, 0);
    const segment = projection.segments[0];
    const ranges = findMatches(segment.text, segment.sourceOffsets, "alpha");
    expect(ranges).toHaveLength(2);
    expect(text.slice(ranges[0].from, ranges[0].to)).toBe("Alpha");
    expect(text.slice(ranges[1].from, ranges[1].to)).toBe("ALPHA");
    const chinese = "这是中文短语测试";
    const zh = projectDocument(chinese, 0).segments[0];
    expect(findMatches(zh.text, zh.sourceOffsets, "中文短语")).toHaveLength(1);
  });

  it("does not treat == inside code as a highlight but finds real highlights", () => {
    const text = "Paragraph with ==real highlight==.\n\n```\ncode ==not highlight==\n```";
    const projection = projectDocument(text, 0);
    expect(projection.highlights).toHaveLength(1);
    expect(projection.highlights[0].text).toBe("real highlight");
  });

  it("projects callouts without prefixes and keeps their full range", () => {
    const text = "> [!note] Title\n> First line\n> Second line";
    const projection = projectDocument(text, 0);
    expect(projection.callouts).toHaveLength(1);
    expect(projection.callouts[0].text).toContain("Title");
    expect(projection.callouts[0].text).toContain("First line");
    expect(projection.callouts[0].unitRange.from).toBe(0);
  });

  it("splits table cells into independent match segments", () => {
    const text = "| Alpha | Beta |\n| --- | --- |\n| Gamma | Delta |";
    const projection = projectDocument(text, 0);
    const cells = projection.segments.filter((segment) => segment.kind === "table-cell").map((segment) => segment.text);
    expect(cells).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
  });
});

describe("SourceProjection edge cases", () => {
  it("keeps emoji table cells searchable with UTF-16 offsets", () => {
    const text = "| 😀 needle | b |\n| --- | --- |";
    const projection = projectDocument(text, 0);
    const cell = projection.segments.find((segment) => segment.kind === "table-cell" && segment.text.includes("needle"));
    expect(cell).toBeTruthy();
    expect(cell!.text.length).toBe(cell!.sourceOffsets.length);
    expect(findMatches(cell!.text, cell!.sourceOffsets, "needle")).toHaveLength(1);
  });

  it("ignores == inside double-backtick code spans", () => {
    const projection = projectDocument("Use `` ==fake== `` but ==real==.", 0);
    expect(projection.highlights.map((highlight) => highlight.text)).toEqual(["real"]);
  });

  it("does not treat == inside inline code as a real highlight", () => {
    const projection = projectDocument("Use `==fake==` but ==real==.", 0);
    expect(projection.highlights.map((highlight) => highlight.text)).toEqual(["real"]);
  });
});
