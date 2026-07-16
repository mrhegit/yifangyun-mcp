import crypto from "node:crypto";
import type { IdLike, JsonObject, JsonValue } from "../types.js";
import { YifangyunError } from "../client.js";
import { metrics } from "../observability.js";
import { ScopeScanStore } from "./store.js";
import type { ScopePageArtifact, ScopeScanPolicy, ScopeScanProvider, ScopeScanState } from "./types.js";

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

export class ScopeScanEngine {
  constructor(private readonly store: ScopeScanStore, private readonly provider: ScopeScanProvider) {}

  async start(input: {
    accessIdentityRef: string;
    externalEnterpriseId?: IdLike;
    policy: ScopeScanPolicy;
    rootFolderId: IdLike;
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
      const observed = await this.provider.getRoot(input.rootFolderId, input.userId);
      const now = new Date().toISOString();
      const scanId = crypto.randomUUID();
      const rootName = asText(observed.folder.name) ?? rootFolderId;
      const state: ScopeScanState = {
        accessIdentityRef: input.accessIdentityRef,
        artifactToken: crypto.randomBytes(16).toString("hex"),
        completedPageKeys: [],
        createdAt: now,
        expiresAt: this.store.makeExpiry(),
        ...(input.externalEnterpriseId !== undefined ? { externalEnterpriseId: String(input.externalEnterpriseId) } : {}),
        fileCount: 0,
        folderCount: 0,
        frontier: [{ depth: 0, folderId: rootFolderId, pageId: 0, pathDisplay: rootName }],
        incompleteReasons: [],
        observationStartedAt: now,
        observationUpdatedAt: now,
        pageReceiptCount: 0,
        pageAttempts: {},
        policy: input.policy,
        policyHash,
        revision: 0,
        rootFolder: observed.folder,
        rootFolderId,
        rootObservationDigest: digest(observed.folder),
        scanId,
        status: "running",
        updatedAt: now
      };
      await this.store.create(state);
      return { reused: false, state };
    });
  }

  async advance(input: {
    expectedRevision: number;
    maxPages: number;
    maxWallMs: number;
    scanId: string;
    signal?: AbortSignal;
    userId?: IdLike;
  }): Promise<ScopeScanState> {
    return this.store.withLock(input.scanId, async () => {
      let state = await this.store.load(input.scanId);
      if (state.pageReceiptCount > 0) {
        metrics.increment("scope_scan_resume_total");
      }
      if (state.revision !== input.expectedRevision) {
        throw new YifangyunError("Scope scan revision conflict.", {
          code: "YFY_SCAN_REVISION_CONFLICT",
          details: { actual_revision: state.revision, expected_revision: input.expectedRevision },
          phase: "scan_advance",
          scanId: input.scanId,
          suggestedAction: "Call yfy_get_scope_scan and retry with the latest revision."
        });
      }
      if (["cancelled", "complete", "failed", "expired"].includes(state.status)) {
        return state;
      }
      if (state.status === "partial" && state.frontier.length === 0) {
        return state;
      }
      state.incompleteReasons = state.incompleteReasons.filter((reason) => !["CLIENT_CANCELLED_STEP", "PERMISSION_CHANGED_OR_DENIED", "PROVIDER_STEP_FAILED"].includes(reason));
      delete state.lastError;
      state.status = "running";
      const existingPages = await this.store.listPages(state.scanId);
      const seenFolderIds = new Set<string>([state.rootFolderId]);
      const seenItemDigests = new Map<string, string>();
      for (const page of existingPages) {
        for (const item of [...page.folders, ...page.files]) {
          const itemId = asText(item.id);
          if (itemId) {
            seenItemDigests.set(itemId, itemDigest(item));
            if (item.type === "folder") {
              seenFolderIds.add(itemId);
            }
          }
        }
      }
      const startedAt = Date.now();
      let processedPages = 0;
      while (state.frontier.length && processedPages < input.maxPages && Date.now() - startedAt < input.maxWallMs) {
        if (input.signal?.aborted) {
          state.status = "paused_retryable";
          addReason(state, "CLIENT_CANCELLED_STEP");
          state.revision += 1;
          state.updatedAt = new Date().toISOString();
          await this.store.save(state);
          break;
        }
        const stateBeforePage = structuredClone(state);
        const cursor = state.frontier.shift()!;
        const pageKey = `${cursor.folderId}:${cursor.pageId}`;
        if (state.completedPageKeys.includes(pageKey)) {
          addReason(state, "PAGINATION_LOOP");
          state.status = "partial";
          continue;
        }
        try {
          state.pageAttempts[pageKey] = (state.pageAttempts[pageKey] ?? 0) + 1;
          const requestStartedAt = Date.now();
          const page = await this.provider.listChildren(cursor.folderId, input.userId, cursor.pageId, state.policy.pageCapacity, input.signal);
          if (!page.paginationReliable) {
            addReason(state, "PAGINATION_METADATA_INCOMPLETE");
          }
          const folders: JsonObject[] = [];
          const files: JsonObject[] = [];
          const observedItems = [...page.folders, ...page.files];
          const remaining = Math.max(0, state.policy.maxItems - state.folderCount - state.fileCount);
          const selectedItems = observedItems.slice(0, remaining);
          if (selectedItems.length < observedItems.length) {
            addReason(state, "MAX_ITEMS_REACHED");
            state.status = "partial";
          }
          for (const item of selectedItems) {
            const itemId = asText(item.id);
            const itemType = asText(item.type);
            if (!itemId || (itemType !== "file" && itemType !== "folder")) {
              addReason(state, "INVALID_ITEM_ID_OR_TYPE");
              continue;
            }
            const itemPath = `${cursor.pathDisplay}/${asText(item.name) ?? itemId}`;
            const annotated: JsonObject = { ...item, depth: cursor.depth + 1, path_display: itemPath };
            const currentDigest = itemDigest(annotated);
            const previousDigest = seenItemDigests.get(itemId);
            if (previousDigest) {
              addReason(state, previousDigest === currentDigest ? "DUPLICATE_ITEM_ID" : "ITEM_METADATA_CONFLICT");
              continue;
            }
            seenItemDigests.set(itemId, currentDigest);
            if (itemType === "folder") {
              state.folderCount += 1;
              if (state.policy.includeFolders) {
                folders.push(annotated);
              }
              if (cursor.depth < state.policy.maxDepth) {
                if (seenFolderIds.has(itemId)) {
                  addReason(state, "DIRECTORY_CYCLE_OR_ALIAS");
                } else {
                  seenFolderIds.add(itemId);
                  state.frontier.push({ depth: cursor.depth + 1, folderId: itemId, pageId: 0, pathDisplay: itemPath });
                }
              } else {
                addReason(state, "MAX_DEPTH_REACHED");
              }
            } else {
              state.fileCount += 1;
              if (state.policy.includeFiles) {
                files.push(annotated);
              }
            }
          }
          if (page.hasMore && observedItems.length === 0) {
            addReason(state, "EMPTY_PAGE_WITH_MORE");
            state.status = "partial";
          } else if (page.hasMore) {
            const nextPageId = page.nextPageId ?? page.pageId + 1;
            if (nextPageId <= page.pageId) {
              addReason(state, "PAGINATION_LOOP");
              state.status = "partial";
            } else {
              state.frontier.unshift({ ...cursor, pageId: nextPageId });
            }
          }
          const observedAt = new Date().toISOString();
          const artifact: ScopePageArtifact = {
            files,
            folders,
            pageKey,
            receipt: {
              attempt: state.pageAttempts[pageKey],
              folderId: cursor.folderId,
              hasMore: page.hasMore,
              itemCount: observedItems.length,
              latencyMs: Date.now() - requestStartedAt,
              ...(page.nextPageId !== undefined ? { nextPageId: page.nextPageId } : {}),
              observedAt,
              pageCapacity: page.pageCapacity ?? state.policy.pageCapacity,
              pageId: page.pageId,
              ...(page.meta.requestId ? { providerRequestId: page.meta.requestId } : {}),
              responseDigest: digest({ files: page.files, folders: page.folders, hasMore: page.hasMore, nextPageId: page.nextPageId }),
              storedItemCount: files.length + folders.length
            }
          };
          state.completedPageKeys.push(pageKey);
          state.pageReceiptCount += 1;
          metrics.increment("scope_scan_pages_total");
          processedPages += 1;
          state.observationUpdatedAt = observedAt;
          state.revision += 1;
          state.updatedAt = observedAt;
          await this.store.commitPage(state.scanId, artifact, state);
          if (state.status === "partial") {
            break;
          }
        } catch (error) {
          const yfyError = error instanceof YifangyunError ? error : undefined;
          if (yfyError?.code === "YFY_SCAN_COMMIT_PENDING") {
            throw error;
          }
          const attempt = state.pageAttempts[pageKey] ?? stateBeforePage.pageAttempts[pageKey] ?? 0;
          state = stateBeforePage;
          if (attempt > 0) {
            state.pageAttempts[pageKey] = attempt;
          }
          if (input.signal?.aborted) {
            state.status = "paused_retryable";
            addReason(state, "CLIENT_CANCELLED_STEP");
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
          metrics.increment("scope_scan_incomplete_total", { reason: state.incompleteReasons.at(-1) ?? "provider_step_failed" });
          state.lastError = {
            code: yfyError?.code ?? "YFY_SCAN_PROVIDER_FAILURE",
            message: error instanceof Error ? error.message : String(error)
          };
          state.revision += 1;
          state.updatedAt = new Date().toISOString();
          await this.store.save(state);
          break;
        }
      }
      if (!state.frontier.length && state.status === "running") {
        const finalRoot = await this.provider.getRoot(state.rootFolderId, input.userId).catch(() => undefined);
        if (!finalRoot || digest(finalRoot.folder) !== state.rootObservationDigest) {
          metrics.increment("scope_scan_incomplete_total", { reason: "provider_revision_drift" });
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
        await this.store.save(state);
      }
      return state;
    });
  }

  async get(scanId: string): Promise<ScopeScanState> {
    return this.store.withLock(scanId, () => this.store.load(scanId));
  }

  async cancel(scanId: string, expectedRevision?: number): Promise<ScopeScanState> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      if (expectedRevision !== undefined && state.revision !== expectedRevision) {
        throw new YifangyunError("Scope scan revision conflict.", { code: "YFY_SCAN_REVISION_CONFLICT", scanId });
      }
      state.status = "cancelled";
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async search(scanId: string, queries: string[], offset: number, limit: number): Promise<{ items: JsonObject[]; total: number }> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      const normalizedQueries = queries
        .map((query) => ({ normalized: normalizeText(query, state.policy.caseSensitive), original: query }))
        .filter((query) => Boolean(query.normalized));
      const pages = await this.store.listPages(scanId);
      const matches: JsonObject[] = [];
      for (const page of pages) {
        for (const item of [...page.folders, ...page.files]) {
          const fields = state.policy.matchFields.map((field) => field === "name" ? asText(item.name) : asText(item.path_display)).filter((value): value is string => Boolean(value));
          const normalizedFields = fields.map((field) => normalizeText(field, state.policy.caseSensitive));
          const matchedQueries = normalizedQueries.filter((query) => normalizedFields.some((field) => field.includes(query.normalized))).map((query) => query.original);
          if (matchedQueries.length) {
            matches.push({ ...item, matched_queries: matchedQueries });
          }
        }
      }
      matches.sort((left, right) => String(left.path_display ?? "").localeCompare(String(right.path_display ?? ""), "zh-CN"));
      return { items: matches.slice(offset, offset + limit), total: matches.length };
    });
  }

  async listItems(scanId: string, type: "file" | "folder" | "all", offset: number, limit: number): Promise<{ items: JsonObject[]; total: number }> {
    return this.store.withLock(scanId, async () => {
      const pages = await this.store.listPages(scanId);
      const items = pages.flatMap((page) => [
        ...(type === "file" ? [] : page.folders),
        ...(type === "folder" ? [] : page.files)
      ]);
      items.sort((left, right) => String(left.path_display ?? "").localeCompare(String(right.path_display ?? ""), "zh-CN"));
      return { items: items.slice(offset, offset + limit), total: items.length };
    });
  }

  summary(state: ScopeScanState): JsonObject {
    const paginationComplete = state.status === "complete" && state.frontier.length === 0 && state.incompleteReasons.length === 0;
    const safeToClaimAbsence = paginationComplete && state.policy.includeFiles && state.policy.includeFolders;
    return {
      access_identity_ref: state.accessIdentityRef,
      artifact_uri: `yfy://scan/${state.scanId}/${state.artifactToken}/manifest`,
      checkpoint: { revision: state.revision, remaining_frontier_count: state.frontier.length },
      consistency_level: paginationComplete ? "best_effort_complete_observation" : "partial_observation",
      created_at: state.createdAt,
      expires_at: state.expiresAt,
      incomplete_reasons: state.incompleteReasons,
      ...(state.lastError ? { last_error: state.lastError } : {}),
      observation_window: { started_at: state.observationStartedAt, updated_at: state.observationUpdatedAt },
      page_receipt_count: state.pageReceiptCount,
      partial_result_ref: `yfy://scan/${state.scanId}/${state.artifactToken}/manifest`,
      pagination_complete: paginationComplete,
      policy: state.policy as unknown as JsonValue,
      remaining_frontier_count: state.frontier.length,
      revision: state.revision,
      root_folder: state.rootFolder,
      safe_to_claim_absence: safeToClaimAbsence,
      safe_to_claim_absence_scope: safeToClaimAbsence ? "within_observed_accessible_scope" : "none",
      scan_id: state.scanId,
      scanned_file_count: state.fileCount,
      scanned_folder_count: state.folderCount,
      status: state.status,
      ...(state.status !== "complete" ? { suggested_action: "Call yfy_advance_scope_scan with the latest revision, or inspect incomplete_reasons." } : {})
    };
  }

  async manifest(scanId: string): Promise<JsonObject> {
    return this.store.withLock(scanId, async () => {
      const state = await this.store.load(scanId);
      const pages = await this.store.listPages(scanId);
      return {
        ...this.summary(state),
        observation_digest: digest({ state: this.summary(state), receipts: pages.map((page) => page.receipt.responseDigest) }),
        receipts: pages.map((page) => page.receipt as unknown as JsonValue)
      };
    });
  }
}
