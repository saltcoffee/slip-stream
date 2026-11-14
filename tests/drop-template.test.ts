import { describe, expect, it } from "vitest";
import { buildCitation, renderTemplate } from "../src/domain/DropTemplate";
import type { CitationTemplateInput } from "../src/domain/DropTemplate";

const base: CitationTemplateInput = { templateId: "A", content: "First **bold**\n\nSecond line", link: "[[Research/中文 Note.md#^a]]", precision: "block", wholeBlock: true,
  legacyVars: { filename: "中文 Note", path: "Research/中文 Note.md", title: "Title", heading: "Heading", date: "2026-11-14", blockId: "a", url: "obsidian://open?file=Research" } };
describe("DropTemplate", () => {
  it("quotes every line, retaining blank lines and source structure", () => {
    expect(buildCitation(base)).toBe("> First **bold**\n>\n> Second line\n> — [[Research/中文 Note.md#^a]]");
  });
  it("preserves visible spaces and separates a multiline B from its source", () => {
    expect(buildCitation({ ...base, templateId: "B", content: " A\nB " })).toBe(" A\nB \n\n([[Research/中文 Note.md#^a]])");
  });
  it("embeds only a complete verified block", () => { expect(buildCitation({ ...base, templateId: "C" })).toBe("![[Research/中文 Note.md#^a]]"); });
  it.each([{ wholeBlock: false }, { precision: "fragment" }, { precision: "multi-block-start" }, { link: "[[Research/中文 Note.md]]", precision: "file" }])("rejects expanded or unanchored embeds %o", (overrides) => {
    expect(() => buildCitation({ ...base, ...overrides, templateId: "C" } as CitationTemplateInput)).toThrow("TEMPLATE_REQUIRES_BLOCK");
  });
  it("keeps old variable meanings and supports link and blockquoteContent", () => {
    expect(buildCitation({ ...base, templateId: "D", customTemplate: "{{filename}} {{date}}\n{{blockquoteContent}}\n> — {{link}}" }))
      .toBe("中文 Note 2026-11-14\n> First **bold**\n>\n> Second line\n> — [[Research/中文 Note.md#^a]]");
  });
  it.each(["", " ", "{{unknown}}", "{{content", "}} {{link}}"])('rejects invalid custom template "%s"', (customTemplate) => {
    expect(() => buildCitation({ ...base, templateId: "D", customTemplate })).toThrow("TEMPLATE_INVALID");
  });
  it("replaces variables literally without reinterpreting inserted text", () => { expect(renderTemplate("{{content}}", { content: "$&{{filename}}" })).toBe("$&{{filename}}"); });
});
