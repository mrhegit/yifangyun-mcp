import { Worker } from "node:worker_threads";
import { YifangyunError } from "../errors.js";
import type { JsonObject } from "../types.js";
import type { ScopeItemCursor, ScopeItemPage, ScopePageArtifact, ScopePageReceipt, ScopeScanFrontier, ScopeScanRepository, ScopeScanState, ScopeSeenItem } from "./types.js";

interface WorkerFailure {
  agentDetails?: JsonObject;
  code?: string;
  details?: JsonObject;
  message: string;
  name?: string;
  phase?: string;
  retryAfterMs?: number;
  retryable?: boolean;
  scanId?: string;
  statusCode?: number;
  suggestedAction?: string;
}

interface WorkerResponse {
  error?: WorkerFailure;
  id: number;
  state?: ScopeScanState;
  value?: unknown;
}

export class WorkerScopeScanStore implements ScopeScanRepository {
  private closePromise?: Promise<void>;
  private closed = false;
  private readonly locks = new Map<string, Promise<void>>();
  private nextId = 1;
  private readonly pending = new Map<number, { reject: (error: unknown) => void; resolve: (response: WorkerResponse) => void }>();
  private terminalError?: Error;

  private constructor(private readonly worker: Worker, private readonly ttlSeconds: number) {
    worker.on("message", (response: WorkerResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(this.toError(response.error));
      else pending.resolve(response);
    });
    worker.on("error", (error) => this.markTerminated(error));
    worker.on("exit", (code) => this.markTerminated(new Error(`Inventory store worker exited with code ${code}.`)));
  }

  static async create(databasePath: string, ttlSeconds: number, maxBytes: number): Promise<WorkerScopeScanStore> {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(new URL(`./storeWorker.${extension}`, import.meta.url));
    const store = new WorkerScopeScanStore(worker, ttlSeconds);
    try {
      await store.request("initialize", [databasePath, ttlSeconds, maxBytes]);
      return store;
    } catch (error) {
      store.closed = true;
      await worker.terminate();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      try {
        if (!this.terminalError) {
          await this.request("close", [], true);
        }
      } catch (error) {
        if (!this.terminalError) throw error;
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closePromise;
  }

  async create(state: ScopeScanState, frontier: ScopeScanFrontier[]): Promise<void> { await this.requestWithState("create", [state, frontier], state); }
  async load(scanId: string): Promise<ScopeScanState> { return this.value("load", [scanId]); }
  async save(state: ScopeScanState): Promise<void> { await this.requestWithState("save", [state], state); }
  async commitPage(scanId: string, artifact: ScopePageArtifact, seenItems: ScopeSeenItem[], state: ScopeScanState, current: ScopeScanFrontier, append: ScopeScanFrontier[]): Promise<void> { await this.requestWithState("commitPage", [scanId, artifact, seenItems, state, current, append], state); }
  async peekFrontier(scanId: string, limit: number): Promise<ScopeScanFrontier[]> { return this.value("peekFrontier", [scanId, limit]); }
  async updateFrontier(scanId: string, cursor: ScopeScanFrontier): Promise<void> { await this.value("updateFrontier", [scanId, cursor]); }
  async removeFrontier(scanId: string, cursor: ScopeScanFrontier, state: ScopeScanState): Promise<void> { await this.requestWithState("removeFrontier", [scanId, cursor, state], state); }
  async findSeenItems(scanId: string, itemIds: string[]): Promise<Map<string, ScopeSeenItem>> { return this.value("findSeenItems", [scanId, itemIds]); }
  async observedItemCount(scanId: string, folderId: string): Promise<number> { return this.value("observedItemCount", [scanId, folderId]); }
  async hasPage(scanId: string, pageKey: string): Promise<boolean> { return this.value("hasPage", [scanId, pageKey]); }
  async listReceiptSummary(scanId: string, offset: number, limit: number): Promise<{ receipts: ScopePageReceipt[]; total: number }> { return this.value("listReceiptSummary", [scanId, offset, limit]); }
  async findReusable(workspaceFingerprint: string, policyHash: string, updatedAfterMs: number): Promise<ScopeScanState | undefined> { return this.value("findReusable", [workspaceFingerprint, policyHash, updatedAfterMs]); }
  async pruneExpired(): Promise<void> { await this.value("pruneExpired", []); }
  async pruneSuperseded(workspaceFingerprint: string, policyHash: string, keepScanId: string): Promise<void> { await this.value("pruneSuperseded", [workspaceFingerprint, policyHash, keepScanId]); }
  async release(scanId: string): Promise<boolean> { return this.value("release", [scanId]); }
  async listRunnable(): Promise<ScopeScanState[]> { return this.value("listRunnable", []); }
  async searchItems(scanId: string, queries: Array<{ normalized: string; original: string }>, matchFields: Array<"name" | "path">, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number, caseSensitive: boolean, watermark: number): Promise<ScopeItemPage> { return this.value("searchItems", [scanId, queries, matchFields, type, cursor, limit, caseSensitive, watermark]); }
  async listItems(scanId: string, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number, watermark: number): Promise<ScopeItemPage> { return this.value("listItems", [scanId, type, cursor, limit, watermark]); }
  async storageStats(): Promise<{ database_bytes: number; logical_bytes: number; wal_bytes: number }> { return this.value("storageStats", []); }

  makeExpiry(now = Date.now()): string { return new Date(now + this.ttlSeconds * 1000).toISOString(); }

  async withLock<T>(scanId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scanId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.locks.set(scanId, chain);
    await previous;
    try { return await work(); } finally {
      release();
      if (this.locks.get(scanId) === chain) this.locks.delete(scanId);
    }
  }

  private async request(method: string, args: unknown[], allowClosed = false): Promise<WorkerResponse> {
    if (this.terminalError) throw this.terminalError;
    if (this.closed && !allowClosed) throw new Error("Inventory store worker is closed.");
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        this.worker.postMessage({ args, id, method });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async requestWithState(method: string, args: unknown[], state: ScopeScanState): Promise<void> {
    const response = await this.request(method, args);
    if (response.state) Object.assign(state, response.state);
  }

  private async value<T>(method: string, args: unknown[]): Promise<T> {
    return (await this.request(method, args)).value as T;
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private markTerminated(error: Error): void {
    this.terminalError ??= error;
    this.rejectPending(this.terminalError);
  }

  private toError(error: WorkerFailure): Error {
    if (error.name === "YifangyunError" || error.code?.startsWith("YFY_")) {
      return new YifangyunError(error.message, {
        agentDetails: error.agentDetails,
        code: error.code,
        details: error.details,
        phase: error.phase,
        retryAfterMs: error.retryAfterMs,
        retryable: error.retryable,
        scanId: error.scanId,
        statusCode: error.statusCode,
        suggestedAction: error.suggestedAction
      });
    }
    return new Error(error.message);
  }
}
