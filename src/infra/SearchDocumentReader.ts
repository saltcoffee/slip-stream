import { getFrontMatterInfo } from "obsidian";
import type { EditorGateway } from "./EditorGateway";

export interface SearchDocument {
  fileRef: string;
  path: string;
  text: string;
  bodyStart: number;
  version: number;
}

interface Cached {
  version: number;
  doc: SearchDocument;
  bytes: number;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  cleanup?: () => void;
}

function cancelled(): Error {
  const error = new Error("OPERATION_CANCELLED");
  error.name = "AbortError";
  return error;
}

/**
 * 复用 EditorGateway 读取一致快照（已打开缓冲区优先，否则 vault.read），
 * 按内容代际缓存并在预算内 LRU 淘汰；所有查询共享在途读取槽位。
 */
export class SearchDocumentReader {
  private cache = new Map<string, Cached>();
  private versions = new Map<string, number>();
  private totalBytes = 0;
  private active = 0;
  private waiters: Waiter[] = [];
  private static readonly MAX_SLOTS = 3;

  constructor(private editors: EditorGateway, private maxBytes = 32 * 1024 * 1024) {}

  version(fileRef: string): number { return this.versions.get(fileRef) ?? 0; }

  /** 正文内容代际变化（Vault modify/create/delete 或明确的 docChanged）。 */
  invalidate(fileRef?: string): void {
    if (fileRef) {
      this.versions.set(fileRef, this.version(fileRef) + 1);
      this.evict(fileRef);
      return;
    }
    for (const key of [...this.versions.keys()]) this.versions.set(key, this.version(key) + 1);
    for (const key of [...this.cache.keys()]) this.evict(key);
  }

  invalidatePath(path: string): void {
    for (const [fileRef, cached] of [...this.cache]) if (cached.doc.path === path) this.invalidate(fileRef);
  }

  /** 读取时传入取消信号；排队中已取消的读取不会实际访问来源。 */
  async read(fileRef: string, signal?: AbortSignal): Promise<SearchDocument> {
    await this.acquire(signal);
    try {
      if (signal?.aborted) throw cancelled();
      const version = this.version(fileRef);
      const cached = this.cache.get(fileRef);
      if (cached && cached.version === version) return cached.doc;
      const text = await this.editors.readSource(fileRef);
      if (signal?.aborted) throw cancelled();
      const path = this.editors.path(fileRef);
      const doc: SearchDocument = { fileRef, path, text, bodyStart: getFrontMatterInfo(text).contentStart, version };
      // 读取期间内容已变：不要把旧内容标成当前版本缓存。
      if (this.version(fileRef) === version) this.put(fileRef, { version, doc, bytes: text.length * 2 });
      else this.evict(fileRef);
      return doc;
    } finally {
      this.release();
    }
  }

  clear(): void { this.cache.clear(); this.totalBytes = 0; }

  private put(key: string, entry: Cached): void {
    this.evict(key);
    if (entry.bytes > this.maxBytes) return; // 单文件超预算时可扫描但不缓存
    let overflow = this.totalBytes + entry.bytes - this.maxBytes;
    for (const oldest of this.cache.keys()) {
      if (overflow <= 0) break;
      const removed = this.cache.get(oldest);
      if (!removed) continue;
      this.evict(oldest);
      overflow -= removed.bytes;
    }
    this.cache.set(key, entry);
    this.totalBytes += entry.bytes;
  }

  private evict(key: string): void {
    const existing = this.cache.get(key);
    if (!existing) return;
    this.totalBytes -= existing.bytes;
    this.cache.delete(key);
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.active < SearchDocumentReader.MAX_SLOTS) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(cancelled());
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      waiter.cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    while (this.waiters.length) {
      const next = this.waiters.shift()!;
      next.cleanup?.();
      if (next.signal?.aborted) { next.reject(cancelled()); continue; }
      next.resolve(); // 槽位移交，active 保持不变
      return;
    }
    this.active--;
  }
}
