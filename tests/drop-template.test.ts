import { describe, expect, it } from "vitest";
import { buildCitation, renderTemplate } from "../src/domain/DropTemplate";
import { DEFAULT_SETTINGS } from "../src/settings/settings";
import type { Settings } from "../src/settings/settings";

const baseVars = {
  content: "hello",
  filename: "note",
  path: "folder/note.md",
  title: "Note",
  blockId: "",
  heading: "",
  url: "obsidian://open?file=folder%2Fnote.md",
  date: "2026-01-01",
};

describe("DropTemplate", () => {
  it("replaces known variables", () => {
    expect(renderTemplate("{{content}}-{{filename}}", { content: "a", filename: "b" })).toBe("a-b");
  });

  it("degrades template A when blockId is empty", () => {
    const out = buildCitation({ ...DEFAULT_SETTINGS, defaultTemplate: "A" } as Settings, baseVars);
    expect(out).toContain("[[folder/note.md");
    expect(out).not.toContain("#^");
  });

  it("keeps block reference when blockId is present", () => {
    const out = buildCitation({ ...DEFAULT_SETTINGS, defaultTemplate: "A" } as Settings, {
      ...baseVars,
      blockId: "abc123",
    });
    expect(out).toContain("#^abc123");
  });

  it.each(["A", "B", "C"] as const)("uses an unambiguous source path in template %s", (defaultTemplate) => {
    const out = buildCitation({ ...DEFAULT_SETTINGS, defaultTemplate }, { ...baseVars, blockId: "abc123" });
    expect(out).toContain("[[folder/note.md");
    expect(out).not.toContain("[[note");
  });

  it("preserves filename variables in user templates", () => {
    const out = buildCitation({ ...DEFAULT_SETTINGS, defaultTemplate: "D", customTemplate: "{{filename}}: {{path}}" }, baseVars);
    expect(out).toBe("note: folder/note.md");
  });
});
