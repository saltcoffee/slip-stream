import type { Settings } from "../settings/settings";

export const TEMPLATES: Record<string, string> = {
  A: "> {{content}}\n> — [[{{filename}}#^{{blockId}}|{{title}}]]",
  B: "{{content}} ([[{{filename}}]])",
  C: "![[{{filename}}#^{{blockId}}]]",
  D: "",
};

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_full, key: string) => vars[key] ?? "");
}

export function resolveTemplateId(settings: Settings): string {
  return settings.defaultTemplate;
}

export function buildCitation(settings: Settings, vars: Record<string, string>): string {
  const id = settings.defaultTemplate;
  let tpl = id === "D" ? settings.customTemplate.trim() || TEMPLATES.A : TEMPLATES[id];
  // 空 blockId 降级：A/C 去掉块引用片段，避免 `#^` 坏链
  if (!vars.blockId) {
    tpl = tpl.replace(/#\^\{\{\s*blockId\s*\}\}/g, "");
  }
  return renderTemplate(tpl, vars);
}
