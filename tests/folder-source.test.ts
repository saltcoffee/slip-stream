import { describe, expect, it } from "vitest";
import { FolderSource, isExcluded } from "../src/domain/sources/FolderSource";
import type { SourceContext } from "../src/domain/sources/SourceResolver";

function file(path: string) {
  const parts = path.split("/");
  const parent = parts.length > 1 ? parts.slice(0, -1).join("/") : "/";
  return { path, parent: { path: parent } };
}

const gateway = {
  getMarkdownFiles: () => [
    file("Journal/a.md"),
    file("Journal/b.md"),
    file("Journal/sub/c.md"),
    file("Other/d.md"),
  ],
};

const ctx = { app: { vault: { getAbstractFileByPath: () => null } }, gateway } as unknown as SourceContext;

describe("FolderSource", () => {
  it("includes subfolders when enabled", async () => {
    const resolver = new FolderSource();
    const files = await resolver.resolve(
      { kind: "folder", value: "/Journal", options: { includeSubfolders: true } },
      ctx
    );
    expect(files.map((f) => f.path)).toEqual(["Journal/a.md", "Journal/b.md", "Journal/sub/c.md"]);
  });

  it("excludes subfolders when disabled", async () => {
    const resolver = new FolderSource();
    const files = await resolver.resolve(
      { kind: "folder", value: "/Journal", options: { includeSubfolders: false } },
      ctx
    );
    expect(files.map((f) => f.path)).toEqual(["Journal/a.md", "Journal/b.md"]);
  });

  it("excludes glob patterns", () => {
    expect(isExcluded("Journal/sub/c.md", ["Journal/sub/**"])).toBe(true);
    expect(isExcluded("Journal/a.md", ["*.tmp.md"])).toBe(false);
  });
});
