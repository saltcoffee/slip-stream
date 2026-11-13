import type { RenderUnit } from "./types";

const INLINE_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;

function markerLine(lines: string[], type: RenderUnit["type"]): number {
  if (type === "list_item") return 0;
  let line = lines.length - 1;
  while (line > 0 && lines[line].trim() === "") line--;
  return line;
}

export function inlineBlockId(content: string, type: RenderUnit["type"]): string | undefined {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return lines[markerLine(lines, type)].match(INLINE_ID)?.[1];
}

/** 只移除块自身的标记，保留正文、子块标记和原有空白。 */
export function stripInlineBlockId(content: string, type: RenderUnit["type"], id?: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const line = id
    ? lines.findIndex((value) => value.match(INLINE_ID)?.[1] === id)
    : markerLine(lines, type);
  if (line !== -1) lines[line] = lines[line].replace(INLINE_ID, "");
  return lines.join("\n");
}
