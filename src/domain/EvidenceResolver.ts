import { stripInlineBlockId } from "./BlockReference";
import { CitationError } from "./citationTypes";
import type { OriginSpan, SourceSnapshot, TextRange } from "./citationTypes";
import { cloneSnapshot, sliceContextAfter, sliceContextBefore } from "./outlineTypes";
import type { EvidenceEntry, EvidenceSnapshot, SavedOrigin } from "./outlineTypes";

export interface EvidenceDocument {
  fileRef: string;
  path: string;
  text: string;
  bodyStart: number;
  version: number;
}

export interface EvidenceReaderPort {
  resolveRef(path: string): string | undefined;
  read(fileRef: string, signal?: AbortSignal): Promise<EvidenceDocument>;
  capture(fileRef: string, text: string): SourceSnapshot;
}

export type EvidenceResolutionStatus =
  | "verified"
  | "relocated"
  | "changed"
  | "unlocated"
  | "missing"
  | "unavailable";

export interface EvidenceRefreshCandidate {
  newContent: string;
  newSnapshot: EvidenceSnapshot;
}

export interface ResolvedEvidence {
  entryId: string;
  contentRevision: number;
  status: EvidenceResolutionStatus;
  sourceRef?: string;
  sourcePath: string;
  sourceVersion?: number;
  liveSnapshot?: SourceSnapshot;
  liveSpans?: readonly OriginSpan[];
  mappedOrigins?: readonly TextRange[];
  mappedSelectedRanges?: readonly TextRange[];
  refreshCandidate?: EvidenceRefreshCandidate;
  reason?: string;
}

export interface ResolveBatchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { checked: number; total: number }) => void;
  chunkSize?: number;
}

interface CachedSource {
  sourceRef: string;
  doc?: EvidenceDocument;
  snapshot?: SourceSnapshot;
  errorStatus?: "unavailable";
  errorReason?: string;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof CitationError && error.code === "OPERATION_CANCELLED") return true;
  return error instanceof Error && (error.name === "AbortError" || error.message === "OPERATION_CANCELLED");
}

function stripOriginText(origin: SavedOrigin): string {
  return stripInlineBlockId(origin.rawText, origin.kind, origin.blockId);
}

function stripSpanText(span: OriginSpan): string {
  return stripInlineBlockId(span.rawText, span.kind, span.existingBlockId);
}

function matchesOriginContent(candidate: OriginSpan, origin: SavedOrigin): boolean {
  return candidate.kind === origin.kind && stripSpanText(candidate) === stripOriginText(origin);
}

function buildRefreshCandidate(
  entry: EvidenceEntry,
  doc: EvidenceDocument,
  liveSnapshot: SourceSnapshot,
  span: OriginSpan,
): EvidenceRefreshCandidate {
  const newContent = stripSpanText(span);
  const newOrigin: SavedOrigin = {
    range: { ...span.rawRange },
    rawText: span.rawText,
    kind: span.kind,
    ...(span.existingBlockId ? { blockId: span.existingBlockId } : {}),
    ...(span.heading ? { heading: span.heading } : {}),
    before: sliceContextBefore(doc.text, span.rawRange.from),
    after: sliceContextAfter(doc.text, span.rawRange.to),
  };
  return {
    newContent,
    newSnapshot: cloneSnapshot({
      content: newContent,
      mode: "block",
      source: {
        path: doc.path,
        capturedPath: entry.snapshot.source.capturedPath,
        title: liveSnapshot.title ?? entry.snapshot.source.title,
        capturedAt: Date.now(),
        sourceLength: doc.text.length,
        identity: "path-reference",
      },
      origins: [newOrigin],
      selectedRanges: [{ ...span.rawRange }],
    }),
  };
}

function hasInterveningBlock(
  spans: readonly OriginSpan[],
  prevTo: number,
  nextFrom: number,
): boolean {
  if (nextFrom <= prevTo) return false;
  return spans.some(
    (span) =>
      span.kind !== "list" &&
      span.rawRange.from >= prevTo &&
      span.rawRange.to <= nextFrom,
  );
}

function contextMatchesBoundary(
  liveBefore: string,
  liveAfter: string,
  savedBefore: string,
  savedAfter: string,
): boolean {
  if (liveBefore === savedBefore && liveAfter === savedAfter) return true;
  const minBefore = Math.min(liveBefore.length, savedBefore.length);
  const minAfter = Math.min(liveAfter.length, savedAfter.length);
  const beforeMatch = minBefore > 0 && liveBefore.slice(-minBefore) === savedBefore.slice(-minBefore);
  const afterMatch = minAfter > 0 && liveAfter.slice(0, minAfter) === savedAfter.slice(0, minAfter);
  const hasBefore = savedBefore.length > 0;
  const hasAfter = savedAfter.length > 0;
  if (hasBefore && hasAfter) return beforeMatch && afterMatch;
  if (hasBefore) return beforeMatch;
  if (hasAfter) return afterMatch;
  return false;
}

function resolveAgainstSnapshot(
  entry: EvidenceEntry,
  sourceRef: string,
  doc: EvidenceDocument,
  liveSnapshot: SourceSnapshot,
): ResolvedEvidence {
  const saved = entry.snapshot;
  if (!saved.origins.length) {
    return {
      entryId: entry.id,
      contentRevision: entry.contentRevision,
      status: "unlocated",
      sourceRef,
      sourcePath: doc.path,
      sourceVersion: doc.version,
      reason: "Snapshot contains no origin spans",
    };
  }

  const matchedSpans: OriginSpan[] = [];
  let minFrom = 0;

  for (let i = 0; i < saved.origins.length; i++) {
    const origin = saved.origins[i];
    let matched: OriginSpan | undefined;

    // 1. Unique verified block ID match.
    if (origin.blockId) {
      const idMatches = liveSnapshot.spans.filter(
        (span) => span.kind === origin.kind && span.existingBlockId === origin.blockId,
      );
      if (idMatches.length === 1) {
        const candidate = idMatches[0];
        if (!matchesOriginContent(candidate, origin)) {
          return {
            entryId: entry.id,
            contentRevision: entry.contentRevision,
            status: "changed",
            sourceRef,
            sourcePath: doc.path,
            sourceVersion: doc.version,
            ...(saved.origins.length === 1 && saved.mode === "block"
              ? { refreshCandidate: buildRefreshCandidate(entry, doc, liveSnapshot, candidate) }
              : {}),
            reason: "Block content changed at verified block ID",
          };
        }
        if (candidate.rawRange.from >= minFrom) matched = candidate;
      }
    }

    // 2. Saved range & context remain unchanged.
    if (!matched) {
      const inPlace = liveSnapshot.spans.find(
        (span) =>
          span.rawRange.from >= minFrom &&
          span.rawRange.from === origin.range.from &&
          matchesOriginContent(span, origin),
      );
      if (inPlace) {
        const beforeOk = sliceContextBefore(doc.text, inPlace.rawRange.from) === origin.before;
        const afterRaw = sliceContextAfter(doc.text, inPlace.rawRange.to);
        const afterOk = afterRaw === origin.after ||
          (!!inPlace.existingBlockId && !origin.blockId);
        if (beforeOk && afterOk) matched = inPlace;
      }
    }

    // 3. Unique content + adjacent before/after context relocation.
    if (!matched) {
      const contentMatches = liveSnapshot.spans.filter(
        (span) => span.rawRange.from >= minFrom && matchesOriginContent(span, origin),
      );
      if (contentMatches.length === 1) {
        matched = contentMatches[0];
      } else if (contentMatches.length > 1) {
        const exactMatches = contentMatches.filter((span) => {
          const beforeOk = sliceContextBefore(doc.text, span.rawRange.from) === origin.before;
          const afterOk = sliceContextAfter(doc.text, span.rawRange.to) === origin.after;
          return beforeOk && afterOk;
        });
        const boundaryMatches = exactMatches.length > 0 ? exactMatches : contentMatches.filter((span) =>
          contextMatchesBoundary(
            sliceContextBefore(doc.text, span.rawRange.from),
            sliceContextAfter(doc.text, span.rawRange.to),
            origin.before,
            origin.after,
          ),
        );
        if (boundaryMatches.length === 1) {
          matched = boundaryMatches[0];
        } else {
          return {
            entryId: entry.id,
            contentRevision: entry.contentRevision,
            status: "unlocated",
            sourceRef,
            sourcePath: doc.path,
            sourceVersion: doc.version,
            reason: "Multiple identical candidates without unique context",
          };
        }
      }
    }

    if (!matched) {
      // Check if a single block edited in-place with intact surrounding context can offer a block refresh.
      if (saved.origins.length === 1) {
        const sameKindAtContext = liveSnapshot.spans.filter((span) => {
          if (span.kind !== origin.kind) return false;
          const beforeMatch = origin.before.length > 0 && sliceContextBefore(doc.text, span.rawRange.from) === origin.before;
          const afterMatch = origin.after.length > 0 && sliceContextAfter(doc.text, span.rawRange.to) === origin.after;
          if (origin.before.length > 0 && origin.after.length > 0) return beforeMatch && afterMatch;
          if (span.rawRange.from === origin.range.from && (beforeMatch || afterMatch)) return true;
          return false;
        });
        if (sameKindAtContext.length === 1) {
          return {
            entryId: entry.id,
            contentRevision: entry.contentRevision,
            status: "changed",
            sourceRef,
            sourcePath: doc.path,
            sourceVersion: doc.version,
            ...(saved.mode === "block"
              ? { refreshCandidate: buildRefreshCandidate(entry, doc, liveSnapshot, sameKindAtContext[0]) }
              : {}),
            reason: "Block content changed while surrounding context remained identifiable",
          };
        }
      }
      return {
        entryId: entry.id,
        contentRevision: entry.contentRevision,
        status: "unlocated",
        sourceRef,
        sourcePath: doc.path,
        sourceVersion: doc.version,
        reason: "Original block could not be uniquely located",
      };
    }

    if (i > 0 && hasInterveningBlock(liveSnapshot.spans, matchedSpans[i - 1].rawRange.to, matched.rawRange.from)) {
      return {
        entryId: entry.id,
        contentRevision: entry.contentRevision,
        status: "unlocated",
        sourceRef,
        sourcePath: doc.path,
        sourceVersion: doc.version,
        reason: "Multi-block span order is no longer contiguous",
      };
    }

    matchedSpans.push(matched);
    minFrom = matched.rawRange.to;
  }

  // Remap all selectedRanges monotonically inside their owning matched origins.
  const mappedSelectedRanges: TextRange[] = [];
  let prevSelEnd = 0;
  for (const sel of saved.selectedRanges) {
    const ownerIndex = saved.origins.findIndex(
      (origin) => origin.range.from <= sel.from && sel.to <= origin.range.to,
    );
    if (ownerIndex < 0) {
      return {
        entryId: entry.id,
        contentRevision: entry.contentRevision,
        status: "unlocated",
        sourceRef,
        sourcePath: doc.path,
        sourceVersion: doc.version,
        reason: "Selected range does not fall within saved origins",
      };
    }
    const origOrigin = saved.origins[ownerIndex];
    const liveOrigin = matchedSpans[ownerIndex];
    const relFrom = sel.from - origOrigin.range.from;
    const relTo = sel.to - origOrigin.range.from;
    const strippedLen = stripOriginText(origOrigin).length;
    if (relTo > strippedLen && liveOrigin.rawText !== origOrigin.rawText) {
      return {
        entryId: entry.id,
        contentRevision: entry.contentRevision,
        status: "unlocated",
        sourceRef,
        sourcePath: doc.path,
        sourceVersion: doc.version,
        reason: "Selected range overlaps modified block ID suffix",
      };
    }
    const mapped: TextRange = {
      from: liveOrigin.rawRange.from + relFrom,
      to: liveOrigin.rawRange.from + relTo,
    };
    if (
      mapped.from < prevSelEnd ||
      doc.text.slice(mapped.from, mapped.to) !== origOrigin.rawText.slice(relFrom, relTo)
    ) {
      return {
        entryId: entry.id,
        contentRevision: entry.contentRevision,
        status: "unlocated",
        sourceRef,
        sourcePath: doc.path,
        sourceVersion: doc.version,
        reason: "Mapped selection text mismatch",
      };
    }
    mappedSelectedRanges.push(mapped);
    prevSelEnd = mapped.to;
  }

  const relocated = matchedSpans.some(
    (span, index) => span.rawRange.from !== saved.origins[index].range.from,
  );
  return {
    entryId: entry.id,
    contentRevision: entry.contentRevision,
    status: relocated ? "relocated" : "verified",
    sourceRef,
    sourcePath: doc.path,
    sourceVersion: doc.version,
    liveSnapshot,
    liveSpans: matchedSpans,
    mappedOrigins: matchedSpans.map((span) => ({ ...span.rawRange })),
    mappedSelectedRanges,
  };
}

export class EvidenceResolver {
  constructor(private reader: EvidenceReaderPort) {}

  async resolveEntry(entry: EvidenceEntry, signal?: AbortSignal): Promise<ResolvedEvidence> {
    const [result] = await this.resolveBatch([entry], { signal });
    return result;
  }

  async resolveBatch(
    entries: readonly EvidenceEntry[],
    options: ResolveBatchOptions = {},
  ): Promise<ResolvedEvidence[]> {
    const { signal, onProgress, chunkSize = 20 } = options;
    const cache = new Map<string, CachedSource>();
    const results: ResolvedEvidence[] = [];
    const total = entries.length;

    const checkCancelled = () => {
      if (signal?.aborted) throw new CitationError("OPERATION_CANCELLED");
    };

    for (let i = 0; i < entries.length; i++) {
      checkCancelled();
      if (i > 0 && i % chunkSize === 0) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => {
            window.clearTimeout(timer);
            resolve();
          };
          const timer = window.setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 0);
          if (signal?.aborted) {
            onAbort();
          } else {
            signal?.addEventListener("abort", onAbort, { once: true });
          }
        });
        checkCancelled();
      }

      const entry = entries[i];
      const sourcePath = entry.snapshot.source.path;
      if (entry.snapshot.source.identity === "unconfirmed-after-loss") {
        results.push({
          entryId: entry.id,
          contentRevision: entry.contentRevision,
          status: "missing",
          sourcePath,
          reason: "Source identity unconfirmed after prior loss",
        });
        onProgress?.({ checked: i + 1, total });
        continue;
      }

      const sourceRef = this.reader.resolveRef(sourcePath);
      if (!sourceRef) {
        results.push({
          entryId: entry.id,
          contentRevision: entry.contentRevision,
          status: "missing",
          sourcePath,
          reason: "Source file not found",
        });
        onProgress?.({ checked: i + 1, total });
        continue;
      }

      let cached = cache.get(sourceRef);
      if (!cached) {
        try {
          const doc = await this.reader.read(sourceRef, signal);
          checkCancelled();
          const snapshot = this.reader.capture(sourceRef, doc.text);
          cached = { sourceRef, doc, snapshot };
        } catch (error) {
          if (isAbortError(error)) throw new CitationError("OPERATION_CANCELLED");
          const reason = error instanceof CitationError ? error.code : "SOURCE_READ_FAILED";
          cached = { sourceRef, errorStatus: "unavailable", errorReason: reason };
        }
        cache.set(sourceRef, cached);
      }

      if (cached.errorStatus || !cached.doc || !cached.snapshot) {
        results.push({
          entryId: entry.id,
          contentRevision: entry.contentRevision,
          status: "unavailable",
          sourceRef,
          sourcePath,
          reason: cached.errorReason ?? "SOURCE_READ_FAILED",
        });
      } else {
        results.push(resolveAgainstSnapshot(entry, sourceRef, cached.doc, cached.snapshot));
      }

      onProgress?.({ checked: i + 1, total });
    }

    return results;
  }
}
