import { describe, expect, it } from "vitest";
import { citationFixture } from "./support/citations";
import { TFile } from "./support/obsidian";
import { CitationLinkService } from "../src/infra/CitationLinkService";

describe("CitationLinkService", () => {
  it("keeps copies and inserts independent of the target directory, with full Unicode paths", () => {
    const f = citationFixture(); f.sourceFile.path = "研究 资料/Note.md";
    f.files.push(new TFile("Other/Note.md"));
    const links = new CitationLinkService(f.app as never, f.editors as never);
    const copied = links.link("src", "", "a"); const inserted = links.link("src", "Drafts/A.md", "a");
    expect(copied).toBe("[[研究 资料/Note.md#^a]]"); expect(inserted).toBe(copied);
    expect(() => links.validate(`> Body\n> — ${inserted}`, "src", "Drafts/A.md", "#^a")).not.toThrow();
    expect(() => links.validate("[[Note#^a]]", "src", "Drafts/A.md", "#^a")).toThrow("LINK_INVALID");
  });
  it("supports valid legacy wiki and Markdown links, while rejecting the wrong source or anchor", () => {
    const f = citationFixture(); const links = new CitationLinkService(f.app as never, f.editors as never);
    expect(() => links.validate("Body [source](Sources/Note.md#^a)", "src", "", "#^a")).not.toThrow();
    expect(() => links.validate("Body [[Note#^a|Title]]", "src", "", "#^a")).not.toThrow();
    expect(() => links.validate("[[Drafts/A.md#^a]]", "src", "", "#^a")).toThrow();
    expect(() => links.validate("[[Sources/Note.md#^wrong]]", "src", "", "#^a")).toThrow();
  });
  it("rejects malformed source paths and unverifiable headings before returning a link", () => {
    const f = citationFixture(); const links = new CitationLinkService(f.app as never, f.editors as never);
    expect(() => links.link("src", "", undefined, "Missing")).toThrow("LINK_INVALID");
    expect(links.link("src", "", undefined, "Heading")).toBe("[[Sources/Note.md#Heading]]");
    f.sourceFile.path = "Sources/Bad#Name.md"; expect(() => links.link("src", "")).toThrow("LINK_INVALID");
  });
});
