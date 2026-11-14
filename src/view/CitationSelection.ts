import { CitationError } from "../domain/citationTypes";
import type { OriginSpan } from "../domain/citationTypes";

export interface CitationUnit {
  origin: OriginSpan;
  content: string;
  mode: "block" | "fragment";
  key: string;
}
export interface CapturedFragment { spans: OriginSpan[]; content: string; mode: "block" | "fragment" | "selection"; selectionKey?: string }
const unsupported = "img,svg,iframe,canvas,.math,.math-block,.math-inline,.internal-embed,.mermaid,[data-cite-unsupported]";

/** Uses the ordered DOM Range, so reverse selections follow exactly the same path. */
export function captureSelection(body: HTMLElement, units: ReadonlyMap<HTMLElement, CitationUnit>, selection = body.ownerDocument.getSelection()): CapturedFragment | undefined {
  if (!selection || !selection.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  if (selection.rangeCount !== 1) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  for (const node of Array.from(body.querySelectorAll(`${unsupported},[data-no-cite]`))) if (range.intersectsNode(node)) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  const nearest = (node: Node): { element: HTMLElement; unit: CitationUnit } | undefined => {
    let el = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
    while (el && body.contains(el)) {
      const unit = units.get(el);
      if (unit) return { element: el, unit };
      el = el.parentElement;
    }
    return;
  };
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node: Node | null;
  const offsets = new Map<HTMLElement, number>();
  const parts: string[] = [];
  const selected: OriginSpan[] = [];
  const positions: Array<[string, number, number]> = [];
  let previousBlock: Element | null | undefined;
  while ((node = walker.nextNode())) {
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR";
    if (node.nodeType !== Node.TEXT_NODE && !isBreak) continue;
    const mapped = nearest(node);
    const text = isBreak ? "\n" : node.textContent ?? "";
    // Ignore renderer indentation between semantic blocks; whitespace inside prose remains intact.
    if (node.nodeType === Node.TEXT_NODE && !text.trim() && node.parentElement?.children.length &&
      !node.parentElement.matches("p,li,pre,h1,h2,h3,h4,h5,h6")) continue;
    const offset = mapped ? offsets.get(mapped.element) ?? 0 : 0;
    if (mapped) offsets.set(mapped.element, offset + text.length);
    if (!range.intersectsNode(node)) continue;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : text.length;
    if (end <= start) continue;
    if (!mapped) { if (text.trim()) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED"); continue; }
    const paragraph = (node.parentElement)?.closest("p,li,h1,h2,h3,h4,h5,h6,pre,.slipstream-citation-content");
    if (parts.length && paragraph !== previousBlock && !parts.at(-1)?.endsWith("\n\n")) parts.push("\n\n");
    parts.push(text.slice(start, end));
    previousBlock = paragraph;
    selected.push(mapped.unit.origin);
    positions.push([mapped.unit.key, offset + start, offset + end]);
  }
  const content = parts.join("");
  if (!content.trim()) return;
  const ordered = [...new Map(selected.map((span) => [span.blockKey, span])).values()].sort((a, b) => a.rawRange.from - b.rawRange.from || b.rawRange.to - a.rawRange.to);
  const spans = ordered.filter((span, index) => !ordered.slice(0, index).some((parent) => parent.rawRange.from <= span.rawRange.from && parent.rawRange.to >= span.rawRange.to));
  if (!spans.length) throw new CitationError("SOURCE_MAPPING_UNSUPPORTED");
  return { spans, content, mode: "selection", selectionKey: JSON.stringify(positions) };
}
