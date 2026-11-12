import { getLanguage } from "obsidian";

type Lang = "zh" | "en";

interface Entry {
  zh: string;
  en: string;
}

const DICT: Record<string, Entry> = {
  "common.ok": { zh: "确定", en: "OK" },
  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.close": { zh: "关闭", en: "Close" },
  "common.clear": { zh: "清空", en: "Clear" },
  "common.retry": { zh: "重试", en: "Retry" },
  "common.refresh": { zh: "刷新", en: "Refresh" },

  "menu.openFolder": { zh: "在 SlipStream 中打开", en: "Open in SlipStream" },
  "menu.openTag": { zh: "在 SlipStream 中打开标签", en: "Open tag in SlipStream" },
  "menu.viewRelated": { zh: "在 SlipStream 中查看相关笔记", en: "View related notes in SlipStream" },

  "cmd.open": { zh: "打开 SlipStream", en: "Open SlipStream" },
  "cmd.openFolder": { zh: "以当前文件夹打开 SlipStream", en: "Open current folder in SlipStream" },
  "cmd.openBacklinks": { zh: "在 SlipStream 中打开入链", en: "Open backlinks in SlipStream" },
  "cmd.openOutlinks": { zh: "在 SlipStream 中打开出链", en: "Open outlinks in SlipStream" },
  "cmd.history": { zh: "打开引用历史", en: "Open citation history" },

  "tb.full": { zh: "完整", en: "Full" },
  "tb.snippet": { zh: "摘要", en: "Highlights" },
  "tb.compact": { zh: "紧凑", en: "Compact" },
  "tb.filter": { zh: "过滤卡片…", en: "Filter cards…" },
  "tb.sort": { zh: "排序", en: "Sort" },
  "tb.more": { zh: "更多", en: "More" },
  "tb.refresh": { zh: "刷新", en: "Refresh" },
  "tb.showHidden": { zh: "显示已隐藏", en: "Show dismissed" },
  "tb.clearCache": { zh: "清除缓存", en: "Clear cache" },
  "tb.collapseAll": { zh: "全部折叠", en: "Collapse all" },
  "tb.expandAll": { zh: "全部展开", en: "Expand all" },
  "sort.mtime": { zh: "修改时间", en: "Modified" },
  "sort.ctime": { zh: "创建时间", en: "Created" },
  "sort.name": { zh: "文件名", en: "Name" },
  "sort.custom": { zh: "自定义顺序", en: "Custom order" },
  "sort.asc": { zh: "升序", en: "Ascending" },
  "sort.desc": { zh: "降序", en: "Descending" },

  "sb.title": { zh: "数据源", en: "Source" },
  "sb.folder": { zh: "文件夹", en: "Folder" },
  "sb.tag": { zh: "标签", en: "Tag" },
  "sb.backlinks": { zh: "入链", en: "Backlinks" },
  "sb.outlinks": { zh: "出链", en: "Outlinks" },
  "sb.change": { zh: "切换数据源", en: "Change source" },
  "sb.promptFolder": { zh: "文件夹路径", en: "Folder path" },
  "sb.promptTag": { zh: "标签（如 #项目）", en: "Tag (e.g. #project)" },
  "sb.needActive": { zh: "请先打开一篇笔记再使用入链 / 出链", en: "Open a note first to use backlinks/outlinks" },

  "card.words": { zh: "{n} 字", en: "{n} words" },
  "card.pin": { zh: "固定到顶部", en: "Pin to top" },
  "card.unpin": { zh: "取消固定", en: "Unpin" },
  "card.copy": { zh: "复制引用", en: "Copy citation" },
  "card.dismiss": { zh: "从流中移除", en: "Dismiss" },
  "card.open": { zh: "在新标签页打开", en: "Open in new tab" },
  "card.collapse": { zh: "折叠", en: "Collapse" },
  "card.expand": { zh: "展开", en: "Expand" },

  "state.loading": { zh: "正在解析 {n} 篇…", en: "Loading {n} notes…" },
  "state.noSource": { zh: "尚未选择数据源", en: "No source selected" },
  "state.empty": { zh: "未找到笔记", en: "No notes found" },
  "state.filterEmpty": { zh: "没有符合条件的卡片", en: "No cards match the filter" },
  "state.allHidden": { zh: "卡片都已隐藏", en: "All cards are dismissed" },
  "state.error": { zh: "加载失败", en: "Failed to load" },
  "state.renderError": { zh: "该卡片渲染失败", en: "This card failed to render" },
  "status.summary": {
    zh: "{n} 篇 · {hidden} 隐藏 · {citations} 引用",
    en: "{n} notes · {hidden} hidden · {citations} cites",
  },

  "notice.inserted": { zh: "已插入引用", en: "Citation inserted" },
  "notice.copied": { zh: "已复制引用", en: "Citation copied" },
  "notice.duplicate": { zh: "该段落已引用过", en: "Already cited this block" },
  "notice.noEditor": { zh: "请先在编辑模式打开一篇笔记", en: "Open a note in edit mode first" },
  "notice.blockStale": { zh: "来源已变化，改为文件级链接", en: "Source changed; inserted file-level link" },

  "history.title": { zh: "引用历史", en: "Citation history" },
  "history.empty": { zh: "还没有引用记录", en: "No citations yet" },
  "history.filter": { zh: "筛选历史…", en: "Filter history…" },
  "history.jump": { zh: "跳回原文", en: "Jump to source" },
  "history.openTarget": { zh: "打开目标", en: "Open target" },
  "history.recopy": { zh: "再复制一次", en: "Copy again" },
  "history.clear": { zh: "清空历史", en: "Clear history" },

  "set.general": { zh: "常规", en: "General" },
  "set.language": { zh: "界面语言", en: "Language" },
  "set.sources": { zh: "数据源", en: "Data sources" },
  "set.card": { zh: "卡片", en: "Cards" },
  "set.citation": { zh: "引用", en: "Citations" },
  "set.performance": { zh: "性能", en: "Performance" },
  "set.appearance": { zh: "外观", en: "Appearance" },
  "set.advanced": { zh: "高级", en: "Advanced" },
  "set.density": { zh: "默认显示密度", en: "Default density" },
  "set.placement": { zh: "默认停靠位置", en: "Default placement" },
  "set.includeSub": { zh: "文件夹包含子文件夹", en: "Include subfolders" },
  "set.exclude": { zh: "排除规则（glob，逗号分隔）", en: "Exclude globs (comma separated)" },
  "set.limit": { zh: "集合上限", en: "Collection limit" },
  "set.excerpt": { zh: "摘要字数", en: "Excerpt length" },
  "set.includeHighlights": { zh: "摘要包含高亮", en: "Include highlights in excerpt" },
  "set.includeCallouts": { zh: "摘要包含 Callout", en: "Include callouts in excerpt" },
  "set.calloutLimit": { zh: "单个 Callout 上限", en: "Callout length limit" },
  "set.compactCollapsed": { zh: "紧凑模式默认折叠", en: "Collapse cards by default in compact mode" },
  "set.blockPrecision": { zh: "自动生成块引用", en: "Add block reference automatically" },
  "set.template": { zh: "默认引用模板", en: "Default citation template" },
  "set.customTemplate": { zh: "自定义模板", en: "Custom template" },
  "set.dedupe": { zh: "引用去重", en: "Deduplicate citations" },
  "set.selection": { zh: "选区行为", en: "Selection behavior" },
  "set.historyEnabled": { zh: "记录引用历史", en: "Record citation history" },
  "set.historyLimit": { zh: "引用历史上限", en: "Citation history limit" },
  "set.virtualScroll": { zh: "虚拟滚动", en: "Virtual scrolling" },
  "set.concurrency": { zh: "单卡渲染并发", en: "Render concurrency" },
  "set.renderMode": { zh: "渲染模式", en: "Render mode" },
  "set.cardWidth": { zh: "卡片宽度", en: "Card width" },
  "set.fontScale": { zh: "字号缩放", en: "Font scale" },
  "set.showDismissed": { zh: "显示已隐藏", en: "Show dismissed" },
  "set.debug": { zh: "调试日志", en: "Debug logging" },
  "opt.right": { zh: "右侧栏", en: "Right sidebar" },
  "opt.split": { zh: "分屏", en: "Split" },
  "opt.replace": { zh: "替换选区", en: "Replace" },
  "opt.append": { zh: "追加", en: "Append" },
  "opt.block": { zh: "逐块", en: "Block" },
  "opt.whole": { zh: "整篇", en: "Whole" },
  "opt.narrow": { zh: "窄", en: "Narrow" },
  "opt.medium": { zh: "中", en: "Medium" },
  "opt.wide": { zh: "宽", en: "Wide" },
  "opt.auto": { zh: "自动", en: "Auto" },
  "opt.followObsidian": { zh: "跟随 Obsidian", en: "Follow Obsidian" },
  "template.A": { zh: "标准引用", en: "Standard quote" },
  "template.B": { zh: "行内融合", en: "Inline" },
  "template.C": { zh: "嵌入式", en: "Embed" },
  "template.D": { zh: "自定义", en: "Custom" },
};

export type LangMode = "auto" | "zh" | "en";

let override: "zh" | "en" | null = null;

export function setLanguage(mode: LangMode): void {
  override = mode === "auto" ? null : mode;
}

export function getLang(): Lang {
  if (override) return override;
  const candidates: string[] = [];
  try {
    const fromApi = getLanguage();
    if (fromApi) candidates.push(fromApi);
  } catch {
    /* ignore */
  }
  try {
    const loc = (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.();
    if (typeof loc === "string") candidates.push(loc);
  } catch {
    /* ignore */
  }
  try {
    const htmlLang = document.documentElement.getAttribute("lang");
    if (htmlLang) candidates.push(htmlLang);
  } catch {
    /* ignore */
  }
  try {
    if (navigator.language) candidates.push(navigator.language);
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    const value = candidate.toLowerCase();
    if (value.startsWith("zh")) return "zh";
    if (value.startsWith("en")) return "en";
  }
  return "en";
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key];
  let text = entry ? entry[getLang()] : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split(`{${k}}`).join(String(v));
    }
  }
  return text;
}
