import type { AccessRegistry } from "../runtime/access.js";
import type { IdLike, JsonObject } from "../types.js";
import { logEvent, metrics } from "../observability.js";
import { YifangyunError } from "../client.js";
import { ScopeScanEngine } from "./engine.js";
import type { ScopeItemCursor, ScopeItemPage, ScopeScanPolicy, ScopeScanRepository, ScopeScanState } from "./types.js";

export interface CreateSnapshotInput {
  accessContextId: string;
  caseSensitive: boolean;
  includeFiles: boolean;
  includeFolders: boolean;
  matchFields: Array<"name" | "path">;
  maxItemDepth: number;
  maxItems: number;
  pageCapacity: number;
  rootFolderId: string;
  signal?: AbortSignal;
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

  async create(input: CreateSnapshotInput): Promise<{ reused: boolean; state: ScopeScanState }> {
    const resolved = this.access.resolveContext(input.accessContextId);
    const policy: ScopeScanPolicy = {
      caseSensitive: input.caseSensitive,
      includeFiles: input.includeFiles,
      includeFolders: input.includeFolders,
      matchFields: input.matchFields,
      maxItemDepth: input.maxItemDepth,
      maxItems: input.maxItems,
      pageCapacity: input.pageCapacity
    };
    const started = await this.engine.start({
      accessContextId: resolved.context.id,
      accessIdentityRef: resolved.identityRef,
      externalEnterpriseId: resolved.context.externalEnterpriseId,
      policy,
      rootFolderId: input.rootFolderId,
      signal: input.signal,
      userId: resolved.context.userId
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
    scanId: string;
    type?: "file" | "folder" | "all";
  }): Promise<ScopeItemPage & { state: ScopeScanState }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.get(input.scanId, input.accessContextId);
      if (input.cursor && input.cursor.revision !== state.revision) {
        throw new YifangyunError("Snapshot changed after this cursor was issued.", {
          code: "YFY_SNAPSHOT_CURSOR_STALE",
          phase: "snapshot_query",
          scanId: state.scanId,
          agentDetails: { current_revision: state.revision, cursor_revision: input.cursor.revision, restart_required: true },
          suggestedAction: "Repeat the same snapshot query without cursor to restart from the first stable page."
        });
      }
      const queries = input.queries ?? [];
      if (input.mode === "search" && queries.length === 0) {
        throw new YifangyunError("Snapshot search requires at least one query.", { code: "YFY_SNAPSHOT_QUERY_EMPTY", phase: "snapshot_query", scanId: state.scanId, suggestedAction: "Provide queries, or use mode=list to enumerate snapshot items." });
      }
      const result = input.mode === "search"
        ? await this.engine.search(input.scanId, queries, input.type ?? "all", input.cursor, input.limit)
        : await this.engine.listItems(input.scanId, input.type ?? "all", input.cursor, input.limit);
      const after = await this.get(input.scanId, input.accessContextId);
      if (after.revision === state.revision) {
        return { ...result, ...(result.nextCursor ? { nextCursor: { ...result.nextCursor, revision: state.revision } } : {}), state };
      }
      if (input.cursor) {
        throw new YifangyunError("Snapshot changed after this cursor was issued.", {
          code: "YFY_SNAPSHOT_CURSOR_STALE",
          phase: "snapshot_query",
          scanId: state.scanId,
          agentDetails: { current_revision: after.revision, cursor_revision: input.cursor.revision, restart_required: true },
          suggestedAction: "Repeat the same snapshot query without cursor to restart from the first stable page."
        });
      }
    }
    throw new YifangyunError("Snapshot is changing too quickly to return a consistent page.", { code: "YFY_SNAPSHOT_QUERY_BUSY", phase: "snapshot_query", retryable: true, scanId: input.scanId, suggestedAction: "Retry after the snapshot reaches complete or partial status." });
  }

  async cancel(scanId: string, accessContextId?: string): Promise<ScopeScanState> {
    await this.get(scanId, accessContextId);
    this.controllers.get(scanId)?.abort("snapshot cancelled");
    const cancelled = await this.engine.cancel(scanId);
    return cancelled;
  }

  summary(state: ScopeScanState): JsonObject {
    return this.engine.summary(state);
  }

  async manifest(scanId: string, accessContextId?: string): Promise<JsonObject> {
    await this.get(scanId, accessContextId);
    return this.engine.manifest(scanId);
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
      if (!["running", "paused_retryable"].includes(state.status)) {
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
      if (advanced.status === "paused_retryable") {
        retryCount += 1;
        if (retryCount > 3) {
          await this.engine.fail(scanId, new YifangyunError("Snapshot retry budget was exhausted.", { code: "YFY_SNAPSHOT_RETRY_EXHAUSTED", phase: "snapshot_worker" }));
          return;
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const timeout = setTimeout(resolve, Math.min(5000, 250 * 2 ** retryCount));
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      } else {
        retryCount = 0;
      }
    }
  }

  private assertAccess(state: ScopeScanState, accessContextId?: string): void {
    const requested = accessContextId ?? this.access.resolveContext().context.id;
    const resolved = this.access.resolveContext(requested);
    if (state.accessContextId !== resolved.context.id || state.accessIdentityRef !== resolved.identityRef) {
      throw new YifangyunError("Snapshot belongs to a different access context.", {
        code: "YFY_SNAPSHOT_ACCESS_DENIED",
        phase: "snapshot_access",
        scanId: state.scanId
      });
    }
  }
}
