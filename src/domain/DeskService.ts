import type { PluginDataStore, SaveReceipt } from "../infra/PluginDataStore";
import type { Desk, DeskReadingState, DeskRule, ReadingAnchor, UnresolvedRef } from "./deskTypes";
import { cloneDesk, createDesk, createDeskRule, isValidDeskName, normalizeDeskName, ruleSignature } from "./deskTypes";

export type DeskEditResult = "ok" | "duplicateName" | "invalidName" | "missing";

/**
 * 书桌配置的唯一修改入口。所有改动经 PluginDataStore 串行落盘，
 * 以根修订号区分“已保存”和“仍有未保存修改”，不把内存状态冒充已落盘。
 */
export class DeskService {
  /** 每张书桌最近一次修改所在的根修订号。 */
  private dirtyRevision = new Map<string, number>();
  /** 每张书桌的生命周期代际；删除后旧回调不得复活。 */
  private lifecycle = new Map<string, number>();

  constructor(private store: PluginDataStore) {}

  list(): Desk[] { return this.store.data.desks; }

  get(id: string | undefined): Desk | undefined {
    if (!id) return undefined;
    return this.store.data.desks.find((desk) => desk.id === id);
  }

  recent(limit = 10): Desk[] {
    return [...this.store.data.desks].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, limit);
  }

  generation(id: string): number { return this.lifecycle.get(id) ?? 0; }
  exists(id: string): boolean { return this.store.data.desks.some((desk) => desk.id === id); }
  isDirty(id: string): boolean { return this.store.persistedRevision < (this.dirtyRevision.get(id) ?? 0); }

  private nameTaken(name: string, exceptId?: string): boolean {
    const wanted = normalizeDeskName(name).toLowerCase();
    return this.store.data.desks.some((desk) => desk.id !== exceptId && desk.name.trim().toLowerCase() === wanted);
  }

  /** 首次保存与重试复用同一 deskId：存在则更新，不存在才新建。 */
  async create(input: { id?: string; name: string; targetPath: string; rules?: DeskRule[]; manualPaths?: string[]; reading?: Partial<DeskReadingState> }): Promise<{ desk?: Desk; saved: boolean; result: DeskEditResult }> {
    const name = normalizeDeskName(input.name);
    if (!isValidDeskName(name)) return { saved: false, result: "invalidName" };
    if (!input.targetPath) return { saved: false, result: "invalidName" };
    const existing = this.get(input.id);
    if (this.nameTaken(name, existing?.id)) return { saved: false, result: "duplicateName" };
    let desk: Desk;
    if (existing) {
      existing.name = name;
      existing.targetPath = input.targetPath;
      if (input.rules) existing.rules = input.rules;
      if (input.manualPaths) existing.manualPaths = input.manualPaths;
      if (input.reading) Object.assign(existing.reading, input.reading);
      existing.updatedAt = Date.now();
      desk = existing;
    } else {
      desk = createDesk({ id: input.id, name, targetPath: input.targetPath, rules: input.rules, manualPaths: input.manualPaths, reading: input.reading });
      this.store.data.desks.push(desk);
      this.lifecycle.set(desk.id, this.generation(desk.id));
    }
    this.touch(desk.id);
    try {
      await this.store.save();
      this.markPersisted(desk.id);
      return { desk, saved: true, result: "ok" };
    } catch {
      return { desk, saved: false, result: "ok" };
    }
  }

  async save(id: string): Promise<{ saved: boolean; receipt?: SaveReceipt }> {
    if (!this.exists(id)) return { saved: false };
    try {
      const receipt = await this.store.save();
      if (this.store.isPersisted(this.dirtyRevision.get(id) ?? 0)) this.dirtyRevision.delete(id);
      return { saved: true, receipt };
    } catch {
      return { saved: false };
    }
  }

  private touch(id: string): void {
    const revision = this.store.touch();
    this.dirtyRevision.set(id, revision);
  }

  private markPersisted(id: string): void {
    if (this.store.isPersisted(this.dirtyRevision.get(id) ?? 0)) this.dirtyRevision.delete(id);
  }

  async mutate(id: string, change: (desk: Desk) => void, persist = true): Promise<boolean> {
    const desk = this.get(id);
    if (!desk) return false;
    change(desk);
    desk.updatedAt = Date.now();
    this.touch(id);
    if (!persist) return true;
    try { await this.store.save(); this.markPersisted(id); return true; } catch { return false; }
  }

  /** 只改内存、由调用方在合适时机保存（例如阅读状态节流保存）。 */
  markDirty(id: string, change: (desk: Desk) => void): void {
    const desk = this.get(id);
    if (!desk) return;
    change(desk);
    desk.updatedAt = Date.now();
    this.touch(id);
  }

  async rename(id: string, rawName: string): Promise<DeskEditResult> {
    const desk = this.get(id);
    if (!desk) return "missing";
    const name = normalizeDeskName(rawName);
    if (!isValidDeskName(name)) return "invalidName";
    if (this.nameTaken(name, id)) return "duplicateName";
    await this.mutate(id, (target) => { target.name = name; });
    return "ok";
  }

  async setTarget(id: string, targetPath: string): Promise<void> {
    await this.mutate(id, (desk) => {
      if (desk.targetPath !== targetPath) { desk.targetPath = targetPath; desk.anchor = undefined; }
    });
  }

  async open(id: string): Promise<void> {
    const desk = this.get(id);
    if (!desk) return;
    desk.lastOpenedAt = Date.now();
    this.touch(id);
    try { await this.store.save(); this.markPersisted(id); } catch { /* 打开失败仍允许继续使用，仅显示未保存 */ }
  }

  addRule(id: string, spec: DeskRule["spec"]): DeskRule | undefined {
    const desk = this.get(id);
    if (!desk) return;
    const signature = ruleSignature(spec);
    if (desk.rules.some((rule) => ruleSignature(rule.spec) === signature)) return;
    const rule = createDeskRule(spec);
    desk.rules.push(rule);
    this.touch(id);
    return rule;
  }

  removeRule(id: string, ruleId: string): void {
    const desk = this.get(id);
    if (!desk) return;
    desk.rules = desk.rules.filter((rule) => rule.id !== ruleId);
    this.touch(id);
  }

  addManual(id: string, path: string): void {
    const desk = this.get(id);
    if (!desk || desk.manualPaths.includes(path)) return;
    desk.manualPaths.push(path);
    this.touch(id);
  }

  removeManual(id: string, path: string): void {
    const desk = this.get(id);
    if (!desk) return;
    desk.manualPaths = desk.manualPaths.filter((item) => item !== path);
    this.touch(id);
  }

  setAnchor(id: string, anchor: ReadingAnchor | undefined): void {
    const desk = this.get(id);
    if (!desk) return;
    desk.anchor = anchor;
    this.touch(id);
  }

  setUnresolved(id: string, refs: UnresolvedRef[]): void {
    const desk = this.get(id);
    if (!desk) return;
    desk.unresolvedRefs = refs;
    this.touch(id);
  }

  async delete(id: string): Promise<void> {
    const index = this.store.data.desks.findIndex((desk) => desk.id === id);
    if (index < 0) return;
    this.store.data.desks.splice(index, 1);
    this.lifecycle.set(id, this.generation(id) + 1);
    this.dirtyRevision.delete(id);
    this.store.touch();
    try { await this.store.save(); } catch { /* 删除失败仍会保留在内存之外，下次保存重试 */ }
  }

  snapshot(id: string): Desk | undefined {
    const desk = this.get(id);
    return desk ? cloneDesk(desk) : undefined;
  }

  /** 真实改名事件：按精确路径或目录前缀边界更新全部相关路径。 */
  async renamePaths(oldPath: string, newPath: string, isFolder: boolean): Promise<void> {
    const map = (path: string): string => {
      if (path === oldPath) return newPath;
      if (isFolder && path.startsWith(oldPath + "/")) return newPath + path.slice(oldPath.length);
      return path;
    };
    let changed = false;
    const mapArray = (values: string[]): string[] => {
      const mapped = values.map(map);
      if (mapped.some((value, index) => value !== values[index])) changed = true;
      return mapped;
    };
    for (const desk of this.store.data.desks) {
      const target = map(desk.targetPath);
      if (target !== desk.targetPath) { desk.targetPath = target; changed = true; }
      for (const rule of desk.rules) {
        if (rule.spec.kind === "folder" || rule.spec.kind === "backlinks" || rule.spec.kind === "outlinks") {
          const value = map(rule.spec.value);
          if (value !== rule.spec.value) { rule.spec.value = value; changed = true; }
        }
        if (rule.spec.anchorFile) {
          const anchor = map(rule.spec.anchorFile);
          if (anchor !== rule.spec.anchorFile) { rule.spec.anchorFile = anchor; changed = true; }
        }
      }
      desk.manualPaths = mapArray(desk.manualPaths);
      desk.reading.pinned = mapArray(desk.reading.pinned);
      desk.reading.collapsed = mapArray(desk.reading.collapsed);
      desk.reading.compactExpanded = mapArray(desk.reading.compactExpanded);
      desk.reading.dismissed = mapArray(desk.reading.dismissed);
      desk.reading.customOrder = mapArray(desk.reading.customOrder);
      if (desk.anchor) {
        const filePath = map(desk.anchor.filePath);
        if (filePath !== desk.anchor.filePath) { desk.anchor.filePath = filePath; changed = true; }
        desk.anchor.neighborPaths = mapArray(desk.anchor.neighborPaths);
      }
      for (const ref of desk.unresolvedRefs) {
        const path = map(ref.path);
        if (path !== ref.path) { ref.path = path; changed = true; }
      }
      if (changed) desk.updatedAt = Date.now();
    }
    if (changed) {
      this.store.touch();
      try { await this.store.save(); } catch { /* 保存失败保留内存修改 */ }
    }
  }
}
