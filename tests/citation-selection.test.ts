// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildEvidenceSnapshot, captureSelection } from "../src/view/CitationSelection";
import type { CitationUnit } from "../src/view/CitationSelection";
import { canonicalSelectionKey, type OriginSpan, type SourceSnapshot } from "../src/domain/citationTypes";
import { isValidEvidenceSnapshot } from "../src/domain/outlineTypes";

const origin = (key: string, from: number, to: number): OriginSpan => ({ blockKey: key, rawRange: { from, to }, rawText: "raw", kind: "paragraph" });
afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function fixture(html = "<p>First <strong>bold</strong><br>line.</p><p>Second paragraph.</p>") {
  const body = document.createElement("div"); body.innerHTML = html; document.body.appendChild(body);
  const units = new Map<HTMLElement, CitationUnit>();
  [...body.children].forEach((el, index) => units.set(el as HTMLElement, { origin: origin(`p${index}`, index * 50, index * 50 + 40), content: el.textContent!, mode: "block", key: `unit${index}` }));
  return { body, units };
}
function select(start: Node, from: number, end: Node, to: number) {
  const range = document.createRange(); range.setStart(start, from); range.setEnd(end, to); document.getSelection()!.addRange(range);
}
describe("CitationSelection", () => {
  it("retains the full cross-paragraph selection and rendered hard line break", () => {
    const f = fixture(); select(f.body.firstChild!.firstChild!, 2, f.body.lastChild!.firstChild!, 6);
    expect(captureSelection(f.body, f.units)).toMatchObject({ content: "rst bold\nline.\n\nSecond", spans: [{ blockKey: "p0" }, { blockKey: "p1" }] });
  });
  it("rejects an endpoint outside the card and selection containing interface controls", () => {
    const f = fixture(); const outside = document.body.appendChild(document.createElement("div")); outside.textContent = "Other";
    select(f.body.firstChild!.firstChild!, 0, outside.firstChild!, 2); expect(() => captureSelection(f.body, f.units)).toThrow("SOURCE_MAPPING_UNSUPPORTED");
    document.getSelection()!.removeAllRanges(); const button = f.body.firstChild!.appendChild(document.createElement("button")); button.textContent = "Action"; button.dataset.noCite = "true";
    select(f.body.firstChild!.firstChild!, 0, button.firstChild!, 3); expect(() => captureSelection(f.body, f.units)).toThrow();
  });
  it.each(['<span class="math">formula</span>', '<span class="internal-embed">dynamic</span>', '<img alt="image">'])("rejects dynamically mapped content %s", (dynamic) => {
    const f = fixture(`<p>Start ${dynamic} end.</p>`); const p = f.body.firstChild!; select(p.firstChild!, 0, p.lastChild!, 5);
    expect(() => captureSelection(f.body, f.units)).toThrow("SOURCE_MAPPING_UNSUPPORTED");
  });
  it("does not trim selected whitespace or start an empty operation", () => {
    const f = fixture("<p> A </p>"); select(f.body.firstChild!.firstChild!, 0, f.body.firstChild!.firstChild!, 3);
    expect(captureSelection(f.body, f.units)?.content).toBe(" A ");
    document.getSelection()!.removeAllRanges(); select(f.body.firstChild!.firstChild!, 0, f.body.firstChild!.firstChild!, 1);
    expect(captureSelection(f.body, f.units)).toBeUndefined();
  });
  it("uses the innermost list origin without duplicating a containing list", () => {
    const f = fixture("<ul><li>Parent<ul><li>Child</li></ul></li><li>Sibling</li></ul>");
    const child = f.body.querySelectorAll("li")[1]; f.units.set(child, { origin: origin("child", 5, 10), content: "Child", mode: "block", key: "child" });
    select(child.firstChild!, 0, child.firstChild!, 5);
    expect(captureSelection(f.body, f.units)).toMatchObject({ content: "Child", spans: [{ blockKey: "child" }] });
  });
  it("ignores renderer indentation between paragraphs", () => {
    const f = fixture("<p>First</p>\n<p>Second</p>");
    select(f.body.firstChild!.firstChild!, 0, f.body.lastChild!.firstChild!, 6);
    expect(captureSelection(f.body, f.units)?.content).toBe("First\n\nSecond");
  });

  it("maps snippet projections and CRLF/Chinese/emoji selections into valid EvidenceSnapshot ranges", () => {
    const text = "Prefix.\r\n\r\n中文 **加粗** 🚀 句子。\r\n\r\n重复句子。";
    const body = document.createElement("div");
    const p = body.appendChild(document.createElement("p"));
    p.textContent = "中文 加粗 🚀 句子。";
    document.body.appendChild(body);
    const originStart = text.indexOf("中文");
    const originEnd = text.indexOf("\r\n\r\n重复");
    const rawText = text.slice(originStart, originEnd);
    const span: OriginSpan = { blockKey: `paragraph:${originStart}`, rawRange: { from: originStart, to: originEnd }, rawText, kind: "paragraph" };
    // Projection skips "**" markers around 加粗
    const projection = [
      originStart, originStart + 1, originStart + 2,
      originStart + 5, originStart + 6,
      originStart + 9, originStart + 10, originStart + 11, originStart + 12,
      originStart + 13, originStart + 14, originStart + 15,
    ];
    const units = new Map<HTMLElement, CitationUnit>([[p, { origin: span, content: p.textContent!, mode: "fragment", key: "excerpt", projection }]]);
    select(p.firstChild!, 3, p.firstChild!, 8);
    const fragment = captureSelection(body, units)!;
    expect(fragment.content).toBe("加粗 🚀");
    expect(fragment.selectedRanges).toEqual([{ from: originStart + 5, to: originStart + 7 }, { from: originStart + 9, to: originStart + 12 }]);
    expect(fragment.selectionKey).toBe(canonicalSelectionKey([span], fragment.selectedRanges));
    expect(fragment.selectionKey).toBe("5-7,9-12");
    const sourceSnapshot: SourceSnapshot = { sourceRef: "ref:a", title: "Note", text, bodyStart: 0, spans: [span] };
    const evidence = buildEvidenceSnapshot({ sourcePath: "Sources/A.md", sourceSnapshot, fragment });
    expect(isValidEvidenceSnapshot(evidence)).toBe(true);
    expect(evidence.origins[0].before).toBe("Prefix.\r\n\r\n");
    expect(evidence.origins[0].after).toBe("\r\n\r\n重复句子。");
  });

});
