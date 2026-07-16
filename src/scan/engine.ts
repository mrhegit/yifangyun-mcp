import crypto from "node:crypto";
import type { IdLike, JsonObject, JsonValue } from "../types.js";
import { YifangyunError } from "../client.js";
import { metrics } from "../observability.js";
import type { ScopeItemCursor, ScopeItemPage, ScopePageArtifact, ScopeScanFrontier, ScopeScanPolicy, ScopeScanProvider, ScopeScanRepository, ScopeScanState, ScopeSeenItem } from "./types.js";

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function asText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function normalizeText(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFKC")
    .replace(/(^|\/)\s*\d+\s*[、.．]\s*/g, "$1")
    .replace(/[《》〈〉“”‘’（）()【】\[\]、，,。.;；:：_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("zh-CN");
}

function addReason(state: ScopeScanState, reason: string): void {
  if (!state.incompleteReasons.includes(reason)) {
    state.incompleteReasons.push(reason);
  }
}

function itemDigest(item: JsonObject): string {
  return digest({ depth: item.depth, id: item.id, name: item.name, parent_folder_id: item.parent_folder_id, path_display: item.path_display, size: item.size, modified_at_unix: item.modified_at_unix });
}

function cursorKey(cursor: ScopeScanFrontier): string {
  return `${cursor.folderId}:${cursor.pageId}`;
}

function sameCursor(left: ScopeScanFrontier | undefined, right: ScopeScanFrontier): boolean {
  return Boolean(left && left.folderId === right.folderId && left.pageId === right.pageId && left.depth === right.depth);
}

export class ScopeScanEngine {
  constructor(private readonly store: ScopeScanRepository, private readonly provider: ScopeScanProvider) {}

  async start(input: {
    accessContextId: string;
    accessIdentityRef: string;
    externalEnterpriseId?: IdLike;
    policy: ScopeScanPolicy;
    rootFolderId: IdLike;
    signal?: AbortSignal;
    userId?: IdLike;
  }): Promise<{ reused: boolean; state: ScopeScanState }> {
    const policyHash = digest(input.policy);
    const rootFolderId = String(input.rootFolderId);
    const startLockKey = `start:${digest({ accessIdentityRef: input.accessIdentityRef, policyHash, rootFolderId })}`;
    return this.store.withLock(startLockKey, async () => {
      await this.store.pruneExpired();
      const reusable = await this.store.findReusable(input.accessIdentityRef, rootFolderId, policyHash);
      if (reusable) {
        return { reused: true, state: reusable };
      }
      const observed = await this.provider.getRoot(input.rootFolderId, input.userId, input.signal);
      const now = new Date().toISOString();
      const scanId = crypto.randomUUID();
      const rootName = asText(observed.folder.name) ?? rootFolderId;
      const state: ScopeScanState = {
        accessContextId: input.accessContextId,
        accessIdentityRef: input.accessIdentityRef,
        artifactToken: crypto.randomBytes(16).toString("hex"),
        createdAt: now,
        expiresAt: this.store.makeExpiry(),
        ...(input.externalEnterpriseId !== undefined ? { externalEnterpriseId: String(input.externalEnterpriseId) } : {}),
        fileCount: 0,
        folderCount: 0,
        frontierCount: 1,
        incompleteReasons: [],
        observationStartedAt: now,
        observationUpdatedAt: now,
        pageReceiptCount: 0,
        policy: input.policy,
        policyHash,
        receiptDigest: digest([]),
        revision: 0,
        rootFolder: observed.folder,
        rootFolderId,
        rootObservationDigest: digest(observed.folder),
        scanId,
        status: "running",
        updatedAt: now
      };
      await this.store.create(state, [{ attempt: 0, depth: 0, folderId: rootFolderId, pageId: 0, pathDisplay: rootName }]);
      return { reused: false, state };
    });
  }

  async advance(input: {
    expectedRevision: number;
    maxConcurrentPages?: number;
    maxPages: number;
    maxWallMs: number;
    scanId: string;
    signal?: AbortSignal;
    userId?: IdLike;
  }): Promise<ScopeScanState> {
    return this.store.withLock(input.scanId, async () => {
      let state = await this.store.load(input.scanId);
      if (state.pageReceiptCount > 0) {
        metrics.increment("snapshot_resume_total");
      }
      if (state.revision !== input.expectedRevision) {
        throw new YifangyunError("Scope scan revision conflict.", {
          code: "YFY_SNAPSHOT_REVISION_CONFLICT",
          details: { actual_revision: state.revision, expected_revision: input.expectedRevision },
          phase: "snapshot_advance",
          scanId: input.scanId,
            suggestedAction: "Call yfy_snapshot_get and retry the operation with the latest snapshot state."
        });
      }
      if (["cancelled", "complete", "failed", "expired"].includes(state.status)) {
        return state;
      }
      if (state.status === "partial" && state.frontierCount === 0) {
        return state;
      }
      state.incompleteReasons = state.incompleteReasons.filter((reason) => !["CLIENT_CANCELLED_STEP", "PERMISSION_CHANGED_OR_DENIED", "PROVIDER_STEP_FAILED"].includes(reason));
      delete state.lastError;
      state.status = "running";
      const startedAt = Date.now();
      const deadline = AbortSignal.timeout(Math.max(1, input.maxWallMs));
      const requestSignal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      const concurrency = Math.max(1, Math.min(input.maxConcurrentPages ?? 1, input.maxPages));
      let processedPages = 0;
      while (state.frontierCount > 0 && processedPages < input.maxPages && Date.now() - startedAt < input.maxWallMs) {
        if (input.signal?.aborted) {
          state.status = "paused_retryable";
          addReason(state, "CLIENT_CANCELLED_STEP");
          state.revision += 1;
          state.updatedAt = new Date().toISOString();
          await this.store.save(state);
          break;
        }
        const batchSize = Math.min(concurrency, input.maxPages - processedPages, state.frontierCount);
        const cursors = (await this.store.peekFrontier(state.scanId, batchSize)).map((cursor) => ({ ...cursor, attempt: cursor.attempt + 1 }));
        if (cursors.length === 0) {
          throw new YifangyunError("Snapshot frontier count does not match persisted cursors.", { code: "YFY_SNAPSHOT_FRONTIER_CONFLICT", phase: "snapshot_fetch", scanId: state.scanId });
        }
        const fetched = await Promise.allSettled(cursors.map(async (cursor) => {
          const requestStartedAt = Date.now();
          const page = await this.provider.listChildren(cursor.folderId, input.userId, cursor.pageId, state.policy.pageCapacity, requestSignal);
          return { cursor, latencyMs: Date.now() - requestStartedAt, page };
        }));

        let stopBatch = false;
        for (let index = 0; index < fetched.length && !stopBatch; index += 1) {
          const cursor = cursors[index]!;
          const pageKey = cursorKey(cursor);
          const current = (await this.store.peekFrontier(state.scanId, 1))[0];
          if (!sameCursor(current, cursor)) {
            throw new YifangyunError("Snapshot frontier order changed during a fetch batch.", { code: "YFY_SNAPSHOT_FRONTIER_CONFLICT", phase: "snapshot_commit", scanId: state.scanId });
          }
          if (await this.store.hasPage(state.scanId, pageKey)) {
            addReason(state, "PAGINATION_LOOP");
            state.status = "partial";
            state.revision += 1;
            state.updatedAt = new Date().toISOString();
            await this.store.removeFrontier(state.scanId, cursor, state);
            break;
          }
          const result = fetched[index]!;
          if (result.status === "rejected") {
            await this.store.updateFrontier(state.scanId, cursor);
            const error = result.reason;
            const yfyError = error instanceof YifangyunError ? error : undefined;
            if (input.signal?.aborted) {
              state.status = "paused_retryable";
              addReason(state, "CLIENT_CANCELLED_STEP");
            } else if (deadline.aborted) {
              state.status = "paused_retryable";
              addReason(state, "PROVIDER_STEP_FAILED");
            } else if (yfyError?.code === "YFY_PERMISSION_DENIED") {
              state.status = "partial";
              addReason(state, "PERMISSION_CHANGED_OR_DENIED");
            } else if (yfyError?.retryable ?? true) {
              state.status = "paused_retryable";
              addReason(state, "PROVIDER_STEP_FAILED");
            } else {
              state.status = "failed";
              addReason(state, "PROVIDER_TERMINAL_FAILURE");
            }
            metrics.increment("snapshot_incomplete_total", { reason: state.incompleteReasons.at(-1) ?? "provider_step_failed" });
            state.lastError = { code: yfyError?.code ?? "YFY_SNAPSHOT_PROVIDER_FAILURE", message: error instanceof Error ? error.message : String(error) };
            state.revision += 1;
            state.updatedAt = new Date().toISOString();
            await this.store.save(state);
            stopBatch = true;
            continue;
          }

          const { latencyMs, page } = result.value;
          const nextState = state;
          const observedItems = [...page.folders, ...page.files];
          const itemKeys = observedItems.flatMap((item) => {
            const id = asText(item.id);
            const type = asText(item.type);
            return id && (type === "file" || type === "folder") ? [`${type}:${id}`] : [];
          });
          const persistedSeen = await this.store.findSeenItems(state.scanId, itemKeys);
          const pageSeen = new Map<string, ScopeSeenItem>();
          if (!page.paginationReliable) {
            addReason(nextState, "PAGINATION_METADATA_INCOMPLETE");
          }
          const validPageCount = page.pageCount === undefined || (Number.isSafeInteger(page.pageCount) && page.pageCount >= 0 && page.pageCount <= 1_000_000);
          const validNextPageId = page.nextPageId === undefined || (Number.isSafeInteger(page.nextPageId) && page.nextPageId >= 0 && page.nextPageId <= 1_000_000);
          const continuousNextPage = !page.hasMore || page.nextPageId === undefined || page.nextPageId === page.pageId + 1;
          const effectivePageCapacity = page.pageCapacity ?? nextState.policy.pageCapacity;
          const observedBeforePage = await this.store.observedItemCount(state.scanId, cursor.folderId);
          const observedThroughPage = observedBeforePage + observedItems.length;
          const pageBoundsConsistent = page.pageCount === undefined
            || (page.pageCount === 0 ? page.pageId === 0 && observedItems.length === 0 : page.pageId < page.pageCount);
          const totalBoundsConsistent = page.totalCount === undefined
            || (page.hasMore ? observedThroughPage < page.totalCount : observedThroughPage === page.totalCount);
          if (!validPageCount || !validNextPageId || !continuousNextPage || !pageBoundsConsistent || !totalBoundsConsistent || page.pageId !== cursor.pageId) {
            addReason(nextState, "PAGINATION_METADATA_INCONSISTENT");
            nextState.status = "partial";
          }
          const folders: JsonObject[] = [];
          const files: JsonObject[] = [];
          const seenItems: ScopeSeenItem[] = [];
          const childCursors: ScopeScanFrontier[] = [];
          const pageCursors: ScopeScanFrontier[] = [];
          for (const item of observedItems) {
            const itemId = asText(item.id);
            const itemType = asText(item.type);
            if (!itemId || (itemType !== "file" && itemType !== "folder")) {
              addReason(nextState, "INVALID_ITEM_ID_OR_TYPE");
              continue;
            }
            const itemPath = `${cursor.pathDisplay}/${asText(item.name) ?? itemId}`;
            const annotated: JsonObject = { ...item, depth: cursor.depth + 1, path_display: itemPath };
            const currentDigest = itemDigest(annotated);
            const itemKey = `${itemType}:${itemId}`;
            const previous = persistedSeen.get(itemKey) ?? pageSeen.get(itemKey);
            const isRootFolderAlias = itemType === "folder" && itemId === nextState.rootFolderId;
            if (isRootFolderAlias || previous) {
              addReason(nextState, previous?.digest === currentDigest ? "DUPLICATE_ITEM_ID" : isRootFolderAlias ? "DIRECTORY_CYCLE_OR_ALIAS" : "ITEM_METADATA_CONFLICT");
              continue;
            }
            if (nextState.folderCount + nextState.fileCount >= nextState.policy.maxItems) {
              addReason(nextState, "MAX_ITEMS_REACHED");
              nextState.status = "partial";
              break;
            }
            const seen: ScopeSeenItem = { digest: currentDigest, id: itemKey, type: itemType };
            pageSeen.set(itemKey, seen);
            seenItems.push(seen);
            if (itemType === "folder") {
              nextState.folderCount += 1;
              if (nextState.policy.includeFolders) {
                folders.push(annotated);
              }
              if (cursor.depth < nextState.policy.maxDepth) {
                childCursors.push({ attempt: 0, depth: cursor.depth + 1, folderId: itemId, pageId: 0, pathDisplay: itemPath });
              } else {
                addReason(nextState, "MAX_DEPTH_REACHED");
              }
            } else {
              nextState.fileCount += 1;
              if (nextState.policy.includeFiles) {
                files.push(annotated);
              }
            }
          }
          if (nextState.status === "partial") {
            // A terminal page condition such as max_items or pagination inconsistency stops scheduling new work.
          } else if (page.hasMore && observedItems.length === 0) {
            addReason(nextState, "EMPTY_PAGE_WITH_MORE");
            nextState.status = "partial";
          } else if (page.hasMore) {
            const queued = new Set(cursors.slice(index + 1).map(cursorKey));
            let nextPageIds: number[];
            if (page.pageCount !== undefined && validPageCount) {
              const upperPageId = Math.min(page.pageCount - 1, page.pageId + concurrency);
              nextPageIds = upperPageId > page.pageId
                ? Array.from({ length: upperPageId - page.pageId }, (_, pageOffset) => page.pageId + pageOffset + 1)
                : [];
              if (nextPageIds.length === 0) {
                addReason(nextState, "PAGINATION_METADATA_INCONSISTENT");
                nextState.status = "partial";
              }
            } else {
              nextPageIds = [page.nextPageId ?? page.pageId + 1];
            }
            for (const nextPageId of nextPageIds) {
              const nextCursor = { ...cursor, attempt: 0, pageId: nextPageId };
              if (nextPageId <= page.pageId || queued.has(cursorKey(nextCursor))) {
                if (nextPageId <= page.pageId) {
                  addReason(nextState, "PAGINATION_LOOP");
                  nextState.status = "partial";
                }
                continue;
              }
              queued.add(cursorKey(nextCursor));
              pageCursors.push(nextCursor);
            }
          }
          const appendCursors = nextState.status === "partial" ? [] : [...pageCursors, ...childCursors];
          const observedAt = new Date().toISOString();
          const artifact: ScopePageArtifact = {
            files,
            folders,
            pageKey,
            receipt: {
              attempt: cursor.attempt,
              folderId: cursor.folderId,
              hasMore: page.hasMore,
              itemCount: observedItems.length,
              latencyMs,
              ...(page.nextPageId !== undefined ? { nextPageId: page.nextPageId } : {}),
              observedAt,
              pageCapacity: effectivePageCapacity,
              ...(page.pageCount !== undefined ? { pageCount: page.pageCount } : {}),
              pageId: page.pageId,
              paginationReliable: page.paginationReliable,
              ...(page.meta.requestId ? { providerRequestId: page.meta.requestId } : {}),
              responseDigest: digest({ files: page.files, folders: page.folders, hasMore: page.hasMore, nextPageId: page.nextPageId, pageCapacity: effectivePageCapacity, pageCount: page.pageCount, pageId: page.pageId, paginationReliable: page.paginationReliable, totalCount: page.totalCount }),
              storedItemCount: files.length + folders.length,
              ...(page.totalCount !== undefined ? { totalCount: page.totalCount } : {})
            }
          };
          nextState.receiptDigest = digest({ previous: nextState.receiptDigest, response: artifact.receipt.responseDigest });
          nextState.pageReceiptCount += 1;
          metrics.increment("snapshot_pages_total");
          processedPages += 1;
          nextState.observationUpdatedAt = observedAt;
          nextState.revision += 1;
          nextState.updatedAt = observedAt;
          await this.store.commitPage(nextState.scanId, artifact, seenItems, nextState, cursor, appendCursors);
          state = nextState;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (state.status === "partial") {
            stopBatch = true;
          }
        }
      }
      if (state.frontierCount === 0 && state.status === "running") {
        const remainingMs = input.maxWallMs - (Date.now() - startedAt);
        if (remainingMs <= 0) return state;
        const finalDeadline = AbortSignal.timeout(remainingMs);
        const finalSignal = input.signal ? AbortSignal.any([input.signal, finalDeadline]) : finalDeadline;
        let finalRoot: Awaited<ReturnType<ScopeScanProvider["getRoot"]>>;
        try {
          finalRoot = await this.provider.getRoot(state.rootFolderId, input.userId, finalSignal);
        } catch (error) {
          const yfyError = error instanceof YifangyunError ? error : undefined;
          state.status = input.signal?.aborted ? "paused_retryable" : yfyError?.code === "YFY_PERMISSION_DENIED" ? "partial" : yfyError?.retryable !== false || finalDeadline.aborted ? "paused_retryable" : "failed";
          addReason(state, input.signal?.aborted ? "CLIENT_CANCELLED_STEP" : yfyError?.code === "YFY_PERMISSION_DENIED" ? "PERMISSION_CHANGED_OR_DENIED" : "PROVIDER_STEP_FAILED");
          state.lastError = { code: yfyError?.code ?? "YFY_SNAPSHOT_PROVIDER_FAILURE", message: error instanceof Error ? error.message : String(error) };
          state.revision += 1;
          state.updatedAt = new Date().toISOString();
          await this.store.save(state);
          return state;
        }
        if (digest(finalRoot.folder) !== state.rootObservationDigest) {
          metrics.increment("snapshot_incomplete_total", { reason: "provider_revision_drift" });
          addReason(state, "PROVIDER_REVISION_DRIFT");
          state.status = "partial";
        } else if (state.incompleteReasons.length > 0) {
          state.status = "partial";
        } else {
          state.status = "complete";
        }
        state.revision += 1;
        state.updatedAt = new Date().toISOString();
        state.observationUpdatedAt = state.updatedAt;
        state.expiresAt = this.store.makeExpiry();
        await this.store.save(state);
      }
      return state;
    });
  }

  async get(scanId: string): Promise<ScopeScanState> {
    return this.store.load(scanId);
  }

  async cancel(scanId: string, expectedRevision?: number): Promise<ScopeScanState> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        throw new YifangyunError("Snapshot revision conflict.", { code: "YFY_SNAPSHOT_REVISION_CONFLICT", scanId });
      }
      state.status = "cancelled";
      state.expiresAt = this.store.makeExpiry();
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async fail(scanId: string, error: unknown): Promise<ScopeScanState> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      if (["cancelled", "complete", "failed", "partial", "expired"].includes(state.status)) return state;
      const yfyError = error instanceof YifangyunError ? error : undefined;
      state.status = "failed";
      state.expiresAt = this.store.makeExpiry();
      state.lastError = { code: yfyError?.code ?? "YFY_SNAPSHOT_WORKER_FAILED", message: error instanceof Error ? error.message : String(error) };
      addReason(state, "SNAPSHOT_WORKER_FAILED");
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async search(scanId: string, queries: string[], type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number): Promise<ScopeItemPage> {
    const state = await this.store.load(scanId);
    const normalizedQueries = queries
      .map((query) => ({ normalized: normalizeText(query, state.policy.caseSensitive), original: query }))
      .filter((query) => Boolean(query.normalized));
    const itemCount = state.fileCount + state.folderCount;
    if (itemCount > 100_000 && normalizedQueries.some((query) => Array.from(query.normalized).length < 3)) {
      throw new YifangyunError("Snapshot queries shorter than 3 characters are disabled for large snapshots.", {
        code: "YFY_SNAPSHOT_QUERY_TOO_SHORT",
        details: { item_count: itemCount, minimum_characters: 3 },
        phase: "snapshot_query",
        suggestedAction: "Use a more specific query so the FTS trigram index can be used."
      });
    }
    if (itemCount > 100_000 && normalizedQueries.length > 10) {
      throw new YifangyunError("Too many query terms were requested for a large snapshot.", {
        code: "YFY_SNAPSHOT_QUERY_TOO_BROAD",
        details: { item_count: itemCount, max_queries: 10 },
        phase: "snapshot_query",
        suggestedAction: "Split the query set into smaller batches."
      });
    }
    if (itemCount > 100_000 && state.policy.caseSensitive) {
      throw new YifangyunError("Case-sensitive search is disabled for large snapshots.", {
        code: "YFY_SNAPSHOT_CASE_SENSITIVE_QUERY_TOO_LARGE",
        details: { item_count: itemCount },
        phase: "snapshot_query",
        suggestedAction: "Create a case-insensitive snapshot for indexed large-space search."
      });
    }
    return this.store.searchItems(scanId, normalizedQueries, state.policy.matchFields, type, cursor, limit, state.policy.caseSensitive);
  }

  async listItems(scanId: string, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number): Promise<ScopeItemPage> {
    return this.store.listItems(scanId, type, cursor, limit);
  }

  summary(state: ScopeScanState): JsonObject {
    const paginationComplete = state.status === "complete" && state.frontierCount === 0 && state.incompleteReasons.length === 0;
    const safeToClaimAbsence = paginationComplete && state.policy.includeFiles && state.policy.includeFolders;
    return {
      snapshot_id: state.scanId,
      status: state.status,
      access_context: state.accessContextId,
      root_folder_id: state.rootFolderId,
      scanned_file_count: state.fileCount,
      scanned_folder_count: state.folderCount,
      page_receipt_count: state.pageReceiptCount,
      completeness: {
        pagination_complete: paginationComplete,
        safe_to_claim_absence: safeToClaimAbsence,
        scope: safeToClaimAbsence ? "within_observed_accessible_scope" : "none",
        consistency_level: paginationComplete ? "best_effort_complete_observation" : "partial_observation",
        incomplete_reasons: state.incompleteReasons
      },
      observation_window: { started_at: state.observationStartedAt, updated_at: state.observationUpdatedAt },
      created_at: state.createdAt,
      updated_at: state.updatedAt,
      expires_at: state.expiresAt,
      artifact_uri: `yfy://snapshot/${state.scanId}/${state.artifactToken}/${state.accessContextId}/manifest`,
      ...(state.status === "running" || state.status === "paused_retryable" ? { suggested_action: "Call yfy_snapshot_get to monitor progress, or yfy_snapshot_cancel to stop the task." } : {})
    };
  }

  async manifest(scanId: string): Promise<JsonObject> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.store.load(scanId);
      const receiptSummary = await this.store.listReceiptSummary(scanId, 1000);
      const after = await this.store.load(scanId);
      if (after.revision === state.revision) {
        const summary = this.summary(state);
        return {
          ...summary,
          checkpoint: { revision: state.revision, remaining_frontier_count: state.frontierCount },
          ...(state.lastError ? { last_error: state.lastError } : {}),
          observation_digest: digest({ receipt_digest: state.receiptDigest, snapshot: summary }),
          policy: state.policy as unknown as JsonValue,
          receipt_count: receiptSummary.total,
          receipts: receiptSummary.receipts.map((receipt) => receipt as unknown as JsonValue),
          receipts_truncated: receiptSummary.total > receiptSummary.receipts.length,
          root_folder: state.rootFolder
        };
      }
    }
    throw new YifangyunError("Snapshot is changing too quickly to build a consistent manifest.", { code: "YFY_SNAPSHOT_MANIFEST_BUSY", phase: "snapshot_manifest", retryable: true, scanId });
  }
}
