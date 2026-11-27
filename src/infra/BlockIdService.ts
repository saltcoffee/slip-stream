import { getFrontMatterInfo } from "obsidian";
import type { App, TFile } from "obsidian";
import { mapBlocks, groupRenderUnits, originOf, standaloneId } from "../domain/BlockMapper";
import { canCreateBlockId, inlineBlockId, stripInlineBlockId } from "../domain/BlockReference";
import { computeTargetInsertion } from "../domain/CitationDocument";
import { CitationError, validRange } from "../domain/citationTypes";
import type { OriginSpan, Precision, SourceSnapshot, TextRange } from "../domain/citationTypes";
import type { EditorGateway } from "./EditorGateway";

interface KnownEdit { before: string; after: string; range: TextRange; text: string }
export interface SourceInspection { text: string; spans: OriginSpan[]; id?: string; canCreate: boolean; heading?: string }
export interface AnchorResult extends SourceInspection { kind: "reused" | "created" | "unavailable"; sourceAfter: string }

export interface AnchorEdit {
  blockKey: string;
  anchorId: string;
  range: TextRange;
  text: string;
  inline: boolean;
}

export interface AnchorPlanRequest {
  itemId: string;
  snapshot: SourceSnapshot;
  spans: readonly OriginSpan[];
  allowNew: boolean;
  fallback?: "heading" | "file";
}

export interface PlannedItemAnchor {
  itemId: string;
  blockKey: string;
  kind: "reused" | "planned" | "unavailable";
  id?: string;
  heading?: string;
  canCreate: boolean;
}

export interface SourceAnchorPlan {
  planId: string;
  sourceRef: string;
  sourcePath: string;
  baseline: string;
  bodyStart: number;
  expectedAfter: string;
  edits: readonly AnchorEdit[];
  items: readonly PlannedItemAnchor[];
}

export interface AppliedAnchorPlan {
  planId: string;
  sourceRef: string;
  sourcePath: string;
  baseline: string;
  sourceAfter: string;
  createdIds: readonly string[];
  reusedIds: readonly string[];
  editsApplied: number;
}

export interface SelfTargetPredictionInput {
  baselineText: string;
  bodyStart: number;
  ticketRange: TextRange;
  compiledMarkdown: string;
  block?: boolean;
  items: readonly {
    itemId: string;
    spans: readonly OriginSpan[];
    expectedBlockId?: string;
    expectedHeading?: string;
    precision: Precision;
  }[];
}

export interface SelfTargetConflict {
  code: "SELF_SOURCE_CONFLICT";
  itemId: string;
  reason: string;
}

export interface SelfTargetItemMapping {
  itemId: string;
  mappedSpans: readonly { range: TextRange; rawText: string; kind: OriginSpan["kind"] }[];
}

export interface SelfTargetPredictionResult {
  predictedText: string;
  conflicts: readonly SelfTargetConflict[];
  mappings: ReadonlyMap<string, SelfTargetItemMapping>;
}

const BLOCK_ID_MARKER_RE = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*(?=\r?$)/gm;

function applyEditsReverse(baseline: string, edits: readonly AnchorEdit[]): string {
  let result = baseline;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    result = result.slice(0, edit.range.from) + edit.text + result.slice(edit.range.to);
  }
  return result;
}

export class BlockIdService {
  private queues = new Map<string, Promise<unknown>>();
  private snapshots = new Map<string, Set<WeakRef<SourceSnapshot>>>();
  private resolved = new WeakMap<SourceSnapshot, { text: string; spans: Map<string, OriginSpan> }>();
  constructor(private app: App, private editors: EditorGateway, private onWritten?: (path: string) => void) {}

  capture(file: TFile, text: string, title = file.basename): SourceSnapshot {
    const bodyStart = getFrontMatterInfo(text).contentStart;
    const blocks = mapBlocks(text, bodyStart);
    const units = groupRenderUnits(blocks, text.split("\n"));
    const spans = [...blocks.map(originOf), ...units.filter((unit) => unit.type === "list").map((unit) => {
      const origin = originOf(unit);
      origin.rawText = text.slice(origin.rawRange.from, origin.rawRange.to);
      origin.existingBlockId = standaloneId(text, origin.rawRange.to);
      return origin;
    })];
    for (const span of spans) {
      span.existingBlockId = this.existingId(text, span, file);
      if (span.heading && blocks.filter((block) => block.type === "heading" && block.heading === span.heading).length !== 1) span.heading = undefined;
    }
    const snapshot = { sourceRef: this.editors.fileRef(file), title, text, bodyStart, spans };
    const refs = this.snapshots.get(snapshot.sourceRef) ?? new Set<WeakRef<SourceSnapshot>>();
    for (const ref of refs) if (!ref.deref()) refs.delete(ref);
    refs.add(new WeakRef(snapshot)); this.snapshots.set(snapshot.sourceRef, refs);
    this.resolved.set(snapshot, { text, spans: new Map(spans.map((span) => [span.blockKey, span])) });
    return snapshot;
  }

  async inspect(snapshot: SourceSnapshot, selected: readonly OriginSpan[]): Promise<SourceInspection> {
    if (!selected.length || selected.some((span) => !validRange(span.rawRange, snapshot.text.length) || span.rawRange.from < snapshot.bodyStart ||
      snapshot.text.slice(span.rawRange.from, span.rawRange.to) !== span.rawText || !snapshot.spans.some((item) => item.blockKey === span.blockKey && item.rawText === span.rawText && item.rawRange.from === span.rawRange.from && item.rawRange.to === span.rawRange.to))) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
    for (let i = 1; i < selected.length; i++) if (selected[i].rawRange.from < selected[i - 1].rawRange.to) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
    const resolved = this.resolved.get(snapshot);
    const text = resolved?.text ?? snapshot.text;
    const spans = selected.map((span) => ({ ...(resolved?.spans.get(span.blockKey) ?? span), rawRange: { ...(resolved?.spans.get(span.blockKey) ?? span).rawRange } }));
    const current = await this.editors.readSource(snapshot.sourceRef);
    if (text !== current) throw new CitationError("SOURCE_STALE");
    const first = spans[0];
    const id = this.existingId(text, first, this.editors.file(snapshot.sourceRef));
    const marker = inlineBlockId(first.rawText, first.kind) ?? (first.kind !== "list_item" ? standaloneId(text, first.rawRange.to) : undefined);
    const canCreate = canCreateBlockId(first.kind, first.rawText) && !marker;
    return { text, spans, id, canCreate, heading: first.heading };
  }

  private existingId(text: string, span: OriginSpan, file: TFile): string | undefined {
    const cache = this.app.metadataCache.getFileCache(file);
    const cachedId = span.kind === "list_item" ? Object.values(cache?.blocks ?? {}).find((block) =>
      (block.position.start.offset === span.rawRange.from || block.position.start.line === text.slice(0, span.rawRange.from).split("\n").length - 1) &&
      span.rawText.split(/\r?\n/).some((line) => line.match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/)?.[1] === block.id))?.id : undefined;
    const id = inlineBlockId(span.rawText, span.kind) ?? (span.kind !== "list_item" ? standaloneId(text, span.rawRange.to) : undefined) ?? cachedId;
    if (!id) return;
    const markers = [...text.matchAll(BLOCK_ID_MARKER_RE)];
    return markers.filter((marker) => marker[1] === id).length === 1 ? id : undefined;
  }

  /** Read-only anchor planning across multiple items; never writes files or remaps snapshots. */
  async prepareMany(requests: readonly AnchorPlanRequest[]): Promise<SourceAnchorPlan[]> {
    const bySource = new Map<string, AnchorPlanRequest[]>();
    for (const req of requests) {
      const list = bySource.get(req.snapshot.sourceRef) ?? [];
      list.push(req);
      bySource.set(req.snapshot.sourceRef, list);
    }

    const sortedEntries = [...bySource.entries()].sort((a, b) =>
      this.editors.path(a[0]).localeCompare(this.editors.path(b[0])),
    );

    const plans: SourceAnchorPlan[] = [];
    for (const [sourceRef, group] of sortedEntries) {
      const sourcePath = this.editors.path(sourceRef);
      let baseline: string | undefined;
      let bodyStart = 0;
      const usedIds = new Set<string>();
      const plannedByBlock = new Map<string, { id: string; edit: AnchorEdit }>();
      const items: PlannedItemAnchor[] = [];

      for (const req of group) {
        const inspected = await this.inspect(req.snapshot, req.spans);
        if (baseline === undefined) {
          baseline = inspected.text;
          bodyStart = req.snapshot.bodyStart;
          for (const match of baseline.matchAll(/\^([A-Za-z0-9-]+)/g)) usedIds.add(match[1]);
        } else if (inspected.text !== baseline) {
          throw new CitationError("SOURCE_STALE");
        }
        const first = inspected.spans[0];
        if (req.spans[0]?.existingBlockId && !inspected.id && !req.fallback) {
          throw new CitationError("ANCHOR_WRITE_FAILED");
        }

        if (req.fallback) {
          items.push({
            itemId: req.itemId,
            blockKey: first.blockKey,
            kind: "unavailable",
            heading: req.fallback === "file" ? undefined : inspected.heading,
            canCreate: inspected.canCreate,
          });
        } else if (inspected.id) {
          items.push({
            itemId: req.itemId,
            blockKey: first.blockKey,
            kind: "reused",
            id: inspected.id,
            heading: inspected.heading,
            canCreate: inspected.canCreate,
          });
        } else if (req.allowNew && inspected.canCreate) {
          let planned = plannedByBlock.get(first.blockKey);
          if (!planned) {
            const id = this.uniqueId(usedIds);
            usedIds.add(id);
            const edit = this.buildAnchorEdit(baseline, first, id);
            planned = { id, edit };
            plannedByBlock.set(first.blockKey, planned);
          }
          items.push({
            itemId: req.itemId,
            blockKey: first.blockKey,
            kind: "planned",
            id: planned.id,
            heading: inspected.heading,
            canCreate: true,
          });
        } else {
          items.push({
            itemId: req.itemId,
            blockKey: first.blockKey,
            kind: "unavailable",
            heading: inspected.heading,
            canCreate: inspected.canCreate,
          });
        }
      }

      const edits = [...plannedByBlock.values()]
        .map((entry) => entry.edit)
        .sort((a, b) => a.range.from - b.range.from || (a.inline === b.inline ? 0 : a.inline ? -1 : 1));
      const baseText = baseline ?? "";
      const expectedAfter = applyEditsReverse(baseText, edits);
      plans.push({
        planId: crypto.randomUUID(),
        sourceRef,
        sourcePath,
        baseline: baseText,
        bodyStart,
        expectedAfter,
        edits,
        items,
      });
    }
    return plans;
  }

  /** Verifies that an observed document string matches the exact result of applying this plan. */
  matchesPlannedResult(plan: SourceAnchorPlan, currentText: string): boolean {
    return currentText === plan.expectedAfter;
  }

  /** Verifies that a planned source still exists at its expected path and matches its planned post-edit content. */
  async verifyPlanned(plan: SourceAnchorPlan): Promise<void> {
    this.assertPlannedPath(plan);
    const currentText = await this.readPlannedSource(plan.sourceRef);
    if (!this.matchesPlannedResult(plan, currentText)) {
      throw new CitationError("SOURCE_STALE");
    }
  }

  private assertPlannedPath(plan: SourceAnchorPlan): void {
    let currentPath: string;
    try {
      currentPath = this.editors.path(plan.sourceRef);
    } catch (error) {
      if (error instanceof CitationError && error.code === "SOURCE_MISSING") {
        throw new CitationError("SOURCE_STALE");
      }
      throw error;
    }
    if (currentPath !== plan.sourcePath) {
      throw new CitationError("SOURCE_STALE");
    }
  }

  private async readPlannedSource(sourceRef: string): Promise<string> {
    try {
      return await this.editors.readSource(sourceRef);
    } catch (error) {
      if (error instanceof CitationError && error.code === "SOURCE_MISSING") {
        throw new CitationError("SOURCE_STALE");
      }
      throw error;
    }
  }

  /** Applies a previously planned anchor set inside the per-source write queue. */
  async ensurePlanned(plan: SourceAnchorPlan, cancelled: () => boolean): Promise<AppliedAnchorPlan> {
    const previous = this.queues.get(plan.sourceRef) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async (): Promise<AppliedAnchorPlan> => {
      if (cancelled()) throw new CitationError("OPERATION_CANCELLED");
      this.assertPlannedPath(plan);
      const current = await this.readPlannedSource(plan.sourceRef);
      if (current !== plan.baseline || getFrontMatterInfo(current).contentStart !== plan.bodyStart) {
        throw new CitationError("SOURCE_STALE");
      }
      const reusedIds = [...new Set(plan.items.filter((item) => item.kind === "reused" && item.id).map((item) => item.id!))];
      if (plan.edits.length === 0) {
        return {
          planId: plan.planId,
          sourceRef: plan.sourceRef,
          sourcePath: plan.sourcePath,
          baseline: plan.baseline,
          sourceAfter: current,
          createdIds: [],
          reusedIds,
          editsApplied: 0,
        };
      }

      const existingIds = new Set([...current.matchAll(/\^([A-Za-z0-9-]+)/g)].map((m) => m[1]));
      const seenPlanned = new Set<string>();
      for (const edit of plan.edits) {
        if (existingIds.has(edit.anchorId) || seenPlanned.has(edit.anchorId)) {
          throw new CitationError("ANCHOR_WRITE_FAILED");
        }
        seenPlanned.add(edit.anchorId);
      }

      const expected = applyEditsReverse(plan.baseline, plan.edits);
      const minFrom = plan.edits[0].range.from;
      const maxTo = plan.edits[plan.edits.length - 1].range.to;
      const tailLen = plan.baseline.length - maxTo;
      const combinedRange = { from: minFrom, to: maxTo };
      const combinedText = expected.slice(minFrom, expected.length - tailLen);

      await this.writeAndVerify(plan.sourceRef, plan.bodyStart, plan.baseline, combinedRange, combinedText, expected, cancelled);

      // Replay known edits back-to-front so every live snapshot remaps identically to the combined write.
      let running = plan.baseline;
      for (let i = plan.edits.length - 1; i >= 0; i--) {
        const edit = plan.edits[i];
        const next = running.slice(0, edit.range.from) + edit.text + running.slice(edit.range.to);
        this.remapSnapshots(plan.sourceRef, { before: running, after: next, range: edit.range, text: edit.text });
        running = next;
      }
      this.onWritten?.(this.editors.path(plan.sourceRef));
      return {
        planId: plan.planId,
        sourceRef: plan.sourceRef,
        sourcePath: plan.sourcePath,
        baseline: plan.baseline,
        sourceAfter: expected,
        createdIds: plan.edits.map((e) => e.anchorId),
        reusedIds,
        editsApplied: plan.edits.length,
      };
    });
    this.queues.set(plan.sourceRef, job);
    try { return await job; } finally { if (this.queues.get(plan.sourceRef) === job) this.queues.delete(plan.sourceRef); }
  }

  async ensure(snapshot: SourceSnapshot, selected: readonly OriginSpan[], allowNew: boolean, cancelled: () => boolean): Promise<AnchorResult> {
    const previous = this.queues.get(snapshot.sourceRef) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async (): Promise<AnchorResult> => {
      const inspected = await this.inspect(snapshot, selected);
      if (cancelled()) throw new CitationError("OPERATION_CANCELLED");
      if (inspected.id) return { ...inspected, kind: "reused", sourceAfter: inspected.text };
      if (!allowNew || !inspected.canCreate) return { ...inspected, kind: "unavailable", sourceAfter: inspected.text };
      const span = inspected.spans[0];
      const used = new Set([...inspected.text.matchAll(/\^([A-Za-z0-9-]+)/g)].map((match) => match[1]));
      const id = this.uniqueId(used);
      const edit = this.buildAnchorEdit(inspected.text, span, id);
      const expected = inspected.text.slice(0, edit.range.from) + edit.text + inspected.text.slice(edit.range.to);
      await this.writeAndVerify(snapshot.sourceRef, snapshot.bodyStart, inspected.text, edit.range, edit.text, expected, cancelled);
      this.remapSnapshots(snapshot.sourceRef, { before: inspected.text, after: expected, range: edit.range, text: edit.text });
      this.onWritten?.(this.editors.path(snapshot.sourceRef));
      return { ...inspected, kind: "created", id, sourceAfter: expected };
    });
    this.queues.set(snapshot.sourceRef, job);
    try { return await job; } finally { if (this.queues.get(snapshot.sourceRef) === job) this.queues.delete(snapshot.sourceRef); }
  }

  /** Predicts whether inserting into the source note itself preserves each item's source blocks and anchors (AC-40). */
  predictSelfTarget(input: SelfTargetPredictionInput): SelfTargetPredictionResult {
    const plan = computeTargetInsertion(input.baselineText, input.ticketRange, input.compiledMarkdown, input.block ?? true);
    const editFrom = plan.range.from;
    const editTo = plan.range.to;
    const delta = plan.text.length - (editTo - editFrom);
    const predictedText = input.baselineText.slice(0, editFrom) + plan.text + input.baselineText.slice(editTo);
    const conflicts: SelfTargetConflict[] = [];
    const mappings = new Map<string, SelfTargetItemMapping>();

    const predictedBodyStart = getFrontMatterInfo(predictedText).contentStart;
    if (predictedBodyStart !== input.bodyStart) {
      for (const item of input.items) {
        conflicts.push({ code: "SELF_SOURCE_CONFLICT", itemId: item.itemId, reason: "Target edit changes frontmatter boundary" });
      }
      return { predictedText, conflicts, mappings };
    }

    const predictedBlocks = mapBlocks(predictedText, predictedBodyStart);
    const predictedUnits = groupRenderUnits(predictedBlocks, predictedText.split("\n"));
    const allPredicted: OriginSpan[] = [
      ...predictedBlocks.map(originOf),
      ...predictedUnits.filter((u) => u.type === "list").map((u) => {
        const origin = originOf(u);
        origin.rawText = predictedText.slice(origin.rawRange.from, origin.rawRange.to);
        origin.existingBlockId = standaloneId(predictedText, origin.rawRange.to);
        return origin;
      }),
    ];
    const allMarkerMatches = [...predictedText.matchAll(BLOCK_ID_MARKER_RE)];

    for (const item of input.items) {
      let conflictReason: string | undefined;
      const mappedSpans: Array<{ range: TextRange; rawText: string; kind: OriginSpan["kind"] }> = [];

      for (const span of item.spans) {
        const overlapsSpan = editFrom < editTo
          ? editFrom < span.rawRange.to && editTo > span.rawRange.from
          : span.rawRange.from < editFrom && editFrom < span.rawRange.to;
        if (overlapsSpan) {
          conflictReason = "Target insertion or replacement overlaps cited source block";
          break;
        }

        if (span.kind !== "list_item") {
          const standaloneMatch = input.baselineText.slice(span.rawRange.to).match(/^((?:\r?\n)[ \t]*(?:\r?\n)[ \t\r\n]*\^([A-Za-z0-9-]+)[ \t]*)(?=\r?\n|$)/);
          if (standaloneMatch) {
            const idStart = span.rawRange.to;
            const idEnd = idStart + standaloneMatch[1].length;
            const touchesStandalone = editFrom < editTo
              ? editFrom < idEnd && editTo > idStart
              : idStart <= editFrom && editFrom < idEnd;
            if (touchesStandalone) {
              conflictReason = "Target edit overwrites or detaches standalone block ID";
              break;
            }
          }
        }

        let mappedRange: TextRange;
        if (span.rawRange.to <= editFrom) {
          mappedRange = { from: span.rawRange.from, to: span.rawRange.to };
        } else if (span.rawRange.from >= editTo) {
          mappedRange = { from: span.rawRange.from + delta, to: span.rawRange.to + delta };
        } else {
          conflictReason = "Target edit spans across cited source block boundary";
          break;
        }

        const matched = allPredicted.find(
          (candidate) =>
            candidate.kind === span.kind &&
            candidate.rawRange.from === mappedRange.from &&
            candidate.rawRange.to === mappedRange.to,
        );
        if (!matched || matched.rawText !== span.rawText || predictedText.slice(mappedRange.from, mappedRange.to) !== span.rawText) {
          conflictReason = "Source block structure or content changed after predicted target insertion";
          break;
        }
        mappedSpans.push({ range: mappedRange, rawText: matched.rawText, kind: matched.kind });
      }

      if (!conflictReason && mappedSpans.length > 0) {
        const firstMapped = mappedSpans[0];
        const firstOriginal = item.spans[0];
        if (item.expectedBlockId && (item.precision === "block" || item.precision === "fragment" || item.precision === "multi-block-start")) {
          const resolvedId = inlineBlockId(firstMapped.rawText, firstMapped.kind) ??
            (firstMapped.kind !== "list_item" ? standaloneId(predictedText, firstMapped.range.to) : undefined) ??
            (firstOriginal.existingBlockId === item.expectedBlockId ? firstOriginal.existingBlockId : undefined);
          const uniqueCount = allMarkerMatches.filter((m) => m[1] === item.expectedBlockId).length;
          if (resolvedId !== item.expectedBlockId || uniqueCount !== 1) {
            conflictReason = "Block ID anchor is no longer unique or attached to the cited block";
          }
        } else if (item.precision === "heading" && item.expectedHeading) {
          const matchedBlock = predictedBlocks.find(
            (b) => b.rawRange.from === firstMapped.range.from && b.rawRange.to === firstMapped.range.to,
          );
          const headingCount = predictedBlocks.filter(
            (b) => b.type === "heading" && b.heading === item.expectedHeading,
          ).length;
          if (!matchedBlock || matchedBlock.heading !== item.expectedHeading || headingCount !== 1) {
            conflictReason = "Source heading is missing or no longer unique after target insertion";
          }
        }
      }

      if (conflictReason) {
        conflicts.push({ code: "SELF_SOURCE_CONFLICT", itemId: item.itemId, reason: conflictReason });
      } else {
        mappings.set(item.itemId, { itemId: item.itemId, mappedSpans });
      }
    }

    return { predictedText, conflicts, mappings };
  }

  private buildAnchorEdit(baseline: string, span: OriginSpan, id: string): AnchorEdit {
    const newline = baseline.includes("\r\n") ? "\r\n" : "\n";
    const suffix = baseline.slice(span.rawRange.to);
    const padding = suffix.startsWith(newline + newline) ? "" : suffix.startsWith(newline) ? newline : newline + newline;
    const inline = span.kind === "paragraph" || span.kind === "list_item";
    const text = inline ? ` ^${id}` : `${newline}${newline}^${id}${padding}`;
    return {
      blockKey: span.blockKey,
      anchorId: id,
      range: { from: span.rawRange.to, to: span.rawRange.to },
      text,
      inline,
    };
  }

  private async writeAndVerify(
    sourceRef: string,
    bodyStart: number,
    baseline: string,
    range: TextRange,
    text: string,
    expected: string,
    cancelled: () => boolean,
  ): Promise<void> {
    let failure: unknown;
    try {
      if (!this.editors.writeSource(sourceRef, baseline, range, text)) {
        await this.app.vault.process(this.editors.file(sourceRef), (current) => {
          if (cancelled()) throw new CitationError("OPERATION_CANCELLED");
          if (current !== baseline || getFrontMatterInfo(current).contentStart !== bodyStart) throw new CitationError("SOURCE_STALE");
          return expected;
        });
      }
    } catch (error) { failure = error; }
    let actual: string;
    try { actual = await this.editors.readSource(sourceRef); }
    catch { throw new CitationError("COMMIT_STATE_UNCERTAIN"); }
    if (actual !== expected) {
      if (failure instanceof CitationError && ["SOURCE_STALE", "SOURCE_AMBIGUOUS", "SOURCE_MISSING", "OPERATION_CANCELLED"].includes(failure.code)) throw failure;
      if (actual !== baseline) throw new CitationError("COMMIT_STATE_UNCERTAIN");
      if (failure instanceof CitationError) throw failure;
      throw new CitationError("ANCHOR_WRITE_FAILED");
    }
  }

  private remapSnapshots(sourceRef: string, edit: KnownEdit): void {
    const refs = this.snapshots.get(sourceRef);
    for (const ref of refs ?? []) {
      const snapshot = ref.deref();
      if (!snapshot) { refs?.delete(ref); continue; }
      const resolved = this.resolved.get(snapshot)!;
      if (resolved.text !== edit.before) continue;
      resolved.spans = new Map([...resolved.spans].map(([key, span]) => {
        const from = span.rawRange.from >= edit.range.from ? span.rawRange.from + edit.text.length : span.rawRange.from;
        const to = span.rawRange.to > edit.range.from || span.rawRange.to === edit.range.from && edit.text.startsWith(" ^") ? span.rawRange.to + edit.text.length : span.rawRange.to;
        return [key, { ...span, rawRange: { from, to }, rawText: edit.after.slice(from, to) }];
      }));
      resolved.text = edit.after;
    }
  }

  private uniqueId(used: Set<string>): string {
    let id: string;
    do { id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36]).join(""); } while (used.has(id));
    return id;
  }

  content(span: OriginSpan): string { return stripInlineBlockId(span.rawText, span.kind, span.existingBlockId); }
}
