import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "./support/obsidian";
import { getLang, setLanguage, t } from "../src/util/i18n";

const sources = readdirSync("src", { recursive: true }).filter((name) => String(name).endsWith(".ts"))
  .map((name) => ts.createSourceFile(String(name), readFileSync(join("src", String(name)), "utf8"), ts.ScriptTarget.Latest, true));
const i18n = sources.find((source) => source.fileName === "util/i18n.ts")!;
let dictionary!: ts.ObjectLiteralExpression;
function visit(node: ts.Node, callback: (node: ts.Node) => void): void { callback(node); ts.forEachChild(node, (child) => visit(child, callback)); }
visit(i18n, (node) => { if (ts.isVariableDeclaration(node) && node.name.getText(i18n) === "DICT") dictionary = node.initializer as ts.ObjectLiteralExpression; });
const entries = dictionary.properties.map((property) => {
  const item = property as ts.PropertyAssignment;
  return { key: (item.name as ts.StringLiteral).text, ...Object.fromEntries((item.initializer as ts.ObjectLiteralExpression).properties.map((node) => {
    const field = node as ts.PropertyAssignment;
    return [field.name.getText(i18n), (field.initializer as ts.StringLiteral).text];
  })) } as { key: string; zh: string; en: string };
});
const keys = new Set(entries.map((entry) => entry.key));
const placeholders = (text: string) => [...text.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((match) => match[1]).sort();
afterEach(() => { setLanguage("auto"); vi.restoreAllMocks(); });

describe("bilingual interface", () => {
  it.each(["zh", "en"] as const)("provides every dictionary entry in %s", (language) => {
    setLanguage(language);
    expect(keys.size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry[language]?.trim(), entry.key).toBeTruthy();
      expect(t(entry.key), entry.key).toBe(entry[language]);
    }
  });
  it("keeps all translated placeholders consistent", () => {
    for (const entry of entries) expect(placeholders(entry.zh), entry.key).toEqual(placeholders(entry.en));
  });
  it("covers literal keys passed through helpers as well as direct translation calls", () => {
    const missing: string[] = [];
    for (const source of sources.filter((file) => file !== i18n)) visit(source, (node) => {
      if (!ts.isStringLiteralLike(node) || !/^(?:cmd|citation|precision|anchor|target|history|data|error|common|menu|tb|sort|sb|card|state|status|notice|set|opt|template)\.[\w-]+$/.test(node.text)) return;
      if (!keys.has(node.text)) missing.push(`${source.fileName}:${node.text}`);
    });
    expect(missing).toEqual([]);
  });
  it("covers all dynamic error, precision and history action labels from their domain types", () => {
    const source = sources.find((file) => file.fileName === "domain/citationTypes.ts")!;
    const checkUnion = (node: ts.Node, prefix: string) => visit(node, (member) => {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) expect(keys.has(prefix + member.literal.text), prefix + member.literal.text).toBe(true);
    });
    visit(source, (node) => {
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "CitationErrorCode") checkUnion(node.type, "error.");
      if (ts.isTypeAliasDeclaration(node) && node.name.text === "Precision") checkUnion(node.type, "precision.");
      if (ts.isInterfaceDeclaration(node) && node.name.text === "CitationHistoryEntry") {
        const action = node.members.find((member) => member.name?.getText(source) === "action");
        checkUnion(action!, "history.");
      }
    });
  });
  it("follows the host language in automatic mode while respecting a manual override", () => {
    vi.spyOn(obsidian, "getLanguage").mockReturnValue("zh-CN");
    setLanguage("auto"); expect(getLang()).toBe("zh");
    setLanguage("en"); expect(getLang()).toBe("en");
    setLanguage("auto"); expect(getLang()).toBe("zh");
  });
  it("never re-interpolates user filenames as translation placeholders", () => {
    setLanguage("en");
    expect(t("target.position", { path: "Drafts/{line}.md", line: 12 })).toBe("Target: Drafts/{line}.md · line 12");
  });
});
