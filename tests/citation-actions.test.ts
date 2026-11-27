// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CitationActions, performCitation } from "../src/view/CitationActions";
import { canonicalSelectionKey, CitationError } from "../src/domain/citationTypes";
import { setLanguage, t } from "../src/util/i18n";
import { installObsidianDom } from "./support/dom";
import { citationFixture } from "./support/citations";

installObsidianDom();
afterEach(() => { setLanguage("auto"); document.body.replaceChildren(); });
const failed = { operationId: "op", status: "blocked", sourceAnchor: "unchanged", effect: "none", recording: "not-attempted", precision: "file", code: "TARGET_STALE" };
function fixture(outcomes: any[]) {
  const f = citationFixture();
  const execute = vi.fn(); outcomes.forEach((outcome) => execute.mockResolvedValueOnce(outcome));
  const retry = vi.fn(async () => "saved");
  const plugin = { app: f.app, cite: { execute }, editors: f.editors, history: { retry } };
  const feedback = document.createElement("div"); document.body.appendChild(feedback);
  return { ...f, execute, retry, plugin, feedback };
}

describe("citation result feedback", () => {
  it.each(["en", "zh"] as const)("reports copy/record partial success in %s and retries only records", async (language) => {
    setLanguage(language);
    const f = fixture([{ ...failed, status: "partial", effect: "copied", recording: "pending", code: "RECORD_SAVE_FAILED" }]);
    const intent = f.intent({ action: "copy" });
    await performCitation(f.plugin as never, intent, f.feedback, undefined, new AbortController().signal, () => {}, () => {});
    expect(f.feedback.textContent).toContain(t("citation.copyRecordFailed"));
    expect(f.feedback.textContent).not.toContain(t("error.RECORD_SAVE_FAILED"));
    [...f.feedback.querySelectorAll("button")].find((button) => button.textContent === t("citation.retryRecord"))!.click();
    await vi.waitFor(() => expect(f.feedback.textContent).toBe(t("citation.recordSaved")));
    expect(f.retry).toHaveBeenCalledWith(intent.operationId); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("uses the latest user-confirmed target position when retrying a click citation", async () => {
    const f = fixture([failed, { ...failed, status: "success", effect: "inserted", code: undefined }]);
    const oldTicket = f.ticket(); const latest = { ...oldTicket, revision: 3, baselineText: "New draft", range: { from: 4, to: 4 } };
    await performCitation(f.plugin as never, f.intent(), f.feedback, oldTicket, new AbortController().signal, () => {}, () => {}, () => latest);
    [...f.feedback.querySelectorAll("button")].find((button) => button.textContent === t("common.retry"))!.click();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
    expect(f.execute.mock.calls[1][1].ticket).toEqual(latest);
  });
  it("requires a new drop for an expired drop position", async () => {
    const f = fixture([failed]);
    await performCitation(f.plugin as never, f.intent(), f.feedback, f.ticket(), new AbortController().signal, () => {}, () => {});
    expect([...f.feedback.querySelectorAll("button")].some((button) => button.textContent === t("common.retry"))).toBe(false);
    expect(f.feedback.textContent).toContain(t("target.show"));
  });
  it.each(["en", "zh"] as const)("keeps target navigation failures localized in %s", async (language) => {
    setLanguage(language); const f = fixture([{ ...failed, status: "success", effect: "inserted", code: undefined }]);
    await performCitation(f.plugin as never, f.intent(), f.feedback, f.ticket(), new AbortController().signal,
      () => { throw new CitationError("TARGET_MISSING"); }, () => {});
    [...f.feedback.querySelectorAll("button")].find((button) => button.textContent === t("target.show"))!.click();
    expect(f.feedback.textContent).toBe(t("error.TARGET_MISSING"));
  });

  it("collects via Add to outline without calling CitationEngine.execute, clipboard, or BlockIdService.ensure", async () => {
    setLanguage("en");
    const f = fixture([]);
    const snapshot = f.sources.capture(f.sourceFile as never, f.read());
    const ensureSpy = vi.spyOn(f.sources, "ensure");
    const copySpy = vi.spyOn(f.editors, "copy");
    const body = document.createElement("div");
    const p = body.createEl("p", { text: "Original paragraph" });
    const controls = document.createElement("div");
    const feedback = document.createElement("div");
    document.body.append(body, controls, feedback);
    const onCollect = vi.fn(async () => {});
    const actions = new CitationActions(
      { ...f.plugin, blockIds: f.sources, store: f.store, settings: f.store.data.settings } as never,
      snapshot,
      body,
      controls,
      () => undefined,
      () => {},
      feedback,
      onCollect,
    );
    actions.addUnit(p, { origin: snapshot.spans[0], content: "Original paragraph", mode: "block", key: "paragraph" });
    controls.querySelector<HTMLButtonElement>(".slipstream-paragraph-action")!.click();
    const addBtn = [...controls.querySelectorAll<HTMLButtonElement>(".slipstream-citation-actions button")].find((b) => b.textContent === t("outline.addToOutline"))!;
    expect(addBtn).toBeTruthy();
    addBtn.click();
    await vi.waitFor(() => expect(onCollect).toHaveBeenCalledOnce());
    expect(f.execute).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    actions.destroy();
  });

  it("computes canonical selectionKey in addUnit and fragment with and without projection", () => {
    setLanguage("en");
    const f = fixture([]);
    const snapshot = f.sources.capture(f.sourceFile as never, f.read());
    const span = snapshot.spans[0];
    const body = document.createElement("div");
    const pProj = body.createEl("p", { text: "Projected" });
    const pNoProj = body.createEl("p", { text: "Full" });
    const controls = document.createElement("div");
    const feedback = document.createElement("div");
    document.body.append(body, controls, feedback);
    const actions = new CitationActions(
      { ...f.plugin, blockIds: f.sources, store: f.store, settings: f.store.data.settings } as never,
      snapshot,
      body,
      controls,
      () => undefined,
      () => {},
      feedback,
    );
    const projOffsets = [span.rawRange.from + 2, span.rawRange.from + 3, span.rawRange.from + 4];
    actions.addUnit(pProj, { origin: span, content: "Projected", mode: "fragment", key: "proj-key", projection: projOffsets });
    actions.addUnit(pNoProj, { origin: span, content: "Full", mode: "fragment", key: "noproj-key" });

    const projFrag = actions.fragment(pProj)!;
    expect(projFrag.selectedRanges).toEqual([{ from: span.rawRange.from + 2, to: span.rawRange.from + 5 }]);
    expect(projFrag.selectionKey).toBe(canonicalSelectionKey([span], projFrag.selectedRanges));

    const noProjFrag = actions.fragment(pNoProj)!;
    expect(noProjFrag.selectedRanges).toEqual([{ from: span.rawRange.from, to: span.rawRange.from + "Original paragraph".length }]);
    expect(noProjFrag.selectionKey).toBe(canonicalSelectionKey([span], noProjFrag.selectedRanges));

    controls.querySelectorAll<HTMLButtonElement>(".slipstream-paragraph-action")[0].click();
    expect(actions.activeFragment()?.selectionKey).toBe(projFrag.selectionKey);
    controls.querySelectorAll<HTMLButtonElement>(".slipstream-paragraph-action")[1].click();
    expect(actions.activeFragment()?.selectionKey).toBe(noProjFrag.selectionKey);
    actions.destroy();
  });
});
