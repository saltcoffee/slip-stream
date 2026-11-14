import { getLanguage } from "obsidian";

type Lang = "zh" | "en";

interface Entry {
  zh: string;
  en: string;
}

const DICT: Record<string, Entry> = {
  "cmd.setTarget": { zh: "将当前笔记设为引用目标", en: "Set current note as citation target" },
  "citation.processing": { zh: "正在处理引用…", en: "Processing citation…" },
  "citation.insert": { zh: "引用到目标", en: "Cite to target" },
  "citation.to": { zh: "引用到《{path}》", en: "Cite to “{path}”" },
  "citation.inserted": { zh: "已插入《{path}》", en: "Inserted into “{path}”" },
  "citation.duplicate": { zh: "本次会话曾向此文插入该片段。撤销或删除后仍可能出现此提醒。", en: "This session previously inserted this fragment into this note. It may since have been undone or removed." },
  "citation.insertAgain": { zh: "仍然插入", en: "Insert again" },
  "citation.useA": { zh: "本次改用 A", en: "Use A this time" },
  "citation.refresh": { zh: "展开原文并刷新重选", en: "Expand source and select again" },
  "citation.savedFragment": { zh: "使用保存片段并按文件引用", en: "Use saved fragment with a file link" },
  "citation.staleSnapshot": { zh: "内容来自本次选中时的资料，来源现已变化。", en: "Content is from the saved selection; the source has changed." },
  "citation.fallback": { zh: "本次使用标题／文件链接", en: "Use heading/file link this time" },
  "citation.fileFallback": { zh: "本次使用文件链接", en: "Use file link this time" },
  "citation.retryRecord": { zh: "仅重试保存记录", en: "Retry saving records only" },
  "citation.recordSaved": { zh: "记录处理完成；正文／剪贴板未再次提交", en: "Records processed; no repeated insertion or copy" },
  "citation.copyRecordFailed": { zh: "引用已复制，但历史未保存", en: "Citation copied, but history was not saved" },
  "citation.selectFirst": { zh: "请展开卡片并选择片段，或使用段落操作入口", en: "Expand the card and select text, or use a paragraph action" },
  "citation.invalidSelection": { zh: "请在同一篇来源笔记的正文中选择静态文字；必要时展开原文重选", en: "Select static text within one source note body; expand the source if needed" },
  "citation.paragraph": { zh: "第 {n} 个片段的引用操作", en: "Citation actions for fragment {n}" },
  "precision.block": { zh: "精度：完整块", en: "Precision: whole block" },
  "precision.fragment": { zh: "精度：块内片段，链接定位到所在块", en: "Precision: fragment; link points to its block" },
  "precision.multi-block-start": { zh: "精度：跨块起点，引文保留完整选区", en: "Precision: multi-block start; full selection retained" },
  "precision.heading": { zh: "精度：标题级", en: "Precision: heading" },
  "precision.file": { zh: "精度：文件级", en: "Precision: file" },
  "anchor.enabled": { zh: "溯源：自动生成块 ID 已开启，会修改来源笔记", en: "Source: automatic block IDs enabled; source notes may be modified" },
  "anchor.disabled": { zh: "溯源：不生成新块 ID，可复用已有可靠锚点", en: "Source: no new block IDs; existing verified anchors can be reused" },
  "anchor.explanation": { zh: "精确引用需要在来源笔记中添加块 ID。取消或仅浏览不会修改文件。撤销稿件中的引用不会移除来源 ID。", en: "Precise citations add block IDs to source notes. Browsing or cancelling does not modify files. Undoing a citation does not remove its source ID." },
  "anchor.accept": { zh: "继续并记住", en: "Continue and remember" },
  "anchor.disable": { zh: "关闭自动生成，本次使用标题／文件链接", en: "Disable automatic IDs and use a heading/file link" },
  "anchor.saveFailed": { zh: "未能保存说明选择，尚未生成来源 ID；请重试或选择不新增 ID", en: "Could not save your choice. No source ID was generated; retry or choose a non-writing link" },
  "anchor.retained": { zh: "尚未插入／复制；来源块 ID 已生成并保留", en: "Not inserted/copied; the generated source block ID remains" },
  "target.none": { zh: "选择一篇正在编辑的笔记作为目标", en: "Choose an open note in edit mode as the target" },
  "target.choose": { zh: "选择目标", en: "Choose target" },
  "target.openFirst": { zh: "请先在本窗口打开一篇可编辑的 Markdown 笔记", en: "First open an editable Markdown note in this window" },
  "target.empty": { zh: "没有匹配的可编辑笔记，请先打开笔记或更改搜索内容", en: "No editable notes match. Open a note or change the search." },
  "target.position": { zh: "目标：{path} · 第 {line} 行", en: "Target: {path} · line {line}" },
  "target.show": { zh: "查看目标／设置位置", en: "View target / set position" },
  "target.settings": { zh: "引用设置", en: "Citation settings" },
  "history.insert": { zh: "已插入", en: "Inserted" },
  "history.copy": { zh: "已复制，未确认入稿", en: "Copied; insertion unconfirmed" },
  "history.legacy-unknown": { zh: "旧版记录，动作／目标未知", en: "Legacy record; action/target unknown" },
  "data.readonly": { zh: "插件数据无法读取或版本较新，已保留原数据并禁用记录写入；可继续使用不新增 ID 的引用。请备份并检查插件目录中的 data.json。", en: "Plugin data is unreadable or from a newer version. Original data is preserved; recording is read-only. Citations without new IDs remain available. Back up and inspect data.json in the plugin directory." },
  "data.backupFailed": { zh: "旧数据备份失败，未覆盖原数据，记录暂为只读。请检查插件目录的写入权限后重载。", en: "Data backup failed. Original data was not overwritten; records are read-only. Check plugin directory permissions and reload." },
  "data.invalidEntries": { zh: "部分记录格式异常，有效记录已保留；原始数据已备份在插件目录。", en: "Some records were invalid. Valid records were retained; original data was backed up in the plugin directory." },
  "data.migrationFailed": { zh: "数据迁移保存失败，原始备份已保留；可重试保存。", en: "Migration could not be saved. The original backup remains; saving can be retried." },
  "data.saveFailed": { zh: "设置或记录未能保存，请重试", en: "Could not save settings or records; please retry" },
  "set.anchorDesc": { zh: "首次新增前需确认。块 ID 会写入来源；撤销稿件引用不会移除它。关闭后仍可复用已有 ID。", en: "Confirmation is required before the first new ID. IDs modify source notes and remain after undoing a citation. Existing IDs can be reused when disabled." },
  "set.dedupeDesc": { zh: "仅提醒本次会话曾成功插入同一目标文章的同一来源片段；不核查撤销或手动粘贴。", en: "Reminds only about the same fragment successfully inserted into the same note this session; does not inspect undo or manual pastes." },
  "set.recordDesc": { zh: "包含操作历史与独立入稿快照；关闭后不新增记录，也不删除既有数据。历史上限和清空历史不影响快照。", en: "Includes operation history and independent insertion snapshots. Disabling stops new records and keeps existing data. History limits and clearing do not affect snapshots." },
  "set.snapshots": { zh: "引用快照", en: "Citation snapshots" },
  "set.snapshotUsage": { zh: "{n} / 1,000 条 · {size} / 10 MiB", en: "{n} / 1,000 snapshots · {size} / 10 MiB" },
  "set.clearSnapshots": { zh: "清空快照", en: "Clear snapshots" },
  "set.clearSnapshotsConfirm": { zh: "仅删除后续核查用的引用快照。笔记正文、来源块 ID 和操作历史均保留。", en: "Delete citation verification snapshots only. Note text, source block IDs and operation history remain." },
  "set.clearHistoryDesc": { zh: "仅清空操作历史，保留独立快照、笔记与本次会话去重。", en: "Clear operation history only; keep snapshots, notes and session duplicate reminders." },
  "error.SOURCE_STALE": { zh: "来源已变化，无法确认这段文字的位置", en: "The source changed; this fragment’s location cannot be verified" },
  "error.SOURCE_MISSING": { zh: "来源不存在，请重新选择来源", en: "Source no longer exists; select another source" },
  "error.SOURCE_MAPPING_UNSUPPORTED": { zh: "无法可靠映射选区，请在同一来源中展开原文重选", en: "Cannot reliably map this selection; expand and select static text in one source" },
  "error.SOURCE_AMBIGUOUS": { zh: "同一来源的编辑缓冲区不一致或无法安全写入，请检查后重试", en: "Source editor buffers disagree or cannot be safely updated; check and retry" },
  "error.SOURCE_READ_FAILED": { zh: "无法读取来源，尚未提交引用", en: "Could not read the source; citation was not submitted" },
  "error.TARGET_MISSING": { zh: "请先选择引用目标；原目标可能已关闭、换文件或删除", en: "Choose a citation target; the previous target may be closed, reused or deleted" },
  "error.TARGET_READONLY": { zh: "目标处于阅读或只读模式，请打开编辑模式", en: "Target is in reading/read-only mode; switch to edit mode" },
  "error.TARGET_STALE": { zh: "目标内容已变化，请前往目标重新设置插入位置", en: "Target content changed; return to the target and set the insertion position again" },
  "error.TARGET_MULTIPLE_SELECTIONS": { zh: "请在目标中只保留一个光标／选区", en: "Keep only one cursor or selection in the target" },
  "error.DROP_POSITION_UNAVAILABLE": { zh: "无法确定拖拽位置，请重新拖拽或改用点击引用", en: "Cannot determine the drop position; retry dragging or use the citation button" },
  "error.ANCHOR_WRITE_FAILED": { zh: "本次无法生成块 ID，引用尚未提交；可明确选择标题／文件链接", en: "Cannot generate a block ID for this operation; the citation was not submitted. You can explicitly choose a heading/file link" },
  "error.TEMPLATE_REQUIRES_BLOCK": { zh: "块嵌入会扩大当前选区，或缺少可靠块锚点，请选择引用方式", en: "Block embedding would expand the selection or lacks a verified anchor; choose a citation format" },
  "error.TEMPLATE_INVALID": { zh: "自定义模板包含未知变量、空输出或无效格式，请修正或本次用 A", en: "Custom template contains unknown variables, empty output or invalid syntax; fix it or use A this time" },
  "error.LINK_INVALID": { zh: "无法确认模板中的来源链接，请使用完整路径或安全变量 {{link}}", en: "Cannot verify the source link; use the full path or the safe {{link}} variable" },
  "error.CONSENT_REQUIRED": { zh: "请先保存新增来源块 ID 的说明选择", en: "Save your choice about source block IDs before continuing" },
  "error.DUPLICATE": { zh: "本次会话曾向此文插入该片段", en: "This session previously inserted this fragment into this note" },
  "error.CLIPBOARD_DENIED": { zh: "复制失败，剪贴板没有更新，请重试", en: "Copy failed; the clipboard was not updated. Please retry" },
  "error.TARGET_COMMIT_FAILED": { zh: "目标写入失败，尚未插入引文，请检查目标", en: "Target write failed; citation was not inserted. Check the target" },
  "error.RECORD_SAVE_FAILED": { zh: "引文已插入，但记录未保存；请勿重复插入", en: "Citation inserted, but records were not saved; do not insert again" },
  "error.RECORD_CAPACITY_EXCEEDED": { zh: "引文已插入，但快照已达上限，本次未保存核查依据；请清理快照", en: "Citation inserted, but snapshot capacity is full. No verification snapshot was saved for this insertion; clear snapshots to free space" },
  "error.COMMIT_STATE_UNCERTAIN": { zh: "操作结果待确认，请先查看目标／来源；不会自动重放", en: "Operation result is uncertain. Inspect the target/source before any new action; no automatic replay" },
  "error.OPERATION_CANCELLED": { zh: "本次引用已取消", en: "Citation cancelled" },
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
  "notice.copyFailed": { zh: "复制引用失败，请重试", en: "Failed to copy citation. Try again." },
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
  "set.historyEnabled": { zh: "记录引用（历史与快照）", en: "Record citations (history and snapshots)" },
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
  const text = entry ? entry[getLang()] : key;
  return vars ? text.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : placeholder) : text;
}
