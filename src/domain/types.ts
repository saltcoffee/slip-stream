export type SourceKind =
  | "folder"
  | "tag"
  | "backlinks"
  | "outlinks"
  | "bookmark"
  | "search";

export type Density = "full" | "snippet" | "compact";

export type SortKey = "mtime" | "ctime" | "name" | "custom";

export interface SourceSpec {
  kind: SourceKind;
  value: string;
  /** backlinks/outlinks 的主文档路径（唤起视图时捕获） */
  anchorFile?: string;
  options?: {
    includeSubfolders?: boolean;
    excludeGlobs?: string[];
    matchChildren?: boolean;
  };
}

export interface BlockRange {
  startLine: number;
  endLine: number;
}

export type BlockKind =
  | "paragraph"
  | "list_item"
  | "blockquote"
  | "callout"
  | "heading"
  | "code"
  | "table"
  | "other";

export interface SourceBlock {
  startLine: number;
  endLine: number;
  content: string;
  type: BlockKind;
  hasBlockId: boolean;
  blockId?: string;
}

/** 渲染单元：list_item 会被合并成 list 单元 */
export interface RenderUnit {
  startLine: number;
  endLine: number;
  content: string;
  type: "list" | BlockKind;
  items?: BlockRange[];
}

export interface DragPayload {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  title: string;
  mode: "block" | "selection";
  blockType?: BlockKind;
  heading?: string;
}

export interface CitationRecord {
  id: string;
  at: number;
  sourcePath: string;
  blockId?: string;
  heading?: string;
  targetPath?: string;
  template: string;
  snippet: string;
  /** 最终落盘文本（用于「再复制一次」） */
  text?: string;
}
