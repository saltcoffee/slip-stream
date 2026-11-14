import { parseLinktext, resolveSubpath } from "obsidian";
import type { App } from "obsidian";
import MarkdownIt from "markdown-it";
import { CitationError } from "../domain/citationTypes";
import type { EditorGateway } from "./EditorGateway";

const md = new MarkdownIt();
export class CitationLinkService {
  constructor(private app: App, private editors: EditorGateway) {}
  link(sourceRef: string, context: string, blockId?: string, heading?: string): string {
    const file = this.editors.file(sourceRef);
    if (/[#|^:\[\]\r\n%]/.test(file.path)) throw new CitationError("LINK_INVALID");
    const subpath = blockId ? `#^${blockId}` : heading ? `#${heading}` : "";
    if (heading) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (/[#|\[\]\r\n]/.test(heading) || !cache || !resolveSubpath(cache, subpath)) throw new CitationError("LINK_INVALID");
    }
    if (this.app.metadataCache.getFirstLinkpathDest(file.path, context) !== file) throw new CitationError("LINK_INVALID");
    return `[[${file.path}${subpath}]]`;
  }
  validate(text: string, sourceRef: string, context: string, expectedSubpath: string): void {
    const file = this.editors.file(sourceRef);
    const destinations: string[] = [];
    for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) destinations.push(match[1].split("|")[0]);
    const tokens = md.parse(text, {});
    for (const token of tokens) for (const child of token.children ?? []) if (child.type === "link_open") {
      const href = child.attrGet("href");
      if (href) { try { destinations.push(decodeURIComponent(href)); } catch { throw new CitationError("LINK_INVALID"); } }
    }
    const matched = destinations.some((destination) => {
      const parsed = parseLinktext(destination);
      if (!parsed.path || parsed.subpath !== expectedSubpath || this.app.metadataCache.getFirstLinkpathDest(parsed.path, context) !== file) return false;
      // A basename is ambiguous even if the resolver currently happens to choose this file.
      if (!parsed.path.includes("/")) {
        const name = parsed.path.replace(/\.md$/, "");
        if (this.app.vault.getMarkdownFiles().filter((candidate) => candidate.basename === name).length !== 1) return false;
      }
      return true;
    });
    if (!matched) throw new CitationError("LINK_INVALID");
  }
}
