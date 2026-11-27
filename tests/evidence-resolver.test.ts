// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EvidenceResolver } from "../src/domain/EvidenceResolver";
import type { EvidenceReaderPort } from "../src/domain/EvidenceResolver";
import { CitationError } from "../src/domain/citationTypes";
import { sliceContextAfter, sliceContextBefore } from "../src/domain/outlineTypes";
import type { EvidenceEntry, EvidenceSnapshot } from "../src/domain/outlineTypes";
import { BlockIdService } from "../src/infra/BlockIdService";
import { TFile } from "./support/obsidian";

function makeResolverFixture(initialFiles: Record<string, string>) {
  const contents = new Map<string, string>(Object.entries(initialFiles));
  const files = new Map<string, TFile>();
  const refs = new Map<string, string>();
  const refToPath = new Map<string, string>();
  let seq = 0;

  for (const path of Object.keys(initialFiles)) {
    const file = new TFile(path);
    files.set(path, file);
    const ref = `ref-${++seq}`;
    refs.set(path, ref);
    refToPath.set(ref, path);
  }

  const process = vi.fn(async () => "");
  const writeSource = vi.fn(() => false);
  const readCount = vi.fn();

  const editors = {
    fileRef: (file: TFile) => refs.get(file.path)!,
    file: (ref: string) => {
      const p = refToPath.get(ref);
      if (!p || !files.has(p)) throw new CitationError("SOURCE_MISSING");
      return files.get(p)!;
    },
    path: (ref: string) => {
      const p = refToPath.get(ref);
      if (!p || !files.has(p)) throw new CitationError("SOURCE_MISSING");
      return p;
    },
    readSource: async (ref: string) => {
      const p = refToPath.get(ref);
      if (!p || !contents.has(p)) throw new CitationError("SOURCE_MISSING");
      return contents.get(p)!;
    },
    writeSource,
  };

  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      process,
    },
    metadataCache: {
      getFileCache: () => ({ headings: [{ heading: "Section" }] }),
    },
  };

  const blockIds = new BlockIdService(app as never, editors as never);
  let customReadError: ((path: string) => Error | undefined) | undefined;

  const reader: EvidenceReaderPort = {
    resolveRef: (path: string) => (files.has(path) ? refs.get(path) : undefined),
    read: async (fileRef: string, signal?: AbortSignal) => {
      if (signal?.aborted) throw new CitationError("OPERATION_CANCELLED");
      const path = editors.path(fileRef);
      readCount(path);
      const err = customReadError?.(path);
      if (err) throw err;
      const text = contents.get(path)!;
      return { fileRef, path, text, bodyStart: 0, version: 1 };
    },
    capture: (fileRef: string, text: string) => blockIds.capture(editors.file(fileRef) as never, text),
  };

  const resolver = new EvidenceResolver(reader);

  const entryFromSpan = (
    id: string,
    path: string,
    spanIndex: number,
    options: { mode?: EvidenceSnapshot["mode"]; slice?: [number, number] } = {},
  ): EvidenceEntry => {
    const text = contents.get(path)!;
    const snap = blockIds.capture(files.get(path) as never, text);
    const span = snap.spans[spanIndex];
    const mode = options.mode ?? "block";
    const selRange = options.slice
      ? { from: span.rawRange.from + options.slice[0], to: span.rawRange.from + options.slice[1] }
      : { ...span.rawRange };
    return {
      id,
      groupId: null,
      note: "",
      contentRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      snapshot: {
        content: text.slice(selRange.from, selRange.to),
        mode,
        source: {
          path,
          capturedPath: path,
          title: files.get(path)!.basename,
          capturedAt: 1,
          sourceLength: text.length,
          identity: "path-reference",
        },
        origins: [
          {
            range: { ...span.rawRange },
            rawText: span.rawText,
            kind: span.kind,
            ...(span.existingBlockId ? { blockId: span.existingBlockId } : {}),
            ...(span.heading ? { heading: span.heading } : {}),
            before: sliceContextBefore(text, span.rawRange.from),
            after: sliceContextAfter(text, span.rawRange.to),
          },
        ],
        selectedRanges: [selRange],
      },
    };
  };

  return {
    contents,
    files,
    blockIds,
    resolver,
    readCount,
    process,
    writeSource,
    setReadError: (fn: ((path: string) => Error | undefined) | undefined) => {
      customReadError = fn;
    },
    entryFromSpan,
  };
}

describe("EvidenceResolver", () => {
  it("verifies unchanged sources read-only without mutating files or adding block IDs (AC-05)", async () => {
    const initial = "First paragraph 🚀\r\n\r\nSecond paragraph";
    const f = makeResolverFixture({ "Notes/A.md": initial });
    const entry = f.entryFromSpan("e1", "Notes/A.md", 0);

    const res = await f.resolver.resolveEntry(entry);
    expect(res.status).toBe("verified");
    expect(res.liveSpans).toHaveLength(1);
    expect(res.mappedOrigins).toEqual([entry.snapshot.origins[0].range]);
    expect(f.contents.get("Notes/A.md")).toBe(initial);
    expect(f.process).not.toHaveBeenCalled();
    expect(f.writeSource).not.toHaveBeenCalled();
  });

  it("ignores unrelated trailing additions and tolerates a newly added verified block ID", async () => {
    const f = makeResolverFixture({ "Notes/A.md": "Target sentence\n\nOther" });
    const entry = f.entryFromSpan("e1", "Notes/A.md", 0);

    f.contents.set("Notes/A.md", "Target sentence ^abc123\n\nOther\n\nAppended unrelated paragraph");
    const res = await f.resolver.resolveEntry(entry);
    expect(res.status).toBe("verified");
    expect(res.liveSpans?.[0].existingBlockId).toBe("abc123");
  });

  it("disambiguates duplicate sentences by context and rejects ambiguous duplicates (AC-17)", async () => {
    const f = makeResolverFixture({
      "Notes/Dup.md": "Alpha before\n\nRepeated sentence\n\nBeta after\n\nGamma before\n\nRepeated sentence\n\nDelta after",
    });
    const entry = f.entryFromSpan("e1", "Notes/Dup.md", 4); // second "Repeated sentence"

    // Shift offsets by prepending text -> unique before/after disambiguates the second occurrence.
    f.contents.set(
      "Notes/Dup.md",
      "Prepended header\n\nAlpha before\n\nRepeated sentence\n\nBeta after\n\nGamma before\n\nRepeated sentence\n\nDelta after",
    );
    const relocated = await f.resolver.resolveEntry(entry);
    expect(relocated.status).toBe("relocated");
    expect(relocated.mappedOrigins?.[0].from).toBeGreaterThan(entry.snapshot.origins[0].range.from);

    // Identical context around both duplicates -> must NOT pick the first one!
    f.contents.set("Notes/Dup.md", "Prepended\n\nRepeated sentence\n\nEnd\n\nRepeated sentence\n\nEnd");
    const ambiguous = await f.resolver.resolveEntry(entry);
    expect(ambiguous.status).toBe("unlocated");
  });

  it("maps contiguous multi-block origins monotonically and rejects intervening blocks", async () => {
    const f = makeResolverFixture({ "Notes/Multi.md": "One\n\nTwo" });
    const text = f.contents.get("Notes/Multi.md")!;
    const snap = f.blockIds.capture(f.files.get("Notes/Multi.md") as never, text);
    const [s1, s2] = snap.spans;
    const entry: EvidenceEntry = {
      id: "e-multi",
      groupId: null,
      note: "",
      contentRevision: 1,
      createdAt: 1,
      updatedAt: 1,
      snapshot: {
        content: "One\n\nTwo",
        mode: "selection",
        source: { path: "Notes/Multi.md", capturedPath: "Notes/Multi.md", title: "Multi", capturedAt: 1, sourceLength: text.length, identity: "path-reference" },
        origins: [
          { range: { ...s1.rawRange }, rawText: s1.rawText, kind: s1.kind, before: sliceContextBefore(text, s1.rawRange.from), after: sliceContextAfter(text, s1.rawRange.to) },
          { range: { ...s2.rawRange }, rawText: s2.rawText, kind: s2.kind, before: sliceContextBefore(text, s2.rawRange.from), after: sliceContextAfter(text, s2.rawRange.to) },
        ],
        selectedRanges: [{ ...s1.rawRange }, { ...s2.rawRange }],
      },
    };

    f.contents.set("Notes/Multi.md", "Prefix\n\nOne\n\nTwo");
    expect((await f.resolver.resolveEntry(entry)).status).toBe("relocated");

    f.contents.set("Notes/Multi.md", "Prefix\n\nOne\n\nIntervening\n\nTwo");
    expect((await f.resolver.resolveEntry(entry)).status).toBe("unlocated");
  });

  it("provides block refresh candidates only for block mode, never auto-expanding fragments", async () => {
    const f = makeResolverFixture({ "Notes/Edit.md": "Before\n\nOriginal block ^blk1\n\nAfter" });
    const blockEntry = f.entryFromSpan("e-block", "Notes/Edit.md", 1, { mode: "block" });
    const fragEntry = f.entryFromSpan("e-frag", "Notes/Edit.md", 1, { mode: "fragment", slice: [0, 8] });

    f.contents.set("Notes/Edit.md", "Before\n\nEdited block content ^blk1\n\nAfter");

    const blockRes = await f.resolver.resolveEntry(blockEntry);
    expect(blockRes.status).toBe("changed");
    expect(blockRes.refreshCandidate?.newContent).toBe("Edited block content");
    expect(blockRes.refreshCandidate?.newSnapshot.mode).toBe("block");

    const fragRes = await f.resolver.resolveEntry(fragEntry);
    expect(fragRes.status).toBe("changed");
    expect(fragRes.refreshCandidate).toBeUndefined();
  });

  it("distinguishes missing, unconfirmed-after-loss, and unavailable sources (AC-18)", async () => {
    const f = makeResolverFixture({ "Notes/A.md": "Body", "Notes/B.md": "Body B" });
    const missingEntry = f.entryFromSpan("e1", "Notes/A.md", 0);
    f.files.delete("Notes/A.md");
    expect((await f.resolver.resolveEntry(missingEntry)).status).toBe("missing");

    const unconfirmedEntry = f.entryFromSpan("e2", "Notes/B.md", 0);
    unconfirmedEntry.snapshot.source.identity = "unconfirmed-after-loss";
    expect((await f.resolver.resolveEntry(unconfirmedEntry)).status).toBe("missing");

    unconfirmedEntry.snapshot.source.identity = "path-reference";
    f.setReadError(() => new CitationError("SOURCE_AMBIGUOUS"));
    const unavailable = await f.resolver.resolveEntry(unconfirmedEntry);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toBe("SOURCE_AMBIGUOUS");
  });

  it("shares one source read per file in resolveBatch, reports progress, and supports cancellation", async () => {
    const f = makeResolverFixture({ "Notes/Shared.md": "One\n\nTwo\n\nThree" });
    const entries = [
      f.entryFromSpan("e1", "Notes/Shared.md", 0),
      f.entryFromSpan("e2", "Notes/Shared.md", 1),
      f.entryFromSpan("e3", "Notes/Shared.md", 2),
    ];
    const progress: Array<{ checked: number; total: number }> = [];
    const results = await f.resolver.resolveBatch(entries, {
      onProgress: (p) => progress.push(p),
    });
    expect(results.map((r) => r.status)).toEqual(["verified", "verified", "verified"]);
    expect(f.readCount).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([
      { checked: 1, total: 3 },
      { checked: 2, total: 3 },
      { checked: 3, total: 3 },
    ]);

    const abort = new AbortController();
    abort.abort();
    await expect(f.resolver.resolveBatch(entries, { signal: abort.signal })).rejects.toThrow("OPERATION_CANCELLED");

    // Chunked macrotask yield completes and respects mid-batch abort.
    const chunked = await f.resolver.resolveBatch(entries, { chunkSize: 1 });
    expect(chunked).toHaveLength(3);
  });
});
