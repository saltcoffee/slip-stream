// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./support/obsidian";
import { SearchDocumentReader } from "../src/infra/SearchDocumentReader";
import { FocusSearch } from "../src/domain/FocusSearch";
import type { CollectionItem } from "../src/domain/deskTypes";

function item(path: string): CollectionItem {
  return { fileRef: `ref:${path}`, path, title: path, tags: [], mtime: 0, ctime: 0, matchedRuleIds: [], manual: false, file: new TFile(path) };
}

function fixture(bodies: Record<string, string>) {
  const editors = {
    readSource: async (ref: string) => {
      const path = ref.slice(4);
      if (!(path in bodies)) throw new Error("missing");
      return bodies[path];
    },
    path: (ref: string) => ref.slice(4),
  };
  const reader = new SearchDocumentReader(editors as never);
  return new FocusSearch(reader);
}

const request = (overrides: Partial<Parameters<FocusSearch["run"]>[0]> = {}) => ({
  sessionId: "s", scopeRevision: 1, collectionGeneration: 1, query: "needle", kind: "all" as const, includeHidden: false, ...overrides,
});

describe("FocusSearch", () => {
  it("scans the whole candidate list, including notes beyond the first page", async () => {
    const search = fixture({ "a.md": "nothing", "b.md": "nothing", "c.md": "a needle here" });
    const run = await search.run(request(), [item("a.md"), item("b.md"), item("c.md")], new AbortController().signal, true, () => {});
    expect(run.phase).toBe("complete");
    expect(run.results).toHaveLength(1);
    expect(run.results[0].filePath).toBe("c.md");
    expect(run.results[0].matches).toHaveLength(1);
    expect(run.progress.files).toBe(1);
  });

  it("only returns highlights whose own text contains the query", async () => {
    const search = fixture({ "a.md": "some ==needle== text", "b.md": "plain needle no highlight", "c.md": "==other== needle outside" });
    const run = await search.run(request({ kind: "highlight" }), [item("a.md"), item("b.md"), item("c.md")], new AbortController().signal, true, () => {});
    expect(run.results).toHaveLength(1);
    expect(run.results[0].filePath).toBe("a.md");
    expect(run.results[0].kind).toBe("highlight");
  });

  it("returns callouts filtered by their content", async () => {
    const search = fixture({ "a.md": "> [!note] Idea\n> contains needle", "b.md": "> [!note] Other\n> nothing" });
    const run = await search.run(request({ kind: "callout" }), [item("a.md"), item("b.md")], new AbortController().signal, true, () => {});
    expect(run.results).toHaveLength(1);
    expect(run.results[0].filePath).toBe("a.md");
    expect(run.results[0].kind).toBe("callout");
  });

  it("enumerates all highlights and callouts when there is no keyword", async () => {
    const search = fixture({ "a.md": "==one== and ==two==\n\n> [!note] Box\n> Body" });
    const run = await search.run(request({ query: "", kind: "either" }), [item("a.md")], new AbortController().signal, true, () => {});
    const kinds = run.results.map((result) => result.kind).sort();
    expect(kinds).toEqual(["callout", "highlight", "highlight"]);
  });

  it("reports cancellation and never publishes results after abort", async () => {
    const search = fixture({ "a.md": "needle" });
    const controller = new AbortController();
    controller.abort();
    const run = await search.run(request(), [item("a.md")], controller.signal, true, () => {});
    expect(run.phase).toBe("cancelled");
    expect(run.results).toHaveLength(0);
  });

  it("publishes partial results before the whole scan completes", async () => {
    const search = fixture({ "a.md": "needle", "b.md": "needle", "c.md": "needle" });
    const seen: number[] = [];
    await search.run(request(), [item("a.md"), item("b.md"), item("c.md")], new AbortController().signal, true, (progress, results) => {
      if (progress.phase === "running") seen.push(results.length);
    });
    expect(seen.some((count) => count > 0)).toBe(true);
  });

  it("treats an empty range as a complete empty search", async () => {
    const search = fixture({});
    const run = await search.run(request(), [], new AbortController().signal, true, () => {});
    expect(run.total).toBe(0);
    expect(run.phase).toBe("complete");
    expect(run.results).toHaveLength(0);
  });

  it("yields with window.setTimeout during long scans and clears timer on abort", async () => {
    const bodies: Record<string, string> = {};
    const items: CollectionItem[] = [];
    for (let i = 0; i < 6; i++) {
      const path = `n${i}.md`;
      bodies[path] = "needle";
      items.push(item(path));
    }
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const nowSpy = vi.spyOn(Date, "now");
    let tick = 0;
    nowSpy.mockImplementation(() => {
      tick += 10;
      return tick;
    });
    try {
      const search = fixture(bodies);
      const completed = await search.run(request(), items, new AbortController().signal, true, () => {});
      expect(completed.phase).toBe("complete");
      expect(completed.results).toHaveLength(6);
      expect(setTimeoutSpy).toHaveBeenCalled();

      const controller = new AbortController();
      setTimeoutSpy.mockClear();
      clearTimeoutSpy.mockClear();
      let reads = 0;
      const slowReader = {
        read: async (ref: string) => {
          reads++;
          if (reads === 2) {
            queueMicrotask(() => controller.abort());
          }
          return "needle";
        },
      };
      const slowSearch = new FocusSearch(slowReader as never);
      const abortedRun = await slowSearch.run(request(), items, controller.signal, true, () => {});
      expect(abortedRun.phase).toBe("cancelled");
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
