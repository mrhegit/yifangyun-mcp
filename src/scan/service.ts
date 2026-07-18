import type { AccessRegistry } from "../runtime/access.js";
import type { IdLike, JsonObject } from "../types.js";
import { logEvent, metrics } from "../observability.js";
import { YifangyunError } from "../client.js";
import { ScopeScanEngine } from "./engine.js";
import type { ScopeItemCursor, ScopeItemPage, ScopeScanPolicy, ScopeScanRepository, ScopeScanState } from "./types.js";

export interface CreateSnapshotInput {
  accessContextId: string;
  caseSensitive?: boolean;
  includeFiles: boolean;
  includeFolders: boolean;
  matchFields?: Array<"name" | "path">;
  maxAgeSeconds?: number;
  forceRefresh?: boolean;
  maxItemDepth: number;
  maxItems: number;
  pageCapacity: number;
  rootFolderId: string;
  signal?: AbortSignal;
  workspaceFingerprint?: string;
  workspaceId?: string;
  workspaceRef?: string;
}

export class SnapshotService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly workers = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly engine: ScopeScanEngine,
    private readonly repository: ScopeScanRepository,
    private readonly access: AccessRegistry,
    private readonly concurrency = 1
  ) {}

  async initialize(): Promise<void> {
    await this.repository.pruneExpired();
    for (const state of await this.repository.listRunnable()) {
      this.launch(state.scanId);
    }
  }

  async create(input: CreateSnapshotInput): Promise<{ reuseReason: "fresh_complete" | "running_join" | "new"; reused: boolean; state: ScopeScanState }> {
    const resolved = this.access.resolveContext(input.accessContextId);
    const policy: ScopeScanPolicy = {
      includeFiles: input.includeFiles,
      includeFolders: input.includeFolders,
      maxItemDepth: input.maxItemDepth,
      maxItems: input.maxItems,
      pageCapacity: input.pageCapacity
    };
    const started = await this.engine.start({
      accessContextId: resolved.context.id,
      accessIdentityRef: resolved.identityRef,
      externalEnterpriseId: resolved.context.externalEnterpriseId,
      forceRefresh: input.forceRefresh,
      maxAgeSeconds: input.maxAgeSeconds ?? 300,
      policy,
      rootFolderId: input.rootFolderId,
      signal: input.signal,
      userId: resolved.context.userId,
      workspaceFingerprint: input.workspaceFingerprint ?? `internal:${resolved.identityRef}:${input.rootFolderId}`,
      workspaceId: input.workspaceId ?? "internal",
      workspaceRef: input.workspaceRef ?? "workspace:internal"
    });
    this.launch(started.state.scanId);
    return started;
  }

  async get(scanId: string, accessContextId?: string): Promise<ScopeScanState> {
    const state = await this.engine.get(scanId);
    this.assertAccess(state, accessContextId);
    return state;
  }

  async query(input: {
    accessContextId?: string;
    cursor?: ScopeItemCursor;
    limit: number;
    mode: "search" | "list";
    queries?: string[];
    matchFields?: Array<"name" | "path">;
    caseSensitive?: boolean;
    scanId: string;
    type?: "file" | "folder" | "all";
  }): Promise<ScopeItemPage & { state: ScopeScanState }> {
    const state = await this.get(input.scanId, input.accessContextId);
    const watermark = input.cursor?.watermark ?? state.commitWatermark;
    if (watermark > state.commitWatermark) throw new YifangyunError("Inventory cursor references an uncommitted observation watermark.", { code: "YFY_INVENTORY_CURSOR_INVALID", phase: "inventory_query", scanId: state.scanId });
    const queries = input.queries ?? [];
    if (input.mode === "search" && queries.length === 0) throw new YifangyunError("Inventory search requires at least one query.", { code: "YFY_INVENTORY_QUERY_EMPTY", phase: "inventory_query", scanId: state.scanId });
    const result = input.mode === "search"
      ? await this.engine.search(input.scanId, queries, input.matchFields ?? ["name", "path"], input.caseSensitive ?? false, input.type ?? "all", input.cursor, input.limit, watermark)
      : await this.engine.listItems(input.scanId, input.type ?? "all", input.cursor, input.limit, watermark);
    return { ...result, ...(result.nextCursor ? { nextCursor: { ...result.nextCursor, watermark } } : {}), state };
  }

  async cancel(scanId: string, accessContextId?: string): Promise<ScopeScanState> {
    const state = await this.get(scanId, accessContextId);
    if (["complete", "partial", "cancelled", "failed"].includes(state.status)) return state;
    this.controllers.get(scanId)?.abort("snapshot cancelled");
    return this.engine.cancel(scanId);
  }

  summary(state: ScopeScanState): JsonObject {
    return this.engine.summary(state);
  }

  async manifest(scanId: string, accessContextId?: string): Promise<JsonObject> {
    await this.get(scanId, accessContextId);
    return this.engine.manifest(scanId);
  }

  async receipts(scanId: string, accessContextId: string, page: number, pageSize = 25) {
    await this.get(scanId, accessContextId);
    return this.repository.listReceiptSummary(scanId, page * pageSize, pageSize);
  }

  async release(scanId: string, accessContextId: string): Promise<boolean> {
    try {
      await this.get(scanId, accessContextId);
    } catch (error) {
      if (error instanceof YifangyunError && error.code === "YFY_INVENTORY_NOT_FOUND") return false;
      throw error;
    }
    const worker = this.workers.get(scanId);
    this.controllers.get(scanId)?.abort("inventory released");
    await worker;
    return this.repository.release(scanId);
  }

  storageStats() {
    return this.repository.storageStats();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers.values()) {
      controller.abort("server closing");
    }
    await Promise.allSettled(this.workers.values());
    this.repository.close();
  }

  async waitForIdle(scanId: string): Promise<void> {
    await this.workers.get(scanId);
  }

  private launch(scanId: string): void {
    if (this.closed || this.workers.has(scanId)) {
      return;
    }
    const controller = new AbortController();
    this.controllers.set(scanId, controller);
    const worker = this.run(scanId, controller.signal)
      .catch(async (error) => {
        metrics.increment("snapshot_worker_failure_total");
        logEvent("error", "snapshot_worker_failed", { error: error instanceof Error ? error.message : String(error), snapshot_id: scanId });
        await this.engine.fail(scanId, error).catch((failure) => {
          logEvent("error", "snapshot_failure_state_write_failed", { error: failure instanceof Error ? failure.message : String(failure), snapshot_id: scanId });
        });
      })
      .finally(() => {
        this.controllers.delete(scanId);
        this.workers.delete(scanId);
      });
    this.workers.set(scanId, worker);
  }

  private async run(scanId: string, signal: AbortSignal): Promise<void> {
    let retryCount = 0;
    while (!signal.aborted && !this.closed) {
      const state = await this.engine.get(scanId);
      if (!["running", "retry_wait"].includes(state.status)) {
        return;
      }
      const access = this.access.resolveContext(state.accessContextId);
      const advanced = await this.engine.advance({
        expectedRevision: state.revision,
        maxConcurrentPages: this.concurrency,
        maxPages: 10,
        maxWallMs: 30000,
        scanId,
        signal,
        userId: access.context.userId as IdLike
      });
      if (advanced.status === "retry_wait") {
        retryCount = advanced.retryCount + 1;
        if (retryCount > 3) {
          await this.engine.fail(scanId, new YifangyunError("Inventory retry budget was exhausted.", { code: "YFY_INVENTORY_RETRY_EXHAUSTED", phase: "inventory_worker" }));
          return;
        }
        const delayMs = Math.min(5000, 250 * 2 ** retryCount);
        await this.engine.scheduleRetry(scanId, retryCount, new Date(Date.now() + delayMs).toISOString());
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const timeout = setTimeout(resolve, delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      } else {
        retryCount = 0;
        if (advanced.status === "complete") await this.repository.pruneSuperseded(advanced.workspaceFingerprint, advanced.policyHash, advanced.scanId);
      }
    }
  }

  private assertAccess(state: ScopeScanState, accessContextId?: string): void {
    const requested = accessContextId ?? this.access.resolveContext().context.id;
    const resolved = this.access.resolveContext(requested);
    if (state.accessContextId !== resolved.context.id || state.accessIdentityRef !== resolved.identityRef) {
      throw new YifangyunError("Inventory belongs to a different access context.", {
        code: "YFY_INVENTORY_ACCESS_DENIED",
        phase: "inventory_access",
        scanId: state.scanId
      });
    }
  }
}
