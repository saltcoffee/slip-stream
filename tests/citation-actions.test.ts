// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { performCitation } from "../src/view/CitationActions";
import { CitationError } from "../src/domain/citationTypes";
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
});
