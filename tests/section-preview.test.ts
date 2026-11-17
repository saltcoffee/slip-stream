// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderSectionPreview } from "../src/view/SectionPreview";
import { installObsidianDom } from "./support/dom";

installObsidianDom();

describe("SectionPreview", () => {
  it("starts near the hit and provides both continuations until the whole source is readable", () => {
    const text = "START context\n" + "x".repeat(3500) + "\nneedle\n" + "y".repeat(3500) + "\nEND context";
    const container = document.createElement("div");
    const from = text.indexOf("needle");
    renderSectionPreview(container, text, [{ from, to: from + 6 }]);
    expect(container.querySelector("pre")!.textContent!.length).toBe(3000);
    expect(container.querySelector("mark")?.textContent).toBe("needle");
    expect(container.querySelectorAll("button")).toHaveLength(2);
    for (let count = 0; count < 10 && container.querySelector("button"); count++) container.querySelector("button")!.click();
    expect(container.querySelector("pre")!.textContent).toBe(text);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector("mark")?.textContent).toBe("needle");
  });

  it("shows a short chapter in full without continuation controls", () => {
    const container = document.createElement("div");
    renderSectionPreview(container, "# Heading\nneedle", [{ from: 10, to: 16 }]);
    expect(container.querySelector("pre")!.textContent).toBe("# Heading\nneedle");
    expect(container.querySelector("mark")?.textContent).toBe("needle");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
