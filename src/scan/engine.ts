import crypto from "node:crypto";
import type { IdLike, JsonObject, JsonValue } from "../types.js";
import { YifangyunError } from "../client.js";
import { metrics } from "../observability.js";
import { projectInventoryPolicy } from "./projectors.js";
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
    forceRefresh?: boolean;
    maxAgeSeconds?: number;
    policy: ScopeScanPolicy;
    rootFolderId: IdLike;
    signal?: AbortSignal;
    userId?: IdLike;
    workspaceFingerprint?: string;
    workspaceId?: string;
    workspaceRef?: string;
    workspaceRootFolderId?: IdLike;
  }): Promise<{ reuseReason: "fresh_complete" | "running_join" | "new"; reused: boolean; state: ScopeScanState }> {
    const policyHash = digest(input.policy);
    const rootFolderId = String(input.rootFolderId);
    const effectiveWorkspaceFingerprint = input.workspaceFingerprint ?? digest({ accessIdentityRef: input.accessIdentityRef, rootFolderId });
    const startLockKey = `start:${digest({ policyHash, workspaceFingerprint: effectiveWorkspaceFingerprint })}`;
    return this.store.withLock(startLockKey, async () => {
      await this.store.pruneExpired();
      const reusable = input.forceRefresh ? undefined : await this.store.findReusable(effectiveWorkspaceFingerprint, policyHash, Date.now() - (input.maxAgeSeconds ?? 300) * 1000);
      if (reusable) {
        return { reuseReason: reusable.status === "complete" ? "fresh_complete" : "running_join", reused: true, state: reusable };
      }
      const observed = await this.provider.getRoot(input.rootFolderId, input.userId, input.signal, input.externalEnterpriseId);
      const now = new Date().toISOString();
      const scanId = crypto.randomUUID();
      const rootName = asText(observed.folder.name) ?? rootFolderId;
      const state: ScopeScanState = {
        accessContextId: input.accessContextId,
        accessIdentityRef: input.accessIdentityRef,
        artifactToken: crypto.randomBytes(16).toString("hex"),
        commitWatermark: 0,
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
        retryCount: 0,
        rootFolder: observed.folder,
        rootFolderId,
        rootObservationDigest: digest(observed.folder),
        scanId,
        status: "running",
        updatedAt: now,
        workspaceFingerprint: effectiveWorkspaceFingerprint,
        workspaceId: input.workspaceId ?? "internal",
        workspaceRef: input.workspaceRef ?? "workspace:internal",
        workspaceRootFolderId: String(input.workspaceRootFolderId ?? input.rootFolderId)
      };
      await this.store.create(state, [{ attempt: 0, depth: 0, folderId: rootFolderId, pageId: 0, pathDisplay: rootName }]);
      return { reuseReason: "new", reused: false, state };
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
          code: "YFY_INVENTORY_REVISION_CONFLICT",
          details: { actual_revision: state.revision, expected_revision: input.expectedRevision },
          phase: "inventory_advance",
          scanId: input.scanId,
            suggestedAction: "Call yfy_inventory_get and retry with the latest inventory state."
        });
      }
      if (["cancelled", "complete", "failed"].includes(state.status)) {
        return state;
      }
      if (state.status === "partial" && state.frontierCount === 0) {
        return state;
      }
      state.incompleteReasons = state.incompleteReasons.filter((reason) => !["CLIENT_CANCELLED_STEP", "PERMISSION_CHANGED_OR_DENIED", "PROVIDER_STEP_FAILED"].includes(reason));
      delete state.lastError;
      state.status = "running";
      delete state.nextRetryAt;
      const startedAt = Date.now();
      const deadline = AbortSignal.timeout(Math.max(1, input.maxWallMs));
      const requestSignal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      const concurrency = Math.max(1, Math.min(input.maxConcurrentPages ?? 1, input.maxPages));
      let processedPages = 0;
      while (state.frontierCount > 0 && processedPages < input.maxPages && Date.now() - startedAt < input.maxWallMs) {
        if (input.signal?.aborted) {
          state.status = "retry_wait";
          addReason(state, "CLIENT_CANCELLED_STEP");
          state.revision += 1;
          state.updatedAt = new Date().toISOString();
          await this.store.save(state);
          break;
        }
        const batchSize = Math.min(concurrency, input.maxPages - processedPages, state.frontierCount);
        const cursors = (await this.store.peekFrontier(state.scanId, batchSize)).map((cursor) => ({ ...cursor, attempt: cursor.attempt + 1 }));
        if (cursors.length === 0) {
          throw new YifangyunError("Inventory frontier count does not match persisted cursors.", { code: "YFY_INVENTORY_FRONTIER_CONFLICT", phase: "inventory_fetch", scanId: state.scanId });
        }
        const fetched = await Promise.allSettled(cursors.map(async (cursor) => {
          const requestStartedAt = Date.now();
          const page = await this.provider.listChildren(cursor.folderId, input.userId, cursor.pageId, state.policy.pageCapacity, requestSignal, state.externalEnterpriseId);
          return { cursor, latencyMs: Date.now() - requestStartedAt, page };
        }));

        let stopBatch = false;
        for (let index = 0; index < fetched.length && !stopBatch; index += 1) {
          const cursor = cursors[index]!;
          const pageKey = cursorKey(cursor);
          const current = (await this.store.peekFrontier(state.scanId, 1))[0];
          if (!sameCursor(current, cursor)) {
            throw new YifangyunError("Inventory frontier order changed during a fetch batch.", { code: "YFY_INVENTORY_FRONTIER_CONFLICT", phase: "inventory_commit", scanId: state.scanId });
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
              state.status = "retry_wait";
              addReason(state, "CLIENT_CANCELLED_STEP");
            } else if (deadline.aborted) {
              state.status = "retry_wait";
              addReason(state, "PROVIDER_STEP_FAILED");
            } else if (yfyError?.code === "YFY_PERMISSION_DENIED") {
              state.status = "partial";
              addReason(state, "PERMISSION_CHANGED_OR_DENIED");
            } else if (yfyError?.retryable ?? true) {
              state.status = "retry_wait";
              addReason(state, "PROVIDER_STEP_FAILED");
            } else {
              state.status = "failed";
              addReason(state, "PROVIDER_TERMINAL_FAILURE");
            }
            metrics.increment("snapshot_incomplete_total", { reason: state.incompleteReasons.at(-1) ?? "provider_step_failed" });
            state.lastError = { code: yfyError?.code ?? "YFY_INVENTORY_PROVIDER_FAILURE", message: error instanceof Error ? error.message : String(error), retryable: yfyError?.retryable ?? true, ...(yfyError?.phase ? { phase: yfyError.phase } : {}), ...(yfyError?.statusCode !== undefined || yfyError?.details?.api_code || yfyError?.details?.request_id ? { provider: { ...(yfyError?.statusCode !== undefined ? { status_code: yfyError.statusCode } : {}), ...(typeof yfyError?.details?.api_code === "string" ? { code: yfyError.details.api_code } : {}), ...(typeof yfyError?.details?.request_id === "string" ? { request_id: yfyError.details.request_id } : {}) } } : {}) };
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
            const itemDepth = cursor.depth + 1;
            if (itemDepth > nextState.policy.maxItemDepth) {
              addReason(nextState, "MAX_DEPTH_REACHED");
              continue;
            }
            const annotated: JsonObject = { ...item, depth: itemDepth, path_display: itemPath };
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
              if (itemDepth <= nextState.policy.maxItemDepth) {
                childCursors.push({ attempt: 0, depth: itemDepth, folderId: itemId, pageId: 0, pathDisplay: itemPath });
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
          nextState.commitWatermark = nextState.pageReceiptCount;
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
          finalRoot = await this.provider.getRoot(state.rootFolderId, input.userId, finalSignal, state.externalEnterpriseId);
        } catch (error) {
          const yfyError = error instanceof YifangyunError ? error : undefined;
          state.status = input.signal?.aborted ? "retry_wait" : yfyError?.code === "YFY_PERMISSION_DENIED" ? "partial" : yfyError?.retryable !== false || finalDeadline.aborted ? "retry_wait" : "failed";
          addReason(state, input.signal?.aborted ? "CLIENT_CANCELLED_STEP" : yfyError?.code === "YFY_PERMISSION_DENIED" ? "PERMISSION_CHANGED_OR_DENIED" : "PROVIDER_STEP_FAILED");
          state.lastError = { code: yfyError?.code ?? "YFY_INVENTORY_PROVIDER_FAILURE", message: error instanceof Error ? error.message : String(error), retryable: yfyError?.retryable ?? true, ...(yfyError?.phase ? { phase: yfyError.phase } : {}) };
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
        throw new YifangyunError("Inventory revision conflict.", { code: "YFY_INVENTORY_REVISION_CONFLICT", scanId });
      }
    if (["complete", "partial", "cancelled", "failed"].includes(state.status)) return state;
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
      if (["cancelled", "complete", "failed", "partial"].includes(state.status)) return state;
      const yfyError = error instanceof YifangyunError ? error : undefined;
      state.status = "failed";
      state.expiresAt = this.store.makeExpiry();
      state.lastError = { code: yfyError?.code ?? "YFY_INVENTORY_WORKER_FAILED", message: error instanceof Error ? error.message : String(error), retryable: yfyError?.retryable ?? false, ...(yfyError?.phase ? { phase: yfyError.phase } : {}) };
      addReason(state, "SNAPSHOT_WORKER_FAILED");
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async search(scanId: string, queries: string[], matchFields: Array<"name" | "path">, caseSensitive: boolean, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number, watermark: number): Promise<ScopeItemPage> {
    const state = await this.store.load(scanId);
    const normalizedQueries = queries
      .map((query) => ({ normalized: normalizeText(query, caseSensitive), original: query }))
      .filter((query) => Boolean(query.normalized));
    const itemCount = state.fileCount + state.folderCount;
    if (itemCount > 100_000 && normalizedQueries.some((query) => Array.from(query.normalized).length < 3)) {
      throw new YifangyunError("Inventory queries shorter than 3 characters are disabled for large inventories.", {
        code: "YFY_INVENTORY_QUERY_TOO_SHORT",
        details: { item_count: itemCount, minimum_characters: 3 },
        phase: "inventory_query",
        suggestedAction: "Use a more specific query so the FTS trigram index can be used."
      });
    }
    if (itemCount > 100_000 && normalizedQueries.length > 10) {
      throw new YifangyunError("Too many query terms were requested for a large inventory.", {
        code: "YFY_INVENTORY_QUERY_TOO_BROAD",
        details: { item_count: itemCount, max_queries: 10 },
        phase: "inventory_query",
        suggestedAction: "Split the query set into smaller batches."
      });
    }
    if (itemCount > 100_000 && caseSensitive) {
      throw new YifangyunError("Case-sensitive search is disabled for large inventories.", {
        code: "YFY_INVENTORY_CASE_SENSITIVE_QUERY_TOO_LARGE",
        details: { item_count: itemCount },
        phase: "inventory_query",
        suggestedAction: "Create a case-insensitive inventory for indexed large-space search."
      });
    }
    return this.store.searchItems(scanId, normalizedQueries, matchFields, type, cursor, limit, caseSensitive, watermark);
  }

  async listItems(scanId: string, type: "file" | "folder" | "all", cursor: ScopeItemCursor | undefined, limit: number, watermark: number): Promise<ScopeItemPage> {
    return this.store.listItems(scanId, type, cursor, limit, watermark);
  }

  summary(state: ScopeScanState): JsonObject {
    const paginationComplete = state.status === "complete" && state.frontierCount === 0 && state.incompleteReasons.length === 0;
    const safeToClaimAbsence = paginationComplete && state.policy.includeFiles && state.policy.includeFolders;
    const subtree = state.rootFolderId !== state.workspaceRootFolderId;
    return {
      inventory_id: state.scanId,
      status: state.status,
      workspace: { ref: state.workspaceRef, root_folder_id: state.workspaceRootFolderId, access_context: state.accessContextId, fingerprint: state.workspaceFingerprint },
      scan_root: { folder_id: state.rootFolderId, scope: subtree ? "observed_subtree" : "configured_workspace_root" },
      scanned_file_count: state.fileCount,
      scanned_folder_count: state.folderCount,
      page_receipt_count: state.pageReceiptCount,
      completeness: {
        pagination_complete: paginationComplete,
        safe_to_claim_absence: safeToClaimAbsence,
        scope: subtree ? "observed_subtree" : safeToClaimAbsence ? "entire_observed_accessible_scope" : "observed_subset_only",
        consistency_level: paginationComplete ? "best_effort_complete_observation" : "partial_observation",
        incomplete_reasons: state.incompleteReasons
      },
      terminal: ["complete", "partial", "cancelled", "failed"].includes(state.status),
      limits: { max_item_depth: state.policy.maxItemDepth, max_items: state.policy.maxItems },
      observation_window: { started_at: state.observationStartedAt, updated_at: state.observationUpdatedAt },
      created_at: state.createdAt,
      updated_at: state.updatedAt,
      expires_at: state.expiresAt,
      checkpoint: { commit_watermark: state.commitWatermark, control_revision: state.revision, remaining_frontier_count: state.frontierCount },
      diagnostics: { retry_count: state.retryCount, ...(state.nextRetryAt ? { next_retry_at: state.nextRetryAt } : {}), ...(state.lastError ? { last_error: state.lastError } : {}), incomplete_reasons: state.incompleteReasons },
      manifest_uri: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/manifest`,
      receipts_uri_template: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/receipts/{page}`
    };
  }

  async manifest(scanId: string): Promise<JsonObject> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.store.load(scanId);
      const after = await this.store.load(scanId);
      if (after.revision === state.revision) {
        const summary = this.summary(state);
        return {
          ...summary,
          observation_digest: digest({ receipt_digest: state.receiptDigest, snapshot: summary }),
          policy: projectInventoryPolicy(state.policy),
          receipt_summary: { total_count: state.pageReceiptCount, inline_count: 0, receipts_uri_template: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/receipts/{page}` },
          root_folder: state.rootFolder
        };
      }
    }
    throw new YifangyunError("Inventory is changing too quickly to build a consistent manifest.", { code: "YFY_INVENTORY_MANIFEST_BUSY", phase: "inventory_manifest", retryable: true, scanId });
  }

  async scheduleRetry(scanId: string, retryCount: number, nextRetryAt: string): Promise<ScopeScanState> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      if (state.status !== "retry_wait") return state;
      state.retryCount = retryCount;
      state.nextRetryAt = nextRetryAt;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      return state;
    });
  }
}
