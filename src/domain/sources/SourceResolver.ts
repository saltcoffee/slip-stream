import type { App, TFile } from "obsidian";
import type { SourceKind, SourceSpec } from "../types";
import type { VaultGateway } from "../../infra/VaultGateway";
import { FolderSource } from "./FolderSource";
import { TagSource } from "./TagSource";
import { LinkSource } from "./LinkSource";

export interface SourceContext {
  app: App;
  gateway: VaultGateway;
  /** 唤起视图时确定的主文档（backlinks/outlinks 锚点） */
  anchorFile?: TFile;
}

export interface SourceResolver {
  readonly kind: SourceKind;
  resolve(spec: SourceSpec, ctx: SourceContext): Promise<TFile[]>;
}

const REGISTRY: Partial<Record<SourceKind, () => SourceResolver>> = {
  folder: () => new FolderSource(),
  tag: () => new TagSource(),
  backlinks: () => new LinkSource("backlinks"),
  outlinks: () => new LinkSource("outlinks"),
};

export function createResolver(kind: SourceKind): SourceResolver {
  const factory = REGISTRY[kind];
  if (!factory) {
    throw new Error("SOURCE_UNAVAILABLE");
  }
  return factory();
}
