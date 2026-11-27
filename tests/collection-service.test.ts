import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "./support/obsidian";
import { CollectionService, deriveVisible, metadataFilter, stableSort } from "../src/domain/CollectionService";
import { defaultReadingState } from "../src/domain/deskTypes";
import type { CollectionItem } from "../src/domain/deskTypes";

function fixture(files: string[], tags: Record<string, string[]> = {}, excludeGlobs: string[] = []) {
  const tfiles = files.map((path) => new TFile(path));
  const folders = new Set<string>();
  for (const file of tfiles) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const gateway = {
    getMarkdownFiles: () => tfiles,
    getFileCache: (file: TFile) => ({ tags: (tags[file.path] ?? []).map((tag) => ({ tag })), headings: [], blocks: {} }),
    getAbstractFileByPath: (path: string) => folders.has(path) ? new TFolder() : tfiles.find((file) => file.path === path) ?? null,
  };
  const service = new CollectionService({ app: { vault: { getAbstractFileByPath: () => null } } as never, gateway: gateway as never,
    fileRef: (file) => `ref:${file.path}`, globalExcludeGlobs: () => excludeGlobs });
  return { service, tfiles };
}

const base = defaultReadingState();

describe("CollectionService", () => {
  it("merges folder, tag and manual sources into one card with full provenance", async () => {
    const f = fixture(["Research/A.md", "Research/B.md", "Other/C.md"], { "Other/C.md": ["#remote-work"] });
    const snapshot = await f.service.resolve({
      rules: [
        { id: "r1", spec: { kind: "folder", value: "Research", options: { includeSubfolders: true } } },
        { id: "r2", spec: { kind: "tag", value: "#remote-work", options: { matchChildren: true } } },
      ],
      manualPaths: ["Research/A.md"],
    }, 1);
    expect(snapshot.completeness).toBe("complete");
    expect(snapshot.items.map((item) => item.path)).toEqual(["Other/C.md", "Research/A.md", "Research/B.md"]);
    const a = snapshot.items.find((item) => item.path === "Research/A.md")!;
    expect(a.manual).toBe(true);
    expect(a.matchedRuleIds).toEqual(["r1"]);
    const c = snapshot.items.find((item) => item.path === "Other/C.md")!;
    expect(c.matchedRuleIds).toEqual(["r2"]);
  });

  it("applies global exclusions to every source and excludes the target unless manually added", async () => {
    const f = fixture(["Research/A.md", "Research/B.md", "Research/Skip.md"], {}, ["Research/Skip.md"]);
    const snapshot = await f.service.resolve({
      rules: [{ id: "r1", spec: { kind: "folder", value: "Research", options: { includeSubfolders: true } } }],
      manualPaths: ["Research/Skip.md"],
      targetPath: "Research/B.md",
    }, 1);
    expect(snapshot.items.map((item) => item.path)).toEqual(["Research/A.md"]);
  });

  it("marks a failing rule as a partial collection without dropping the others", async () => {
    const f = fixture(["Research/A.md"]);
    const snapshot = await f.service.resolve({
      rules: [
        { id: "bad", spec: { kind: "backlinks", value: "Missing.md", anchorFile: "Missing.md" } },
        { id: "ok", spec: { kind: "folder", value: "Research", options: { includeSubfolders: true } } },
      ],
      manualPaths: [],
    }, 1);
    expect(snapshot.completeness).toBe("partial");
    expect(snapshot.issues.some((issue) => issue.ruleId === "bad")).toBe(true);
    expect(snapshot.items.map((item) => item.path)).toEqual(["Research/A.md"]);
  });

  it("does not auto-adopt a new file for a blocked unresolved manual path", async () => {
    const f = fixture(["Research/A.md", "Other/missing.md"]);
    const snapshot = await f.service.resolve({
      rules: [{ id: "r1", spec: { kind: "folder", value: "Research", options: { includeSubfolders: true } } }],
      manualPaths: ["Other/missing.md"],
      blockedManualPaths: ["Other/missing.md"],
    }, 1);
    expect(snapshot.items.map((item) => item.path)).toEqual(["Research/A.md"]);
    expect(snapshot.issues.some((issue) => issue.category === "IDENTITY_UNCONFIRMED" && issue.path === "Other/missing.md")).toBe(true);
  });

  it("filters metadata, hides dismissed items and sorts stably with pinned first", () => {
    const items: CollectionItem[] = ["a/one.md", "a/two.md", "a/three.md"].map((path, index) => ({
      fileRef: `ref:${path}`, path, title: path.split("/")[1].replace(".md", ""), tags: [], mtime: index, ctime: index,
      matchedRuleIds: [], manual: false, file: new TFile(path),
    }));
    const filtered = metadataFilter(items, "t");
    expect(filtered.map((item) => item.path)).toEqual(["a/two.md", "a/three.md"]);
    const state = { ...base, filter: "t", pinned: ["a/three.md"], dismissed: ["a/two.md"], sort: "name" as const, sortAsc: true };
    expect(deriveVisible(items, state).map((item) => item.path)).toEqual(["a/three.md"]);
    expect(stableSort(items, { ...base, sort: "mtime", sortAsc: false }).map((item) => item.path)).toEqual(["a/three.md", "a/two.md", "a/one.md"]);
  });

  it("narrows with instanceof TFile and diagnoses folders, non-markdown, missing paths, and bad link anchors", async () => {
    const png = new TFile("Assets/pic.png");
    const note = new TFile("Notes/A.md");
    const folder = new TFolder();
    const fakeFileLike = { path: "Notes/Fake.md", extension: "md" };
    const gateway = {
      getMarkdownFiles: () => [note],
      getFileCache: () => ({ tags: [], headings: [], blocks: {}, links: [], embeds: [] }),
      getResolvedLinks: () => ({}),
      getAbstractFileByPath: (path: string) => {
        if (path === "Notes/A.md") return note;
        if (path === "Assets/pic.png") return png;
        if (path === "Notes") return folder;
        if (path === "Notes/Fake.md") return fakeFileLike;
        return null;
      },
    };
    const service = new CollectionService({
      app: { vault: { getAbstractFileByPath: () => null } } as never,
      gateway: gateway as never,
      fileRef: (file) => `ref:${file.path}`,
      globalExcludeGlobs: () => [],
    });

    const snapshot = await service.resolve({
      rules: [
        { id: "bad-folder-anchor", spec: { kind: "backlinks", value: "Notes", anchorFile: "Notes" } },
        { id: "bad-png-anchor", spec: { kind: "outlinks", value: "Assets/pic.png", anchorFile: "Assets/pic.png" } },
        { id: "bad-fake-anchor", spec: { kind: "backlinks", value: "Notes/Fake.md", anchorFile: "Notes/Fake.md" } },
        { id: "ok-anchor", spec: { kind: "outlinks", value: "Notes/A.md", anchorFile: "Notes/A.md" } },
      ],
      manualPaths: ["Notes/A.md", "Notes", "Assets/pic.png", "Notes/Fake.md", "Notes/Missing.md"],
    }, 2);

    expect(snapshot.items.map((item) => item.path)).toEqual(["Notes/A.md"]);
    expect(snapshot.completeness).toBe("partial");
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      { category: "RULE_MISSING", path: "Notes", ruleId: "bad-folder-anchor" },
      { category: "RULE_MISSING", path: "Assets/pic.png", ruleId: "bad-png-anchor" },
      { category: "RULE_MISSING", path: "Notes/Fake.md", ruleId: "bad-fake-anchor" },
      { category: "FILE_MISSING", path: "Notes" },
      { category: "FILE_MISSING", path: "Assets/pic.png" },
      { category: "FILE_MISSING", path: "Notes/Fake.md" },
      { category: "FILE_MISSING", path: "Notes/Missing.md" },
    ]));
  });
});
