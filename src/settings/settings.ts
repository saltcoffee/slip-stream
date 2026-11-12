import type { Density } from "../domain/types";

export interface Settings {
  language: "auto" | "zh" | "en";
  defaultDensity: Density;
  defaultPlacement: "right-sidebar" | "split";
  includeSubfolders: boolean;
  excludeGlobs: string;
  collectionLimit: number;
  excerptLength: number;
  snippetIncludeHighlights: boolean;
  snippetIncludeCallouts: boolean;
  snippetCalloutLimit: number;
  compactDefaultCollapsed: boolean;
  historyEnabled: boolean;
  historyLimit: number;
  blockPrecision: boolean;
  defaultTemplate: "A" | "B" | "C" | "D";
  customTemplate: string;
  dedupe: boolean;
  selectionBehavior: "replace" | "append";
  virtualScroll: boolean;
  renderConcurrency: number;
  renderMode: "block" | "whole";
  cardWidth: "narrow" | "medium" | "wide" | "auto";
  fontScale: number;
  showDismissed: boolean;
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  language: "auto",
  defaultDensity: "snippet",
  defaultPlacement: "right-sidebar",
  includeSubfolders: true,
  excludeGlobs: "",
  collectionLimit: 200,
  excerptLength: 150,
  snippetIncludeHighlights: true,
  snippetIncludeCallouts: true,
  snippetCalloutLimit: 280,
  compactDefaultCollapsed: true,
  historyEnabled: true,
  historyLimit: 200,
  blockPrecision: true,
  defaultTemplate: "A",
  customTemplate: "",
  dedupe: true,
  selectionBehavior: "replace",
  virtualScroll: true,
  renderConcurrency: 3,
  renderMode: "block",
  cardWidth: "auto",
  fontScale: 1,
  showDismissed: false,
  debug: false,
};
