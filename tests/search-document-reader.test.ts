import { describe, expect, it, vi } from "vitest";
import { SearchDocumentReader } from "../src/infra/SearchDocumentReader";

describe("SearchDocumentReader", () => {
  it("does not cache content that changed during the read as the current version", async () => {
    let content = "Alpha";
    let first = true;
    let reader!: SearchDocumentReader;
    const editors = {
      readSource: vi.fn(async () => {
        const value = content;
        if (first) { first = false; reader.invalidate("r"); content = "Changed"; }
        return value;
      }),
      path: () => "a.md",
    };
    reader = new SearchDocumentReader(editors as never);
    const firstDoc = await reader.read("r");
    expect(firstDoc.text).toBe("Alpha");
    expect(firstDoc.version).toBe(0);
    expect(reader.version("r")).toBe(1);
    const secondDoc = await reader.read("r");
    expect(secondDoc.text).toBe("Changed");
    expect(secondDoc.version).toBe(1);
  });

  it("does not read a queued source after its query is cancelled", async () => {
    const resolvers: Array<() => void> = [];
    const editors = {
      readSource: vi.fn((ref: string) => new Promise<string>((resolve) => { resolvers.push(() => resolve(`text:${ref}`)); })),
      path: () => "a.md",
    };
    const reader = new SearchDocumentReader(editors as never);
    const running = [reader.read("a"), reader.read("b"), reader.read("c")];
    await vi.waitFor(() => expect(editors.readSource).toHaveBeenCalledTimes(3));
    const controller = new AbortController();
    const queued = reader.read("d", controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(editors.readSource).not.toHaveBeenCalledWith("d");
    resolvers.forEach((resolve) => resolve());
    await Promise.all(running);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const editors = { readSource: vi.fn(async () => "text"), path: () => "a.md" };
    const reader = new SearchDocumentReader(editors as never);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read("a", controller.signal)).rejects.toThrow();
    expect(editors.readSource).not.toHaveBeenCalled();
  });
});
