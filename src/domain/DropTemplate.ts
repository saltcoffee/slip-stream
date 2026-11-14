import type { Precision, TemplateId } from "./citationTypes";
import { CitationError } from "./citationTypes";

export const TEMPLATES = {
  A: "{{blockquoteContent}}\n> — {{link}}",
  B: "{{content}} ({{link}})",
  C: "!{{link}}",
  D: "",
};
export interface CitationTemplateInput {
  templateId: TemplateId;
  content: string;
  link: string;
  precision: Precision;
  wholeBlock: boolean;
  legacyVars: Readonly<Record<string, string>>;
  customTemplate?: string;
}
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  if (/\{\{|\}\}/.test(template.replace(/\{\{\s*[^{}]+?\s*\}\}/g, ""))) throw new CitationError("TEMPLATE_INVALID");
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_full, key: string) => {
    if (!Object.hasOwn(vars, key)) throw new CitationError("TEMPLATE_INVALID");
    return vars[key];
  });
}
export function buildCitation(input: CitationTemplateInput): string {
  const { content, link, templateId } = input;
  const quote = content.replace(/\r\n/g, "\n").split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
  switch (templateId) {
    case "A": return `${quote}\n> — ${link}`;
    case "B": return `${content}${content.includes("\n") ? "\n\n" : " "}(${link})`;
    case "C":
      if (!input.wholeBlock || input.precision !== "block" || !/#\^[A-Za-z0-9-]+(?:\||\]\])/.test(link)) throw new CitationError("TEMPLATE_REQUIRES_BLOCK");
      return `!${link.replace(/\|[^\]]*(?=\]\]$)/, "")}`;
    case "D": {
      const text = renderTemplate(input.customTemplate ?? "", { ...input.legacyVars, content, link, blockquoteContent: quote });
      if (!text.trim()) throw new CitationError("TEMPLATE_INVALID");
      return text;
    }
  }
}
