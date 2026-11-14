import { describe, expect, it } from "vitest";
import { citationFixture } from "./support/citations";
import { CitationError } from "../src/domain/citationTypes";

describe("CitationEngine", () => {
  it("isolates duplicate reminders by target and allows a single explicit authorization", async () => {
    const f = citationFixture();
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("a") })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("b") })).effect).toBe("inserted");
    const again = f.intent({ templateId: "B" }); const ticket = f.ticket("a");
    const duplicate = await f.engine.execute(again, { ticket });
    expect(duplicate.code).toBe("DUPLICATE"); expect(f.editors.commit).toHaveBeenCalledTimes(2);
    expect((await f.engine.execute(again, { ticket, duplicateAuthorization: duplicate.duplicateAuthorization })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket("a") })).code).toBe("DUPLICATE");
  });
  it("does not reserve insertion dedupe for copies, including when history is disabled", async () => {
    const f = citationFixture(); f.store.data.settings.historyEnabled = false;
    expect((await f.engine.execute(f.intent({ action: "copy" }))).effect).toBe("copied");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).effect).toBe("inserted");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).code).toBe("DUPLICATE");
    expect(f.store.data.history).toHaveLength(0); expect(f.store.data.relations).toHaveLength(0);
  });
  it("stops stale and deleted sources without any source or target write", async () => {
    const f = citationFixture(); const intent = f.intent(); f.write("New\n\nOriginal paragraph");
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).code).toBe("SOURCE_STALE");
    f.files.splice(f.files.indexOf(f.sourceFile), 1);
    expect((await f.engine.execute(intent, { ticket: f.ticket(), staleSnapshot: true, fallback: "file" })).code).toBe("SOURCE_MISSING");
    expect(f.process).not.toHaveBeenCalled(); expect(f.editors.commit).not.toHaveBeenCalled();
  });
  it("records an explicitly accepted stale fragment as a file-level snapshot", async () => {
    const f = citationFixture(); const intent = f.intent(); f.write("Updated source");
    const result = await f.engine.execute(intent, { ticket: f.ticket(), staleSnapshot: true, fallback: "file" });
    expect(result).toMatchObject({ effect: "inserted", precision: "file", sourceAnchor: "unchanged" });
    expect(f.store.data.relations[0]).toMatchObject({ content: "Original paragraph", sourceState: "stale-snapshot" });
    expect(f.process).not.toHaveBeenCalled();
  });
  it("does not write source IDs while waiting for first-use consent", async () => {
    const f = citationFixture(); f.store.data.consent.blockIdExplanationAccepted = false;
    const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).code).toBe("CONSENT_REQUIRED");
    expect(f.process).not.toHaveBeenCalled();
    await f.store.acceptBlockIds();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).effect).toBe("inserted");
  });
  it("rejects an incompatible C or invalid D before creating source IDs", async () => {
    const f = citationFixture();
    expect((await f.engine.execute(f.intent({ templateId: "C", mode: "selection", content: "Original" }), { ticket: f.ticket() })).code).toBe("TEMPLATE_REQUIRES_BLOCK");
    expect((await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{unknown}}" }), { ticket: f.ticket() })).code).toBe("TEMPLATE_INVALID");
    expect((await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{content}}" }), { ticket: f.ticket() })).code).toBe("LINK_INVALID");
    expect(f.process).not.toHaveBeenCalled();
  });
  it("requires an explicit self-target fallback and never generates an ID", async () => {
    const f = citationFixture(); const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket("src") })).code).toBe("ANCHOR_WRITE_FAILED");
    expect((await f.engine.execute(intent, { ticket: f.ticket("src"), fallback: "file" })).effect).toBe("inserted");
    expect(f.process).not.toHaveBeenCalled();
  });
  it("clipboard rejection creates neither successful history nor dedupe", async () => {
    const f = citationFixture(); f.editors.copy.mockRejectedValueOnce(new CitationError("CLIPBOARD_DENIED"));
    const failed = await f.engine.execute(f.intent({ action: "copy" }));
    expect(failed).toMatchObject({ effect: "none", status: "partial", sourceAnchor: "created", code: "CLIPBOARD_DENIED" });
    expect(f.store.data.history).toHaveLength(0);
    expect((await f.engine.execute(f.intent({ action: "copy" }))).effect).toBe("copied");
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).effect).toBe("inserted");
    expect(f.store.data.history.map((h) => h.action)).toEqual(["insert", "copy"]);
    expect(f.store.data.history[1].targetPath).toBeUndefined();
  });
  it("retains inserted dedupe and retries only records after persistence failure", async () => {
    const f = citationFixture(); f.save.mockRejectedValueOnce(new Error("Disk full"));
    const intent = f.intent();
    const result = await f.engine.execute(intent, { ticket: f.ticket() });
    expect(result).toMatchObject({ effect: "inserted", status: "partial", recording: "pending", code: "RECORD_SAVE_FAILED" });
    expect((await f.engine.execute(f.intent(), { ticket: f.ticket() })).code).toBe("DUPLICATE");
    expect(await f.records.retry(intent.operationId)).toBe("saved");
    await f.engine.execute(intent, { ticket: f.ticket() });
    expect(f.editors.commit).toHaveBeenCalledTimes(1); expect(f.store.data.relations).toHaveLength(1);
  });
  it("rechecks the target after awaited source reads and reports retained source IDs", async () => {
    const f = citationFixture(); const intent = f.intent(); const ticket = f.ticket();
    f.process.mockImplementationOnce(async (_file, update) => { f.write(update(f.read())); f.bodies.a = "Changed during anchor write"; return f.read(); });
    const result = await f.engine.execute(intent, { ticket });
    expect(result).toMatchObject({ sourceAnchor: "created", effect: "none", code: "TARGET_STALE", status: "partial" });
    expect(f.editors.commit).not.toHaveBeenCalled();
  });
  it("does not commit after Escape even if an ID was already written", async () => {
    const f = citationFixture(); const abort = new AbortController();
    f.process.mockImplementationOnce(async (_file, update) => { f.write(update(f.read())); abort.abort(); return f.read(); });
    const result = await f.engine.execute(f.intent(), { ticket: f.ticket(), signal: abort.signal });
    expect(result).toMatchObject({ effect: "none", sourceAnchor: "created", code: "OPERATION_CANCELLED" });
    expect(f.editors.commit).not.toHaveBeenCalled(); expect(f.store.data.history).toHaveLength(0);
  });
  it("coalesces double-click and same-fragment concurrent submissions", async () => {
    const f = citationFixture(); const intent = f.intent(); const options = { ticket: f.ticket() };
    const one = f.engine.execute(intent, options);
    expect(f.engine.execute(intent, options)).toBe(one);
    expect(f.engine.execute({ ...intent, operationId: crypto.randomUUID() }, options)).toBe(one);
    await one; expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });
  it("queues different fragments on one target and rejects the expired second ticket", async () => {
    const f = citationFixture("First\n\nSecond"); const one = f.intent(); const second = one.snapshot.spans[1];
    const results = await Promise.all([f.engine.execute(one, { ticket: f.ticket() }), f.engine.execute(f.intent({ spans: [second], content: "Second" }), { ticket: f.ticket() })]);
    expect(results[0].effect).toBe("inserted"); expect(results[1].code).toBe("TARGET_STALE");
    expect(f.editors.commit).toHaveBeenCalledTimes(1);
  });
  it("continues success recording if a view closes after commit", async () => {
    const f = citationFixture(); const abort = new AbortController();
    f.editors.copy.mockImplementationOnce(async () => { abort.abort(); });
    const result = await f.engine.execute(f.intent({ action: "copy" }), { signal: abort.signal });
    expect(result).toMatchObject({ effect: "copied", recording: "saved", status: "success" });
  });
  it("never automatically repeats an uncertain host commit", async () => {
    const f = citationFixture(); f.editors.commit.mockImplementationOnce(() => { throw new CitationError("COMMIT_STATE_UNCERTAIN"); });
    const intent = f.intent();
    expect((await f.engine.execute(intent, { ticket: f.ticket() })).status).toBe("uncertain");
    await f.engine.execute(intent, { ticket: f.ticket() });
    expect(f.editors.commit).toHaveBeenCalledTimes(1); expect(f.store.data.history).toHaveLength(0);
  });
  it("preflights an explicit file-level custom citation without requiring an existing block subpath", async () => {
    const f = citationFixture("Source paragraph ^a");
    const result = await f.engine.execute(f.intent({ templateId: "D", customTemplate: "{{content}} ([[{{path}}]])" }), { ticket: f.ticket(), fallback: "file" });
    expect(result).toMatchObject({ effect: "inserted", precision: "file" });
    expect(f.editors.commit.mock.calls[0][1]).toBe("Source paragraph ([[Sources/Note.md]])");
    expect(f.process).not.toHaveBeenCalled();
  });

});
