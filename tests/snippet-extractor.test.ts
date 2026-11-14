import { describe, expect, it } from "vitest";
import { extractSnippet } from "../src/domain/SnippetExtractor";
import { mapBlocks } from "../src/domain/BlockMapper";
import { getFrontMatterInfo } from "./support/obsidian";
const extract = (source: string, limit = 150) => extractSnippet(source, mapBlocks(source, getFrontMatterInfo(source).contentStart), limit, true, true, limit);
describe("SnippetExtractor", () => {
  it("clips displayed text without adding an invented ellipsis or expanding its raw block", () => {
    const source = "# Heading\n\nFirst **bold** paragraph.";
    const excerpt = extract(source, 10).excerpt!;
    expect(excerpt.displayText).toBe("First bold"); expect(excerpt.truncated).toBe(true);
    expect(excerpt.origin.rawText).toBe("First **bold** paragraph.");
    expect(excerpt.projection.map((offset) => source[offset]).join("")).toBe("First bold");
  });
  it("distinguishes every repeated highlight occurrence", () => {
    const source = "Repeated\n\n==Repeated== and ==Repeated==\n\n==Repeated==";
    const highlights = extract(source).highlights;
    expect(highlights).toHaveLength(3);
    expect(new Set(highlights.map((h) => h.id)).size).toBe(3);
    expect(highlights[1].projection[0]).toBe(source.indexOf("==Repeated==", source.indexOf("==Repeated==") + 1) + 2);
  });
  it("keeps callout title, visible newlines, real ellipses and source projection", () => {
    const source = "> [!note] Title…\r\n> First\r\n> Second";
    const callout = extract(source, 15).callouts[0];
    expect(callout.displayText).toBe("Title…\nFirst\nSe");
    expect(callout.projection.map((offset) => source[offset]).join("")).toBe(callout.displayText);
    expect(callout.origin.rawText).toBe(source);
  });
  it("does not include frontmatter, headings, code or a source ID in excerpts", () => {
    const source = "---\r\ntitle: ==Private==\r\n---\r\n# Heading\r\n\r\n```\r\ncode\r\n```\r\n\r\nReal ^a";
    expect(extract(source).excerpt?.displayText).toBe("Real");
    expect(extract(source).highlights).toHaveLength(0);
  });
});
