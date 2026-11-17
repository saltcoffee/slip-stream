import { describe, expect, it } from "vitest";
import { chapterRange } from "../src/domain/ChapterRange";

describe("chapterRange", () => {
  it.each(["```md\n# Not a chapter\n```", "~~~md\n# Not a chapter\n~~~", "    # Not a chapter"])("ignores code headings in %s", (code) => {
    const text = `# Evidence\nINTRO context\n\n${code}\n\nneedle actual evidence\n\n# Next\nexcluded`;
    const range = chapterRange(text, 0, text.indexOf("needle"));
    expect(text.slice(range.from, range.to)).toContain("needle actual evidence");
    expect(text.slice(range.from, range.to)).not.toContain("excluded");
    expect(range.from).toBe(0);
  });

  it("locates the actual repeated heading by source position", () => {
    const text = "# Same\nWRONG\n\n# Same\nneedle RIGHT\n\n## Child\nkept\n\n# Last\nexcluded";
    const range = chapterRange(text, 0, text.indexOf("needle"));
    const section = text.slice(range.from, range.to);
    expect(section).toContain("needle RIGHT");
    expect(section).toContain("## Child");
    expect(section).not.toMatch(/WRONG|excluded/);
  });

  it("uses parsed heading levels for Setext headings", () => {
    const text = "Top\n===\n\nSub\n---\n\nneedle\n\nNext\n---\n\nexcluded";
    const range = chapterRange(text, 0, text.indexOf("needle"));
    expect(text.slice(range.from, range.to).trim()).toBe("Sub\n---\n\nneedle");
  });

  it("limits a prelude to the first real heading and excludes frontmatter", () => {
    const frontmatter = "---\ntitle: Hidden\n---\n";
    const text = frontmatter + "needle prelude\n\n# First\nexcluded";
    const range = chapterRange(text, frontmatter.length, text.indexOf("needle"));
    expect(text.slice(range.from, range.to).trim()).toBe("needle prelude");
  });

  it("returns the complete body of an unheaded long source", () => {
    const text = "START\n" + "x".repeat(3500) + "\nneedle\n" + "y".repeat(3500) + "\nEND";
    expect(chapterRange(text, 0, text.indexOf("needle"))).toEqual({ from: 0, to: text.length });
  });
});
