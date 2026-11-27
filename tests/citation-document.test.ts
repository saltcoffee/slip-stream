import { describe, expect, it } from "vitest";
import {
  buildOutlineLayout,
  checkMarkdownBoundaries,
  checkTargetInsertionBoundaries,
  compileCitationDocument,
} from "../src/domain/CitationDocument";

describe("CitationDocument", () => {
  it("assembles single, group, and all scopes with accurate LF UTF-16 citation slices", () => {
    const groups = [
      { id: "g1", name: "效率收益" },
      { id: "g2", name: "空论点组" },
    ];
    const items = [
      {
        itemId: "e1",
        operationId: "b1:e1",
        groupId: null,
        citationText: "> 收集摘录 🚀\r\n> — [[A.md#^1]]",
        note: "第一行备注\n第二行备注",
      },
      {
        itemId: "e2",
        operationId: "b1:e2",
        groupId: "g1",
        citationText: "组内摘录 ([[B.md#^2]])",
      },
    ];

    const single = compileCitationDocument(
      buildOutlineLayout({ scope: "single", groups, items: [items[0]] }),
    );
    expect(single.hasSkeleton).toBe(false);
    expect(single.includedItemCount).toBe(1);
    expect(single.markdown).not.toContain("## ");
    expect(single.markdown).toContain("个人备注：第一行备注\n个人备注：第二行备注");
    expect(single.markdown.slice(single.citationSlices[0].range.from, single.citationSlices[0].range.to)).toBe(
      "> 收集摘录 🚀\n> — [[A.md#^1]]",
    );

    const groupOnly = compileCitationDocument(
      buildOutlineLayout({ scope: "group", groups: [groups[1]], items }),
    );
    expect(groupOnly.includedItemCount).toBe(0);
    expect(groupOnly.hasSkeleton).toBe(true);
    expect(groupOnly.markdown).toBe("## 空论点组\n\n待补材料");

    const all = compileCitationDocument(
      buildOutlineLayout({ scope: "all", groups, items }),
    );
    expect(all.includedItemCount).toBe(2);
    expect(all.hasSkeleton).toBe(true);
    expect(all.citationSlices).toHaveLength(2);
    expect(all.markdown.indexOf("## 收集区")).toBe(0);
    expect(all.markdown.indexOf("## 效率收益")).toBeGreaterThan(all.markdown.indexOf("## 收集区"));
    expect(all.markdown.indexOf("## 空论点组")).toBeGreaterThan(all.markdown.indexOf("## 效率收益"));
    expect(all.markdown.slice(all.citationSlices[0].range.from, all.citationSlices[0].range.to)).toBe(
      "> 收集摘录 🚀\n> — [[A.md#^1]]",
    );
    expect(all.markdown.slice(all.citationSlices[1].range.from, all.citationSlices[1].range.to)).toBe(
      "组内摘录 ([[B.md#^2]])",
    );
  });

  it("distinguishes empty groups from all-skipped groups and blocks empty single/collection output (AC-39)", () => {
    const groups = [{ id: "g1", name: "Group One" }];
    const skippedOnly = buildOutlineLayout({
      scope: "group",
      groups,
      items: [{ itemId: "e1", operationId: "op1", groupId: "g1", citationText: "Text", skipped: true }],
    });
    const compiledGroup = compileCitationDocument(skippedOnly);
    expect(compiledGroup.includedItemCount).toBe(0);
    expect(compiledGroup.hasSkeleton).toBe(true);
    expect(compiledGroup.isEmpty).toBe(false);
    expect(compiledGroup.markdown).toBe("## Group One\n\n本次未输出摘录");

    const singleSkipped = compileCitationDocument(
      buildOutlineLayout({
        scope: "single",
        groups: [],
        items: [{ itemId: "e1", operationId: "op1", groupId: null, citationText: "Text", note: "Note", skipped: true }],
      }),
    );
    expect(singleSkipped.isEmpty).toBe(true);
    expect(singleSkipped.hasSkeleton).toBe(false);
    expect(singleSkipped.markdown).toBe("");

    const allCollectionSkippedNoGroups = compileCitationDocument(
      buildOutlineLayout({
        scope: "all",
        groups: [],
        items: [{ itemId: "e1", operationId: "op1", groupId: null, citationText: "Text", skipped: true }],
      }),
    );
    expect(allCollectionSkippedNoGroups.isEmpty).toBe(true);
    expect(allCollectionSkippedNoGroups.hasSkeleton).toBe(false);
  });

  it("escapes heading and note text so they cannot inject headings, links, or HTML", () => {
    const layout = buildOutlineLayout({
      scope: "group",
      groups: [{ id: "g1", name: "Title\n## Injected [[Fake.md]] <script>" }],
      items: [
        {
          itemId: "e1",
          operationId: "op1",
          groupId: "g1",
          citationText: "> Quote\n> — [[Note.md#^a]]",
          note: "> Not a quote [[Bad]]\n<b>Not HTML</b>",
        },
      ],
    });
    const compiled = compileCitationDocument(layout);
    const lines = compiled.markdown.split("\n");
    expect(lines[0]).toMatch(/^## Title \\#\\# Injected \\\[\\\[Fake\.md\\\]\\\] \\<script\\>/);
    expect(lines[0]).not.toContain("\n## Injected");
    expect(compiled.markdown).toContain("个人备注：\\> Not a quote \\\[\\\[Bad\\\]\\\]");
    expect(compiled.markdown).toContain("个人备注：\\<b\\>Not HTML\\</b\\>");
    expect(checkMarkdownBoundaries(compiled)).toEqual([]);
  });

  it("detects unclosed fences and HTML in B/D citations while allowing normal multi-line A citations (AC-41)", () => {
    const unclosedFenceB = compileCitationDocument(
      buildOutlineLayout({
        scope: "group",
        groups: [{ id: "g1", name: "Code" }],
        items: [
          {
            itemId: "e1",
            operationId: "op1",
            groupId: "g1",
            citationText: "```ts\nconst x = 1; ([[S.md#^1]])",
            note: "Must stay separate",
          },
        ],
      }),
    );
    expect(checkMarkdownBoundaries(unclosedFenceB).some((i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE" && i.itemId === "e1")).toBe(true);

    const unclosedFenceAtEof = compileCitationDocument(
      buildOutlineLayout({
        scope: "single",
        groups: [],
        items: [{ itemId: "e1", operationId: "op1", groupId: null, citationText: "```js\nconst y = 2 ([[S.md]])" }],
      }),
    );
    expect(checkMarkdownBoundaries(unclosedFenceAtEof).some((i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE")).toBe(true);

    const unclosedHtmlTagB = compileCitationDocument(
      buildOutlineLayout({
        scope: "group",
        groups: [{ id: "g1", name: "HTML" }],
        items: [
          {
            itemId: "e1",
            operationId: "op1",
            groupId: "g1",
            citationText: "<div class=\"box\">\ncontent ([[S.md]])",
            note: "Swallowed note",
          },
        ],
      }),
    );
    expect(checkMarkdownBoundaries(unclosedHtmlTagB).some((i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE" && i.itemId === "e1")).toBe(true);

    const unclosedHtmlCommentD = compileCitationDocument(
      buildOutlineLayout({
        scope: "single",
        groups: [],
        items: [{ itemId: "e1", operationId: "op1", groupId: null, citationText: "<!-- open comment [[S.md]]" }],
      }),
    );
    expect(checkMarkdownBoundaries(unclosedHtmlCommentD).some((i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE")).toBe(true);

    // Explicit fallback to Template A wraps lines in blockquote, isolating fences and HTML tags.
    const fallbackA = compileCitationDocument(
      buildOutlineLayout({
        scope: "group",
        groups: [{ id: "g1", name: "Safe A" }],
        items: [
          {
            itemId: "e1",
            operationId: "op1",
            groupId: "g1",
            citationText: "> ```ts\n> const x = 1;\n> <div class=\"box\">\n> — [[S.md#^1]]",
            note: "Independent note",
          },
          {
            itemId: "e2",
            operationId: "op2",
            groupId: "g1",
            citationText: "> Second quote\n> — [[S2.md#^2]]",
          },
        ],
      }),
    );
    expect(checkMarkdownBoundaries(fallbackA)).toEqual([]);
    expect(checkTargetInsertionBoundaries("Before\n\nAfter", { from: 6, to: 6 }, fallbackA, true)).toEqual([]);
  });

  it("blocks target insertions inside existing target fences or unclosed HTML (AC-41)", () => {
    const safeDoc = compileCitationDocument(
      buildOutlineLayout({
        scope: "single",
        groups: [],
        items: [{ itemId: "e1", operationId: "op1", groupId: null, citationText: "> Safe\n> — [[S.md#^1]]" }],
      }),
    );
    const targetWithFence = "```ts\n\n```\nAfter";
    expect(
      checkTargetInsertionBoundaries(targetWithFence, { from: 6, to: 6 }, safeDoc, true).some(
        (i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE" && i.scope === "target-context",
      ),
    ).toBe(true);

    const targetWithDiv = "<div>\n\n</div>";
    expect(
      checkTargetInsertionBoundaries(targetWithDiv, { from: 6, to: 6 }, safeDoc, true).some(
        (i) => i.code === "MARKDOWN_BOUNDARY_UNSAFE" && i.scope === "target-context",
      ),
    ).toBe(true);
  });
});
