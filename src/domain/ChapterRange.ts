import { mapBlocks } from "./BlockMapper";
import type { TextRange } from "./citationTypes";

/** 与检索共用 Markdown 块解析，代码、前言和同名标题均按真实原文位置定界。 */
export function chapterRange(text: string, bodyStart: number, offset: number): TextRange {
  const headings = mapBlocks(text, bodyStart).filter((block) => block.type === "heading");
  const current = headings.filter((heading) => heading.rawRange.from <= offset).at(-1);
  if (!current) return { from: bodyStart, to: headings[0]?.rawRange.from ?? text.length };
  const next = headings.find((heading) => heading.rawRange.from > current.rawRange.from && heading.headingLevel! <= current.headingLevel!);
  return { from: current.rawRange.from, to: next?.rawRange.from ?? text.length };
}
