import { Modal } from "obsidian";
import type { App } from "obsidian";
import type {
  EvidenceEntry,
  EvidenceOutline,
  OutlineErrorCode,
  OutlineGroup,
  OutlineScope,
} from "../domain/outlineTypes";
import { isValidGroupName, normalizeGroupName } from "../domain/outlineTypes";
import type { OutlineMutationResult } from "../domain/OutlineService";
import { citationPrompt } from "./CitationPrompt";
import { getLang, t } from "../util/i18n";

export const OUTLINE_WINDOW_SIZE = 30;
const CONTENT_PREVIEW_LIMIT = 240;
const NOTE_DEBOUNCE_MS = 300;

export interface OutlinePanelHost {
  readonly app: App;
  currentDeskId(): string | undefined;
  getOutline(): { outline: EvidenceOutline; revision: number } | undefined;
  isDirty(): boolean;
  isReadOnly(): boolean;
  recordingEnabled(): boolean;
  isSourceMissing(path: string): boolean;
  switchToMaterials(): void;
  openCreateDesk(): void;
  openSource(entry: EvidenceEntry): void;
  openPreview(scope: OutlineScope): void;
  retrySave(): Promise<void>;
  setNote(entryId: string, expectedContentRevision: number, note: string, persist?: boolean): Promise<OutlineMutationResult>;
  createGroup(name: string, groupId?: string): Promise<OutlineMutationResult>;
  renameGroup(groupId: string, name: string): Promise<OutlineMutationResult>;
  moveGroup(groupId: string, direction: "up" | "down"): Promise<OutlineMutationResult>;
  removeGroup(groupId: string): Promise<OutlineMutationResult>;
  moveEntry(entryId: string, targetGroupId: string | null | undefined, direction?: "up" | "down"): Promise<OutlineMutationResult>;
  removeEntry(entryId: string): Promise<OutlineMutationResult>;
}

interface PendingNote {
  entryId: string;
  expectedContentRevision: number;
  value: string;
  timer: number | null;
}

type FocusTarget =
  | { kind: "entry"; id: string; role: "menu" | "note" | "open" | "preview" }
  | { kind: "group"; id: string; role: "menu" | "preview" }
  | { kind: "new-group" }
  | { kind: "back" };

function mkBtn(
  parent: HTMLElement,
  text: string,
  onClick: () => void,
  opts?: { disabled?: boolean; attr?: Record<string, string> },
): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "slipstream-btn", text, attr: opts?.attr });
  if (opts?.disabled) button.disabled = true;
  button.addEventListener("click", onClick);
  return button;
}

class GroupNameModal extends Modal {
  private value: string;
  private errorEl?: HTMLElement;

  constructor(
    app: App,
    private titleKey: string,
    initialValue: string,
    private onSubmit: (name: string) => Promise<OutlineMutationResult>,
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h3", { text: t(this.titleKey) });
    const row = this.contentEl.createDiv({ cls: "slipstream-form-row" });
    row.createEl("label", { text: t("outline.groupName") });
    const input = row.createEl("input", {
      type: "text",
      attr: { placeholder: t("outline.groupNamePlaceholder"), "aria-label": t("outline.groupName") },
    });
    input.value = this.value;
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; this.value = input.value; });
    input.addEventListener("input", () => { this.value = input.value; });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !composing) { event.preventDefault(); void this.submit(input); }
    });
    this.errorEl = this.contentEl.createDiv({ cls: "slipstream-form-error", attr: { role: "status" } });
    const actions = this.contentEl.createDiv({ cls: "slipstream-prompt-actions" });
    mkBtn(actions, t("common.cancel"), () => this.close());
    mkBtn(actions, t("common.ok"), () => { void this.submit(input); });
    input.focus();
  }

  private async submit(input: HTMLInputElement): Promise<void> {
    if (/[\r\n]/.test(this.value) || !isValidGroupName(normalizeGroupName(this.value))) {
      this.errorEl?.setText(t("error.GROUP_NAME_INVALID"));
      input.focus();
      return;
    }
    const res = await this.onSubmit(normalizeGroupName(this.value));
    if (res.ok) { this.close(); return; }
    this.errorEl?.setText(t(`error.${res.code ?? "GROUP_NAME_INVALID"}`));
    input.focus();
  }
}

/** 书桌私有证据提纲面板：分组管理、条目整理、备注防抖保存、键盘焦点与列表窗口化。 */
export class OutlinePanel {
  readonly el: HTMLElement;
  private windowStart = 0;
  private selectedEntryId?: string;
  private expandedEntries = new Set<string>();
  private openMenuKey?: string;
  private pendingNotes = new Map<string, PendingNote>();
  private savingCount = 0;
  private lastError?: OutlineErrorCode;
  private disposed = false;
  private pendingFocus?: FocusTarget;

  constructor(private host: OutlinePanelHost) {
    this.el = createDiv({ cls: "slipstream-outline-panel is-hidden" });
    this.el.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.openMenuKey) return;
      event.stopPropagation();
      const closed = this.openMenuKey;
      this.openMenuKey = undefined;
      if (closed.startsWith("entry:")) this.pendingFocus = { kind: "entry", id: closed.slice(6), role: "menu" };
      else if (closed.startsWith("group:")) this.pendingFocus = { kind: "group", id: closed.slice(6), role: "menu" };
      this.render();
    });
  }

  destroy(): void {
    this.disposed = true;
    for (const pending of this.pendingNotes.values()) {
      if (pending.timer !== null) window.clearTimeout(pending.timer);
    }
    this.pendingNotes.clear();
  }

  openNewGroupDialog(): void {
    if (!this.host.currentDeskId() || this.host.isReadOnly()) {
      this.lastError = this.host.isReadOnly() ? "OUTLINE_READONLY" : "DESK_DELETED";
      this.render();
      return;
    }
    const groupId = `group-${crypto.randomUUID()}`;
    new GroupNameModal(this.host.app, "outline.newGroup", "", async (name) => {
      const res = await this.host.createGroup(name, groupId);
      if (res.ok) {
        this.lastError = res.saved ? undefined : res.code;
        if (res.group) this.pendingFocus = { kind: "group", id: res.group.id, role: "menu" };
        this.render();
      }
      return res;
    }).open();
  }

  selectEntry(entryId: string, focusRole: "menu" | "note" | "open" | "preview" = "open"): void {
    this.selectedEntryId = entryId;
    const data = this.host.getOutline();
    if (data) {
      const idx = this.orderedEntries(data.outline).findIndex((item) => item.id === entryId);
      if (idx >= 0 && (idx < this.windowStart || idx >= this.windowStart + OUTLINE_WINDOW_SIZE)) {
        this.windowStart = Math.floor(idx / OUTLINE_WINDOW_SIZE) * OUTLINE_WINDOW_SIZE;
      }
    }
    this.pendingFocus = { kind: "entry", id: entryId, role: focusRole };
    this.render();
  }

  async flushPendingNotes(): Promise<void> {
    for (const pending of [...this.pendingNotes.values()]) {
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
      await this.commitNote(pending.entryId);
    }
  }

  hasPendingNotes(): boolean {
    return this.pendingNotes.size > 0;
  }

  private orderedEntries(outline: EvidenceOutline): EvidenceEntry[] {
    const inbox = outline.entries.filter((entry) => entry.groupId === null);
    const grouped = outline.groups.flatMap((group) => outline.entries.filter((entry) => entry.groupId === group.id));
    return [...inbox, ...grouped];
  }

  private computeStatusText(): string {
    if (this.host.isReadOnly()) return t("outline.statusReadonly");
    if (this.savingCount > 0 || this.pendingNotes.size > 0) return t("outline.statusSaving");
    return this.host.isDirty() ? t("outline.statusUnsaved") : t("outline.statusSaved");
  }

  render(): void {
    if (this.disposed) return;
    this.el.empty();
    if (!this.host.currentDeskId()) {
      const empty = this.el.createDiv({ cls: "slipstream-state" });
      empty.createDiv({ text: t("outline.saveDeskFirst") });
      const actions = empty.createDiv({ cls: "slipstream-prompt-actions" });
      mkBtn(actions, t("desk.saveAs"), () => this.host.openCreateDesk());
      mkBtn(actions, t("outline.backToMaterials"), () => this.host.switchToMaterials());
      this.applyFocus();
      return;
    }

    const data = this.host.getOutline();
    if (!data) return;
    const { outline } = data;
    const ordered = this.orderedEntries(outline);
    const maxWindowStart = Math.max(0, Math.floor(Math.max(0, ordered.length - 1) / OUTLINE_WINDOW_SIZE) * OUTLINE_WINDOW_SIZE);
    if (this.windowStart > maxWindowStart) this.windowStart = maxWindowStart;

    const header = this.el.createDiv({ cls: "slipstream-outline-header" });
    const statusText = this.computeStatusText();
    const statusEl = header.createDiv({
      cls: `slipstream-outline-status${this.host.isDirty() || this.host.isReadOnly() ? " is-warning" : ""}`,
      text: this.lastError && this.lastError !== "OUTLINE_SAVE_FAILED" ? `${statusText} · ${t(`error.${this.lastError}`)}` : statusText,
      attr: { role: "status", "aria-live": "polite" },
    });
    if ((this.host.isDirty() || this.lastError === "OUTLINE_SAVE_FAILED") && !this.host.isReadOnly()) {
      mkBtn(header, t("outline.retrySave"), () => { void this.handleRetrySave(); });
    } else {
      void statusEl;
    }
    mkBtn(header, t("outline.newGroup"), () => this.openNewGroupDialog(), {
      disabled: this.host.isReadOnly(),
      attr: { "data-focus-target": "new-group" },
    });
    const hasContent = outline.groups.length > 0 || outline.entries.length > 0;
    mkBtn(header, t("outline.previewAll"), () => {
      void this.flushPendingNotes().then(() => this.host.openPreview({ kind: "all" }));
    }, { disabled: !hasContent });

    if (!this.host.recordingEnabled()) {
      this.el.createDiv({ cls: "slipstream-outline-badge", text: t("outline.recordingDisabledNotice") });
    }

    if (!hasContent) {
      const empty = this.el.createDiv({ cls: "slipstream-state" });
      empty.createDiv({ text: t("outline.emptyTitle") });
      empty.createDiv({ cls: "slipstream-anchor-status", text: t("outline.emptyHint") });
      const actions = empty.createDiv({ cls: "slipstream-prompt-actions" });
      mkBtn(actions, t("outline.backToMaterials"), () => this.host.switchToMaterials(), { attr: { "data-focus-target": "back" } });
      mkBtn(actions, t("outline.newGroup"), () => this.openNewGroupDialog(), { disabled: this.host.isReadOnly() });
      this.applyFocus();
      return;
    }

    const indexById = new Map<string, number>();
    ordered.forEach((entry, index) => indexById.set(entry.id, index));
    const windowEnd = Math.min(ordered.length, this.windowStart + OUTLINE_WINDOW_SIZE);

    if (ordered.length > OUTLINE_WINDOW_SIZE) this.renderWindowControls(ordered.length, windowEnd);
    const inbox = outline.entries.filter((entry) => entry.groupId === null);
    if (inbox.length > 0) this.renderZone(null, t("outline.collectionArea"), inbox, outline, indexById, windowEnd);
    outline.groups.forEach((group, groupIndex) => {
      const groupEntries = outline.entries.filter((entry) => entry.groupId === group.id);
      this.renderZone(group, group.name, groupEntries, outline, indexById, windowEnd, groupIndex);
    });
    if (ordered.length > OUTLINE_WINDOW_SIZE) this.renderWindowControls(ordered.length, windowEnd);
    this.applyFocus();
  }

  private renderWindowControls(total: number, windowEnd: number): void {
    const bar = this.el.createDiv({ cls: "slipstream-outline-window-controls" });
    bar.createSpan({ text: t("outline.windowInfo", { from: this.windowStart + 1, to: windowEnd, total }) });
    mkBtn(bar, t("outline.windowPrev"), () => {
      this.windowStart = Math.max(0, this.windowStart - OUTLINE_WINDOW_SIZE);
      this.render();
    }, { disabled: this.windowStart <= 0 });
    mkBtn(bar, t("outline.windowNext"), () => {
      this.windowStart = Math.min(total - 1, this.windowStart + OUTLINE_WINDOW_SIZE);
      this.render();
    }, { disabled: windowEnd >= total });
  }

  private renderZone(
    group: OutlineGroup | null,
    title: string,
    zoneEntries: EvidenceEntry[],
    outline: EvidenceOutline,
    indexById: Map<string, number>,
    windowEnd: number,
    groupIndex = -1,
  ): void {
    const section = this.el.createDiv({ cls: "slipstream-outline-group" });
    if (group) section.setAttribute("data-group-id", group.id);
    const header = section.createDiv({ cls: "slipstream-outline-group-header" });
    header.createSpan({ cls: "slipstream-outline-group-title", text: `${title} (${zoneEntries.length})` });

    const missingCount = zoneEntries.filter(
      (entry) => entry.snapshot.source.identity === "unconfirmed-after-loss" || this.host.isSourceMissing(entry.snapshot.source.path),
    ).length;
    if (group && zoneEntries.length === 0) {
      header.createSpan({ cls: "slipstream-outline-badge", text: t("outline.emptyGroup") });
    } else if (missingCount > 0) {
      header.createSpan({ cls: "slipstream-outline-badge is-stale", text: t("outline.pendingSources", { n: missingCount }) });
    }

    if (group) {
      mkBtn(header, t("outline.previewGroup"), () => {
        void this.flushPendingNotes().then(() => this.host.openPreview({ kind: "group", groupId: group.id }));
      }, { attr: { "data-focus-target": `group-preview:${group.id}` } });
      const menuKey = `group:${group.id}`;
      mkBtn(header, "⋯", () => {
        this.openMenuKey = this.openMenuKey === menuKey ? undefined : menuKey;
        this.pendingFocus = { kind: "group", id: group.id, role: "menu" };
        this.render();
      }, {
        attr: {
          "aria-label": t("outline.groupActions"),
          "aria-expanded": String(this.openMenuKey === menuKey),
          "data-focus-target": `group-menu:${group.id}`,
        },
      });
      if (this.openMenuKey === menuKey) {
        this.renderGroupMenu(section, group, zoneEntries.length, groupIndex, outline.groups.length);
      }
    }

    for (let idx = 0; idx < zoneEntries.length; idx++) {
      const entry = zoneEntries[idx];
      const gi = indexById.get(entry.id) ?? -1;
      if (gi >= this.windowStart && gi < windowEnd) this.renderEntry(section, entry, idx, zoneEntries, outline.groups);
    }

    if (zoneEntries.length > 0 && zoneEntries.every((entry) => {
      const gi = indexById.get(entry.id) ?? -1;
      return gi < this.windowStart || gi >= windowEnd;
    })) {
      const firstIdx = indexById.get(zoneEntries[0].id) ?? 0;
      mkBtn(section, t("outline.windowInfo", { from: firstIdx + 1, to: firstIdx + zoneEntries.length, total: indexById.size }), () => {
        this.windowStart = Math.floor(firstIdx / OUTLINE_WINDOW_SIZE) * OUTLINE_WINDOW_SIZE;
        this.pendingFocus = { kind: "entry", id: zoneEntries[0].id, role: "open" };
        this.render();
      });
    }
  }

  private renderGroupMenu(container: HTMLElement, group: OutlineGroup, entryCount: number, groupIndex: number, totalGroups: number): void {
    const bar = container.createDiv({ cls: "slipstream-outline-entry-actions", attr: { role: "menu" } });
    const readonly = this.host.isReadOnly();
    mkBtn(bar, t("outline.moveUp"), () => {
      void this.runMutation(() => this.host.moveGroup(group.id, "up"), { kind: "group", id: group.id, role: "menu" });
    }, { disabled: readonly || groupIndex <= 0 });
    mkBtn(bar, t("outline.moveDown"), () => {
      void this.runMutation(() => this.host.moveGroup(group.id, "down"), { kind: "group", id: group.id, role: "menu" });
    }, { disabled: readonly || groupIndex >= totalGroups - 1 });
    mkBtn(bar, t("outline.renameGroup"), () => {
      new GroupNameModal(this.host.app, "outline.renameGroup", group.name, async (name) => {
        const res = await this.host.renameGroup(group.id, name);
        if (res.ok) {
          this.lastError = res.saved ? undefined : res.code;
          this.pendingFocus = { kind: "group", id: group.id, role: "menu" };
          this.render();
        }
        return res;
      }).open();
    }, { disabled: readonly });
    mkBtn(bar, t("outline.deleteGroup"), () => { void this.handleDeleteGroup(group, entryCount); }, { disabled: readonly });
  }

  private renderEntry(container: HTMLElement, entry: EvidenceEntry, zoneIdx: number, zoneEntries: EvidenceEntry[], groups: OutlineGroup[]): void {
    const card = container.createDiv({ cls: `slipstream-outline-entry${this.selectedEntryId === entry.id ? " is-selected" : ""}` });
    card.setAttribute("data-entry-id", entry.id);

    const meta = card.createDiv({ cls: "slipstream-outline-entry-meta" });
    const heading = entry.snapshot.origins[0]?.heading;
    meta.createSpan({ text: heading ? `${entry.snapshot.source.path} › ${heading}` : entry.snapshot.source.path });
    const precisionKey = entry.snapshot.mode === "block"
      ? "precision.block"
      : entry.snapshot.origins.length > 1 ? "precision.multi-block-start" : "precision.fragment";
    meta.createSpan({ cls: "slipstream-outline-badge", text: t(precisionKey) });

    if (entry.snapshot.source.identity === "unconfirmed-after-loss" || this.host.isSourceMissing(entry.snapshot.source.path)) {
      meta.createSpan({ cls: "slipstream-outline-badge is-stale", text: t("error.SOURCE_MISSING") });
    }
    if (entry.lastInsertion) {
      const time = new Date(entry.lastInsertion.at).toLocaleString(getLang() === "zh" ? "zh-CN" : "en");
      const stale = entry.lastInsertion.contentRevision !== entry.contentRevision;
      meta.createSpan({
        cls: `slipstream-outline-badge${stale ? " is-stale" : ""}`,
        text: t(stale ? "outline.lastInsertedStale" : "outline.lastInserted", { path: entry.lastInsertion.targetPath, time }),
      });
    } else {
      meta.createSpan({ cls: "slipstream-outline-badge", text: t("outline.stateCollected") });
    }

    const fullContent = entry.snapshot.content;
    const isLong = fullContent.length > CONTENT_PREVIEW_LIMIT;
    const expanded = this.expandedEntries.has(entry.id);
    card.createDiv({ cls: "slipstream-outline-entry-content", text: isLong && !expanded ? fullContent.slice(0, CONTENT_PREVIEW_LIMIT) : fullContent });
    if (isLong) {
      mkBtn(card, t(expanded ? "outline.showLess" : "outline.showMore"), () => {
        if (expanded) this.expandedEntries.delete(entry.id);
        else this.expandedEntries.add(entry.id);
        this.render();
      });
    }

    const noteArea = card.createEl("textarea", {
      cls: "slipstream-outline-entry-note",
      attr: { placeholder: t("outline.notePlaceholder"), "aria-label": t("outline.noteLabel"), "data-focus-target": `entry-note:${entry.id}` },
    });
    const buffered = this.pendingNotes.get(entry.id);
    noteArea.value = buffered ? buffered.value : entry.note;
    noteArea.readOnly = this.host.isReadOnly();
    let composing = false;
    noteArea.addEventListener("compositionstart", () => { composing = true; });
    noteArea.addEventListener("compositionend", () => { composing = false; this.scheduleNoteSave(entry, noteArea.value); });
    noteArea.addEventListener("input", () => { if (!composing) this.scheduleNoteSave(entry, noteArea.value); });
    noteArea.addEventListener("blur", () => {
      if (composing) return;
      const pending = this.pendingNotes.get(entry.id);
      if (pending) {
        if (pending.timer !== null) { window.clearTimeout(pending.timer); pending.timer = null; }
        void this.commitNote(entry.id);
      }
    });

    const actions = card.createDiv({ cls: "slipstream-outline-entry-actions" });
    mkBtn(actions, t("outline.openSource"), () => { this.selectedEntryId = entry.id; this.host.openSource(entry); }, {
      attr: { "data-focus-target": `entry-open:${entry.id}` },
    });
    mkBtn(actions, t("outline.previewEntry"), () => {
      this.selectedEntryId = entry.id;
      void this.flushPendingNotes().then(() => this.host.openPreview({ kind: "entry", entryId: entry.id }));
    }, { attr: { "data-focus-target": `entry-preview:${entry.id}` } });

    const menuKey = `entry:${entry.id}`;
    mkBtn(actions, "⋯", () => {
      this.selectedEntryId = entry.id;
      this.openMenuKey = this.openMenuKey === menuKey ? undefined : menuKey;
      this.pendingFocus = { kind: "entry", id: entry.id, role: "menu" };
      this.render();
    }, {
      attr: { "aria-label": t("outline.entryActions"), "aria-expanded": String(this.openMenuKey === menuKey), "data-focus-target": `entry-menu:${entry.id}` },
    });

    if (this.openMenuKey === menuKey) this.renderEntryMenu(card, entry, zoneIdx, zoneEntries, groups);
  }

  private renderEntryMenu(container: HTMLElement, entry: EvidenceEntry, zoneIdx: number, zoneEntries: EvidenceEntry[], groups: OutlineGroup[]): void {
    const menu = container.createDiv({ cls: "slipstream-outline-entry-actions", attr: { role: "menu" } });
    const readonly = this.host.isReadOnly();
    mkBtn(menu, t("outline.moveUp"), () => {
      void this.runMutation(() => this.host.moveEntry(entry.id, undefined, "up"), { kind: "entry", id: entry.id, role: "menu" });
    }, { disabled: readonly || zoneIdx <= 0 });
    mkBtn(menu, t("outline.moveDown"), () => {
      void this.runMutation(() => this.host.moveEntry(entry.id, undefined, "down"), { kind: "entry", id: entry.id, role: "menu" });
    }, { disabled: readonly || zoneIdx >= zoneEntries.length - 1 });

    if (entry.groupId !== null) {
      mkBtn(menu, t("outline.moveToCollection"), () => {
        this.openMenuKey = undefined;
        void this.runMutation(() => this.host.moveEntry(entry.id, null), { kind: "entry", id: entry.id, role: "open" });
      }, { disabled: readonly });
    }
    const targets = groups.filter((group) => group.id !== entry.groupId);
    if (targets.length > 0) {
      const select = menu.createEl("select", { attr: { "aria-label": t("outline.moveToGroup") } });
      select.createEl("option", { value: "", text: t("outline.moveToGroup") });
      for (const group of targets) select.createEl("option", { value: group.id, text: group.name });
      select.disabled = readonly;
      select.addEventListener("change", () => {
        if (!select.value) return;
        this.openMenuKey = undefined;
        void this.runMutation(() => this.host.moveEntry(entry.id, select.value), { kind: "entry", id: entry.id, role: "open" });
      });
    }
    mkBtn(menu, t("outline.removeEntry"), () => { void this.handleRemoveEntry(entry, zoneIdx, zoneEntries); }, { disabled: readonly });
  }

  private scheduleNoteSave(entry: EvidenceEntry, value: string): void {
    const existing = this.pendingNotes.get(entry.id);
    if (existing?.timer !== null && existing?.timer !== undefined) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      const current = this.pendingNotes.get(entry.id);
      if (current) current.timer = null;
      void this.commitNote(entry.id);
    }, NOTE_DEBOUNCE_MS);
    this.pendingNotes.set(entry.id, { entryId: entry.id, expectedContentRevision: existing?.expectedContentRevision ?? entry.contentRevision, value, timer });
    this.refreshStatusNode();
  }

  private refreshStatusNode(): void {
    const statusEl = this.el.querySelector(".slipstream-outline-status");
    if (!statusEl) return;
    statusEl.setText(this.computeStatusText());
    statusEl.toggleClass("is-warning", this.host.isDirty() || this.host.isReadOnly());
  }

  private async commitNote(entryId: string): Promise<void> {
    const pending = this.pendingNotes.get(entryId);
    if (!pending) return;
    const currentEntry = this.host.getOutline()?.outline.entries.find((item) => item.id === entryId);
    if (!currentEntry || currentEntry.note === pending.value) {
      this.pendingNotes.delete(entryId);
      this.updateStatusAfterSave();
      return;
    }
    const submittedValue = pending.value;
    this.savingCount++;
    try {
      const res = await this.host.setNote(entryId, currentEntry.contentRevision, submittedValue, true);
      if (this.disposed) return;
      const latest = this.pendingNotes.get(entryId);
      if (latest && latest.value === submittedValue) this.pendingNotes.delete(entryId);
      else if (latest && res.entry) latest.expectedContentRevision = res.entry.contentRevision;
      this.lastError = res.ok && res.saved ? undefined : res.code;
    } finally {
      this.savingCount = Math.max(0, this.savingCount - 1);
      if (!this.disposed) this.updateStatusAfterSave();
    }
  }

  private updateStatusAfterSave(): void {
    if (this.el.ownerDocument.activeElement?.classList.contains("slipstream-outline-entry-note")) {
      this.refreshStatusNode();
      return;
    }
    this.render();
  }

  private async runMutation(action: () => Promise<OutlineMutationResult>, focusTarget: FocusTarget): Promise<void> {
    await this.flushPendingNotes();
    const res = await action();
    if (this.disposed) return;
    this.lastError = res.ok && res.saved ? undefined : res.code;
    this.pendingFocus = focusTarget;
    if (focusTarget.kind === "entry") this.selectEntry(focusTarget.id, focusTarget.role);
    else this.render();
  }

  private async handleDeleteGroup(group: OutlineGroup, entryCount: number): Promise<void> {
    if (entryCount > 0) {
      const choice = await citationPrompt(this.host.app, t("outline.deleteGroupConfirm", { name: group.name, n: entryCount }), [{ id: "delete", label: t("outline.deleteGroup") }]);
      if (!choice) return;
    }
    this.openMenuKey = undefined;
    await this.runMutation(() => this.host.removeGroup(group.id), { kind: "new-group" });
  }

  private async handleRemoveEntry(entry: EvidenceEntry, zoneIdx: number, zoneEntries: EvidenceEntry[]): Promise<void> {
    const choice = await citationPrompt(this.host.app, t("outline.removeEntryConfirm"), [{ id: "remove", label: t("outline.removeEntry") }]);
    if (!choice) return;
    const neighbor = zoneEntries[zoneIdx + 1] ?? zoneEntries[zoneIdx - 1];
    this.openMenuKey = undefined;
    await this.runMutation(() => this.host.removeEntry(entry.id), neighbor ? { kind: "entry", id: neighbor.id, role: "open" } : { kind: "new-group" });
  }

  private async handleRetrySave(): Promise<void> {
    await this.flushPendingNotes();
    await this.host.retrySave();
    this.lastError = this.host.isDirty() ? "OUTLINE_SAVE_FAILED" : undefined;
    this.render();
  }

  private applyFocus(): void {
    const target = this.pendingFocus;
    this.pendingFocus = undefined;
    if (!target) return;
    const selector = target.kind === "new-group"
      ? '[data-focus-target="new-group"]'
      : target.kind === "back"
        ? '[data-focus-target="back"]'
        : target.kind === "group"
          ? `[data-focus-target="group-${target.role}:${target.id}"]`
          : `[data-focus-target="entry-${target.role}:${target.id}"]`;
    this.el.querySelector<HTMLElement>(selector)?.focus();
  }
}
