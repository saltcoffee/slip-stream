import { vi } from "vitest";
import { TFile } from "./obsidian";
import { BlockIdService } from "../../src/infra/BlockIdService";
import { CitationLinkService } from "../../src/infra/CitationLinkService";
import { CitationEngine } from "../../src/domain/CitationEngine";
import { CitationRecordsService } from "../../src/domain/CitationRecords";
import { PluginDataStore } from "../../src/infra/PluginDataStore";
import { CitationError, localDate } from "../../src/domain/citationTypes";
import type { CitationIntent, TargetTicket } from "../../src/domain/citationTypes";

export function citationFixture(initial = "Original paragraph") {
  let source = initial;
  const sourceFile = new TFile("Sources/Note.md");
  const a = new TFile("Drafts/A.md");
  const b = new TFile("Drafts/B.md");
  const files = [sourceFile, a, b];
  const bodies: Record<string, string> = { a: "", b: "" };
  const process = vi.fn(async (_file: TFile, update: (text: string) => string) => { source = update(source); return source; });
  const app = {
    vault: { getAbstractFileByPath: (path: string) => files.find((f) => f.path === path) ?? null, getMarkdownFiles: () => files,
      read: async () => source, process },
    metadataCache: { getFileCache: () => ({ headings: [{ heading: "Heading" }] }),
      getFirstLinkpathDest: (path: string) => files.find((f) => f.path === path || f.path.replace(/\.md$/, "") === path || f.basename === path.replace(/\.md$/, "")) ?? null },
  };
  const save = vi.fn(async (_data: unknown) => {});
  const store = new PluginDataStore({ load: async () => null, save, backup: async () => {} });
  store.data.consent.blockIdExplanationAccepted = true;
  const records = new CitationRecordsService(store);
  const path = (ref: string) => {
    const file = { src: sourceFile, a, b }[ref];
    if (!file || !files.includes(file)) throw new CitationError("SOURCE_MISSING");
    return file.path;
  };
  const validate = vi.fn((ticket: TargetTicket) => {
    if (ticket.fileRef !== "src" && bodies[ticket.fileRef] !== ticket.baselineText) throw new CitationError("TARGET_STALE");
  });
  const commit = vi.fn((ticket: TargetTicket, text: string) => {
    validate(ticket);
    bodies[ticket.fileRef] = ticket.baselineText.slice(0, ticket.range.from) + text + ticket.baselineText.slice(ticket.range.to);
    return { targetPath: path(ticket.fileRef), text, range: { from: ticket.range.from, to: ticket.range.from + text.length }, before: "", after: "" };
  });
  const editors = { path, file: (ref: string) => { path(ref); return { src: sourceFile, a, b }[ref]!; }, fileRef: () => "src",
    readSource: vi.fn(async (ref: string) => { path(ref); return source; }), writeSource: vi.fn(() => false), validate, commit, copy: vi.fn(async (_text: string) => {}) };
  const written = vi.fn();
  const sources = new BlockIdService(app as never, editors as never, written);
  const links = new CitationLinkService(app as never, editors as never);
  const engine = new CitationEngine({ settings: () => store.data.settings, consentAccepted: () => store.data.consent.blockIdExplanationAccepted,
    anchorWritesEnabled: () => !store.readOnly, sources, editors, links, records });
  const ticket = (ref = "a"): TargetTicket => ({ fileRef: ref, editorId: `editor:${ref}`, revision: 0, range: { from: bodies[ref]?.length ?? 0, to: bodies[ref]?.length ?? 0 }, baselineText: bodies[ref] ?? source, bindingGeneration: 1 });
  const intent = (overrides: Partial<CitationIntent> = {}): CitationIntent => {
    const snapshot = sources.capture(sourceFile as never, source);
    const first = snapshot.spans.find((span) => span.kind === "paragraph") ?? snapshot.spans[0];
    return { operationId: crypto.randomUUID(), action: "insert", snapshot, spans: [first], mode: "block", content: sources.content(first), templateId: "A", date: localDate(), ...overrides };
  };
  return { app, sources, sourceFile, files, editors, store, records, engine, ticket, intent, process, save, bodies, written,
    read: () => source, write: (value: string) => { source = value; } };
}
