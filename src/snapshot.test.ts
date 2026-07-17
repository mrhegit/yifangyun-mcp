import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AccessRegistry } from "./runtime/access.js";
import { ScopeScanEngine } from "./scan/engine.js";
import { SnapshotService } from "./scan/service.js";
import { SqliteScopeScanStore } from "./scan/store.js";
import type { ScopeScanPage, ScopeScanPolicy, ScopeScanProvider } from "./scan/types.js";
import type { ApiResponseMeta, AppConfig } from "./types.js";

function meta(endpoint: string): ApiResponseMeta {
  return { endpoint, fetchedAtIso: new Date().toISOString(), fetchedAtUnix: Math.floor(Date.now() / 1000), sourceApiVersion: "v2", statusCode: 200 };
}

function config(databasePath: string): AppConfig {
  return {
    accessContexts: [{ id: "default", userId: "530" }],
    apiBaseUrl: "https://open.fangcloud.com/api",
    authorityScopes: [{ id: "tender", rootFolderId: "1", accessContext: "default", tags: ["tender"] }],
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client", clientSecret: "secret", defaultAccessContext: "default", defaultUserId: "530", enterpriseId: "115", logLevel: "info",
    maxDownloadBytes: 1024, maxPageCapacity: 500, requestTimeoutMs: 1000, retryBaseDelayMs: 1, retryMaxAttempts: 1,
    stateDatabasePath: databasePath, tempDir: path.dirname(databasePath), tempFileTtlSeconds: 0, tokenRefreshSkewSeconds: 30,
    toolsets: ["inventory"], transport: "stdio", workflowProfiles: ["tender"]
  };
}

const policy: ScopeScanPolicy = {
  caseSensitive: false,
  includeFiles: true,
  includeFolders: true,
  matchFields: ["name", "path"],
  maxItemDepth: 5,
  maxItems: 1000,
  pageCapacity: 2
};

function provider(): ScopeScanProvider {
  return {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder", modified_at_unix: 1 }, meta: meta("/root") }),
    listChildren: async (folderId, _userId, pageId): Promise<ScopeScanPage> => {
      if (String(folderId) === "1" && pageId === 0) {
        return { files: [{ id: "10", name: "目标文件.docx", type: "file", parent_folder_id: "1" }], folders: [{ id: "2", name: "证书", type: "folder", parent_folder_id: "1" }], hasMore: true, nextPageId: 1, pageCapacity: 2, pageId: 0, paginationReliable: true, meta: meta("/1/0") };
      }
      if (String(folderId) === "1") {
        return { files: [], folders: [], hasMore: false, pageCapacity: 2, pageId, paginationReliable: true, meta: meta("/1/1") };
      }
      return { files: [{ id: "12", name: "验收证书.pdf", type: "file", parent_folder_id: "2" }], folders: [], hasMore: false, pageCapacity: 2, pageId: 0, paginationReliable: true, meta: meta("/2/0") };
    }
  };
}

test("background snapshot completes and queries indexed SQLite items", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const appConfig = config(":memory:");
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(appConfig));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 5, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const completed = await service.get(started.state.scanId);
    assert.equal(completed.status, "complete");
    assert.equal(completed.pageReceiptCount, 3);
    const result = await service.query({ scanId: completed.scanId, mode: "search", queries: ["验收证书"], limit: 10 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]?.name, "验收证书.pdf");
    const firstPage = await service.query({ scanId: completed.scanId, mode: "list", type: "all", limit: 1 });
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.query({ scanId: completed.scanId, mode: "list", type: "all", cursor: firstPage.nextCursor, limit: 1 });
    assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
    await assert.rejects(
      () => service.query({ scanId: completed.scanId, mode: "list", type: "all", cursor: { ...firstPage.nextCursor!, revision: firstPage.nextCursor!.revision - 1 }, limit: 1 }),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_CURSOR_STALE")
    );
    assert.equal((service.summary(completed).completeness as Record<string, unknown>).safe_to_claim_absence, true);
  } finally {
    await service.close();
  }
});

test("max_item_depth never stores deeper items and keeps absence claims disabled", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 1, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const completed = await service.get(started.state.scanId);
    assert.equal(completed.status, "partial");
    assert.ok(completed.incompleteReasons.includes("MAX_DEPTH_REACHED"));
    const listed = await service.query({ scanId: completed.scanId, mode: "list", type: "all", limit: 100 });
    assert.ok(listed.items.every((item) => typeof item.depth === "number" && item.depth <= 1));
    assert.ok(!listed.items.some((item) => item.id === "12"));
    assert.equal((service.summary(completed).completeness as Record<string, unknown>).safe_to_claim_absence, false);
  } finally {
    await service.close();
  }
});

test("concurrent equivalent snapshot creation reuses one operation", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const appConfig = config(":memory:");
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(appConfig));
  await service.initialize();
  try {
    const input = { accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"] as Array<"name" | "path">, maxItemDepth: 5, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" };
    const [left, right] = await Promise.all([service.create(input), service.create(input)]);
    assert.equal(left.state.scanId, right.state.scanId);
    assert.ok(left.reused || right.reused);
    await service.waitForIdle(left.state.scanId);
  } finally {
    await service.close();
  }
});

test("inventory reuse honors freshness and force refresh", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const input = { accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"] as Array<"name" | "path">, maxAgeSeconds: 300, maxItemDepth: 5, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" };
    const first = await service.create(input);
    await service.waitForIdle(first.state.scanId);
    const reused = await service.create(input);
    assert.equal(reused.state.scanId, first.state.scanId);
    assert.equal(reused.reuseReason, "fresh_complete");
    const refreshed = await service.create({ ...input, forceRefresh: true });
    assert.notEqual(refreshed.state.scanId, first.state.scanId);
    assert.equal(refreshed.reuseReason, "new");
    await service.waitForIdle(refreshed.state.scanId);
  } finally {
    await service.close();
  }
});

test("running inventories are reused even when the completed freshness window is zero", async () => {
  let requestStarted!: () => void;
  const startedRequest = new Promise<void>((resolve) => { requestStarted = resolve; });
  const slowProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, _pageId, _pageCapacity, signal) => {
      requestStarted();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true }));
      throw new Error("unreachable");
    }
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, slowProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const input = { accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"] as Array<"name" | "path">, maxAgeSeconds: 0, maxItemDepth: 5, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" };
    const first = await service.create(input);
    await startedRequest;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reused = await service.create(input);
    assert.equal(reused.state.scanId, first.state.scanId);
    assert.equal(reused.reuseReason, "running_join");
    await service.cancel(first.state.scanId);
  } finally {
    await service.close();
  }
});

test("partial inventories are never reused automatically", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const input = { accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"] as Array<"name" | "path">, maxAgeSeconds: 300, maxItemDepth: 1, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" };
    const first = await service.create(input);
    await service.waitForIdle(first.state.scanId);
    assert.equal((await service.get(first.state.scanId)).status, "partial");
    const second = await service.create(input);
    assert.notEqual(second.state.scanId, first.state.scanId);
    assert.equal(second.reuseReason, "new");
    await service.waitForIdle(second.state.scanId);
  } finally {
    await service.close();
  }
});

test("SQLite snapshot resumes after repository restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-restart-"));
  const databasePath = path.join(dir, "state.sqlite");
  const appConfig = config(databasePath);
  try {
    const firstStore = new SqliteScopeScanStore(databasePath, 3600, 10_000_000);
    const firstEngine = new ScopeScanEngine(firstStore, provider());
    const access = new AccessRegistry(appConfig).resolveContext("default");
    const started = await firstEngine.start({ accessContextId: "default", accessIdentityRef: access.identityRef, policy, rootFolderId: "1", userId: "530" });
    const partial = await firstEngine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId, userId: "530" });
    assert.equal(partial.status, "running");
    firstStore.close();

    const secondStore = new SqliteScopeScanStore(databasePath, 3600, 10_000_000);
    const service = new SnapshotService(new ScopeScanEngine(secondStore, provider()), secondStore, new AccessRegistry(appConfig));
    await service.initialize();
    await service.waitForIdle(started.state.scanId);
    const completed = await service.get(started.state.scanId);
    assert.equal(completed.status, "complete");
    await service.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("snapshot store rejects a database with a different schema version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-schema-"));
  const databasePath = path.join(dir, "state.sqlite");
  const old = new DatabaseSync(databasePath);
  old.exec("CREATE TABLE snapshots(scan_id TEXT PRIMARY KEY)");
  old.close();
  try {
    assert.throws(() => new SqliteScopeScanStore(databasePath, 3600, 10_000_000), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_STATE_SCHEMA_MISMATCH"));
    await assert.rejects(() => fs.stat(`${databasePath}.lock`), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("bounded concurrent page fetch preserves canonical receipt order", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const concurrentProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (pageId > 0) await new Promise((resolve) => setTimeout(resolve, (5 - pageId) * 15));
        return {
          files: [{ id: String(pageId + 10), name: `file-${pageId}.txt`, type: "file", parent_folder_id: "1" }],
          folders: [],
          hasMore: pageId < 4,
          ...(pageId < 4 ? { nextPageId: pageId + 1 } : {}),
          pageCapacity: 1,
          pageCount: 5,
          pageId,
          paginationReliable: true,
          meta: meta(`/page/${pageId}`)
        };
      } finally {
        inFlight -= 1;
      }
    }
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, concurrentProvider), store, new AccessRegistry(config(":memory:")), 4);
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 1, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const manifest = await service.manifest(started.state.scanId);
    const receipts = manifest.receipts as Array<Record<string, unknown>>;
    assert.ok(maxInFlight >= 3, `expected concurrent Provider requests, observed ${maxInFlight}`);
    assert.deepEqual(receipts.map((receipt) => receipt.page_id), [0, 1, 2, 3, 4]);
    assert.deepEqual(manifest.receipt_summary, { total_count: 5, included_count: 5, truncated: false });
    assert.equal((manifest.policy as Record<string, unknown>).page_capacity, 1);
    assert.equal((manifest.policy as Record<string, unknown>).pageCapacity, undefined);
  } finally {
    await service.close();
  }
});

test("inventory manifests bound inline receipts and report truncation", async () => {
  const pageCount = 105;
  const receiptProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => ({
      files: [{ id: String(pageId + 10), name: `file-${pageId}.txt`, type: "file", parent_folder_id: "1" }],
      folders: [],
      hasMore: pageId + 1 < pageCount,
      ...(pageId + 1 < pageCount ? { nextPageId: pageId + 1 } : {}),
      pageCapacity: 1,
      pageCount,
      pageId,
      paginationReliable: true,
      totalCount: pageCount,
      meta: meta(`/page/${pageId}`)
    })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 20_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, receiptProvider), store, new AccessRegistry(config(":memory:")), 4);
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: pageCount, pageCapacity: 1, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const manifest = await service.manifest(started.state.scanId);
    assert.equal((manifest.receipts as unknown[]).length, 100);
    assert.deepEqual(manifest.receipt_summary, { total_count: pageCount, included_count: 100, truncated: true });
  } finally {
    await service.close();
  }
});

test("snapshot status and cancellation remain responsive during slow Provider I/O", async () => {
  let requestStarted!: () => void;
  const startedRequest = new Promise<void>((resolve) => { requestStarted = resolve; });
  const slowProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, _pageId, _pageCapacity, signal) => {
      requestStarted();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    }
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, slowProvider), store, new AccessRegistry(config(":memory:")), 2);
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 10, rootFolderId: "1" });
    await startedRequest;
    const status = await Promise.race([
      service.get(started.state.scanId),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("status query blocked")), 200))
    ]);
    assert.equal(status.status, "running");
    const cancelled = await Promise.race([
      service.cancel(started.state.scanId),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancellation blocked")), 500))
    ]);
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await service.close();
  }
});

test("cancelling a terminal inventory is a revision-preserving no-op", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 5, maxItems: 1000, pageCapacity: 2, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const terminal = await service.get(started.state.scanId);
    assert.equal(terminal.status, "complete");
    const cancelled = await service.cancel(terminal.scanId);
    assert.equal(cancelled.status, "complete");
    assert.equal(cancelled.revision, terminal.revision);
    assert.equal(cancelled.updatedAt, terminal.updatedAt);
  } finally {
    await service.close();
  }
});

test("snapshot worker persists a failed state when page commit exceeds quota", async () => {
  const quotaProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "x".repeat(10_000), type: "file", parent_folder_id: "1" }], folders: [], hasMore: false, pageId: 0, paginationReliable: true, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 3_000);
  const service = new SnapshotService(new ScopeScanEngine(store, quotaProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 100, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const failed = await service.get(started.state.scanId);
    assert.equal(failed.status, "failed");
    assert.equal((failed.lastError as Record<string, unknown>).code, "YFY_INVENTORY_STORAGE_INSUFFICIENT");
  } finally {
    await service.close();
  }
});

test("file-backed snapshot reserves WAL and index growth before committing a page", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-physical-quota-"));
  const databasePath = path.join(dir, "state.sqlite");
  const probe = new SqliteScopeScanStore(databasePath, 3600, 100_000_000);
  const baseline = probe.storageBytes();
  probe.close();
  const store = new SqliteScopeScanStore(databasePath, 3600, baseline + 500_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(config(databasePath)));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 2, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const failed = await service.get(started.state.scanId);
    assert.equal(failed.status, "failed");
    assert.equal((failed.lastError as Record<string, unknown>).code, "YFY_INVENTORY_STORAGE_INSUFFICIENT");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("duplicate items do not consume max_items capacity", async () => {
  const duplicateProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => pageId === 0
      ? { files: [{ id: "a", name: "A", type: "file" }], folders: [], hasMore: true, nextPageId: 1, pageId, paginationReliable: true, meta: meta("/0") }
      : { files: [{ id: "a", name: "A", type: "file" }, { id: "b", name: "B", type: "file" }], folders: [], hasMore: false, pageId, paginationReliable: true, meta: meta("/1") }
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, duplicateProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 2, pageCapacity: 2, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.fileCount, 2);
    const listed = await service.query({ scanId: state.scanId, mode: "list", type: "file", limit: 10 });
    assert.deepEqual(listed.items.map((item) => item.id).sort(), ["a", "b"]);
  } finally {
    await service.close();
  }
});

test("inconsistent pagination metadata cannot produce a complete snapshot", async () => {
  const inconsistentProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "A", type: "file" }], folders: [], hasMore: true, nextPageId: 1, pageCount: 1, pageId: 0, paginationReliable: true, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, inconsistentProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 100, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.status, "partial");
    assert.ok(state.incompleteReasons.includes("PAGINATION_METADATA_INCONSISTENT"));
  } finally {
    await service.close();
  }
});

test("has_more false cannot prove completion when page counts show remaining pages", async () => {
  const inconsistentProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "A", type: "file" }], folders: [], hasMore: false, pageCount: 2, pageId: 0, paginationReliable: false, totalCount: 2, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, inconsistentProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 1, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.status, "partial");
    assert.ok(state.incompleteReasons.includes("PAGINATION_METADATA_INCOMPLETE"));
    assert.equal((service.summary(state).completeness as Record<string, unknown>).safe_to_claim_absence, false);
  } finally {
    await service.close();
  }
});

test("a final page must account for the Provider total count", async () => {
  const inconsistentProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "A", type: "file" }], folders: [], hasMore: false, pageCapacity: 100, pageCount: 1, pageId: 0, paginationReliable: true, totalCount: 100, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, inconsistentProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 100, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.status, "partial");
    assert.ok(state.incompleteReasons.includes("PAGINATION_METADATA_INCONSISTENT"));
    assert.equal((service.summary(state).completeness as Record<string, unknown>).safe_to_claim_absence, false);
  } finally {
    await service.close();
  }
});

test("a non-empty page cannot claim page_count zero", async () => {
  const inconsistentProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "A", type: "file" }], folders: [], hasMore: false, pageCount: 0, pageId: 0, paginationReliable: true, totalCount: 1, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, inconsistentProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 1, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.status, "partial");
    assert.ok(state.incompleteReasons.includes("PAGINATION_METADATA_INCONSISTENT"));
  } finally {
    await service.close();
  }
});

test("a Provider next_page_id cannot skip an unobserved page", async () => {
  const skippingProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => pageId === 0
      ? { files: [{ id: "10", name: "A", type: "file" }], folders: [], hasMore: true, nextPageId: 2, pageId, paginationReliable: true, meta: meta("/page/0") }
      : { files: [], folders: [], hasMore: false, pageId, paginationReliable: true, meta: meta(`/page/${pageId}`) }
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, skippingProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 1, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const state = await service.get(started.state.scanId);
    assert.equal(state.status, "partial");
    assert.ok(state.incompleteReasons.includes("PAGINATION_METADATA_INCONSISTENT"));
  } finally {
    await service.close();
  }
});

test("saving a running snapshot refreshes its inactivity TTL", async () => {
  const store = new SqliteScopeScanStore(":memory:", 1, 10_000_000);
  const access = new AccessRegistry(config(":memory:")).resolveContext("default");
  try {
    const engine = new ScopeScanEngine(store, provider());
    const started = await engine.start({ accessContextId: "default", accessIdentityRef: access.identityRef, policy, rootFolderId: "1", userId: "530" });
    started.state.expiresAt = new Date(0).toISOString();
    await store.save(started.state);
    await store.pruneExpired();
    assert.equal((await store.load(started.state.scanId)).status, "running");
    assert.deepEqual((await store.listRunnable()).map((state) => state.scanId), [started.state.scanId]);
  } finally {
    store.close();
  }
});

test("stale running snapshots are pruned instead of resumed across observation windows", async () => {
  const store = new SqliteScopeScanStore(":memory:", 1, 10_000_000);
  const access = new AccessRegistry(config(":memory:")).resolveContext("default");
  try {
    const engine = new ScopeScanEngine(store, provider());
    const started = await engine.start({ accessContextId: "default", accessIdentityRef: access.identityRef, policy, rootFolderId: "1", userId: "530" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await store.pruneExpired();
    await assert.rejects(() => store.load(started.state.scanId), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_NOT_FOUND"));
    assert.deepEqual(await store.listRunnable(), []);
  } finally {
    store.close();
  }
});

test("one SQLite state database rejects a second process owner", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-lock-"));
  const databasePath = path.join(dir, "state.sqlite");
  const first = new SqliteScopeScanStore(databasePath, 3600, 10_000_000);
  try {
    assert.throws(() => new SqliteScopeScanStore(databasePath, 3600, 10_000_000), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_STATE_DB_IN_USE"));
  } finally {
    first.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a newly created empty process lock is not mistaken for a stale lock", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-empty-lock-"));
  const databasePath = path.join(dir, "state.sqlite");
  await fs.writeFile(`${databasePath}.lock`, "");
  try {
    assert.throws(() => new SqliteScopeScanStore(databasePath, 3600, 10_000_000), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_STATE_DB_IN_USE"));
    assert.equal(await fs.readFile(`${databasePath}.lock`, "utf8"), "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("a stale dead-owner process lock is recovered using ownership verification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-stale-lock-"));
  const databasePath = path.join(dir, "state.sqlite");
  const lockPath = `${databasePath}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ created_at_ms: 0, pid: 99999999, token: "stale" }));
  const staleTime = new Date(Date.now() - 10_000);
  await fs.utimes(lockPath, staleTime, staleTime);
  const store = new SqliteScopeScanStore(databasePath, 3600, 10_000_000);
  try {
    assert.match(await fs.readFile(lockPath, "utf8"), new RegExp(`"pid":${process.pid}`));
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("omitting access_context cannot read another context snapshot", async () => {
  const appConfig = config(":memory:");
  appConfig.accessContexts.push({ id: "other", userId: "531" });
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, provider()), store, new AccessRegistry(appConfig));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "other", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 2, rootFolderId: "1" });
    await assert.rejects(() => service.get(started.state.scanId), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_ACCESS_DENIED"));
    assert.equal((await service.get(started.state.scanId, "other")).accessContextId, "other");
  } finally {
    await service.close();
  }
});

test("large snapshots reject short or excessively broad search terms before a table scan", async () => {
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const access = new AccessRegistry(config(":memory:")).resolveContext("default");
  const engine = new ScopeScanEngine(store, provider());
  try {
    const started = await engine.start({ accessContextId: "default", accessIdentityRef: access.identityRef, policy, rootFolderId: "1", userId: "530" });
    started.state.fileCount = 100_001;
    await store.save(started.state);
    await assert.rejects(() => engine.search(started.state.scanId, ["证书"], "all", undefined, 10), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_QUERY_TOO_SHORT"));
    await assert.rejects(() => engine.search(started.state.scanId, Array.from({ length: 11 }, (_, index) => `query-${index}`), "all", undefined, 10), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_QUERY_TOO_BROAD"));
  } finally {
    store.close();
  }
});

test("case-sensitive snapshot search filters FTS case-folding false positives", async () => {
  const caseProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: "AbCd.txt", type: "file" }], folders: [], hasMore: false, pageId: 0, paginationReliable: true, meta: meta("/page") })
  };
  const store = new SqliteScopeScanStore(":memory:", 3600, 10_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, caseProvider), store, new AccessRegistry(config(":memory:")));
  await service.initialize();
  try {
    const started = await service.create({ accessContextId: "default", caseSensitive: true, includeFiles: true, includeFolders: true, matchFields: ["name"], maxItemDepth: 1, maxItems: 100, pageCapacity: 10, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const lower = await service.query({ scanId: started.state.scanId, mode: "search", queries: ["abc"], type: "all", limit: 10 });
    const exact = await service.query({ scanId: started.state.scanId, mode: "search", queries: ["AbC"], type: "all", limit: 10 });
    assert.equal(lower.total, 0);
    assert.equal(exact.total, 1);
  } finally {
    await service.close();
  }
});

test("SQLite snapshot handles 50000 synthetic files", { skip: process.env.YFY_RUN_PERF_TESTS !== "1" }, async () => {
  const pageCapacity = 500;
  const pageCount = 100;
  const largeProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => ({
      files: Array.from({ length: pageCapacity }, (_, index) => ({ id: String(pageId * pageCapacity + index + 1), name: `file-${pageId}-${index}.txt`, type: "file", parent_folder_id: "1" })),
      folders: [], hasMore: pageId + 1 < pageCount, ...(pageId + 1 < pageCount ? { nextPageId: pageId + 1 } : {}), pageCapacity, pageCount, pageId, paginationReliable: true, meta: meta(`/page/${pageId}`)
    })
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-perf-"));
  const databasePath = path.join(dir, "state.sqlite");
  const store = new SqliteScopeScanStore(databasePath, 1, 100_000_000);
  const appConfig = config(databasePath);
  const service = new SnapshotService(new ScopeScanEngine(store, largeProvider), store, new AccessRegistry(appConfig), 4);
  await service.initialize();
  try {
    const startedAt = performance.now();
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 1, maxItems: 50000, pageCapacity, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const completed = await service.get(started.state.scanId);
    assert.equal(completed.status, "complete");
    assert.equal(completed.fileCount, 50000);
    assert.equal(completed.pageReceiptCount, 100);
    const queryStartedAt = performance.now();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await service.query({ scanId: completed.scanId, mode: "search", queries: ["file-99"], limit: 100 });
      assert.equal(result.total, 500);
    }
    assert.ok(performance.now() - queryStartedAt < 2_000, "20 indexed snapshot queries exceeded 2 seconds");
    const scanBudgetMs = process.platform === "win32" ? 15_000 : 10_000;
    assert.ok(performance.now() - startedAt < scanBudgetMs, `50k disk-backed snapshot exceeded ${scanBudgetMs}ms`);
    assert.ok(store.storageBytes() > 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const pruneStartedAt = performance.now();
    await store.pruneExpired();
    assert.ok(performance.now() - pruneStartedAt < 2_000, "50k FTS snapshot cleanup exceeded 2 seconds");
    await assert.rejects(() => store.load(completed.scanId), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_INVENTORY_NOT_FOUND"));
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("SQLite frontier handles a wide folder tree without state JSON rewrites", { skip: process.env.YFY_RUN_PERF_TESTS !== "1" }, async () => {
  const pageCapacity = 500;
  const rootPageCount = 4;
  const wideProvider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (folderId, _userId, pageId) => String(folderId) === "1"
      ? {
          files: [],
          folders: Array.from({ length: pageCapacity }, (_, index) => ({ id: String(pageId * pageCapacity + index + 2), name: `folder-${pageId}-${index}`, type: "folder", parent_folder_id: "1" })),
          hasMore: pageId + 1 < rootPageCount,
          ...(pageId + 1 < rootPageCount ? { nextPageId: pageId + 1 } : {}),
          pageCapacity,
          pageCount: rootPageCount,
          pageId,
          paginationReliable: true,
          totalCount: pageCapacity * rootPageCount,
          meta: meta(`/root/${pageId}`)
        }
      : { files: [], folders: [], hasMore: false, pageCapacity, pageCount: 0, pageId: 0, paginationReliable: true, totalCount: 0, meta: meta(`/folder/${folderId}`) }
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-snapshot-wide-perf-"));
  const databasePath = path.join(dir, "state.sqlite");
  const store = new SqliteScopeScanStore(databasePath, 3600, 100_000_000);
  const service = new SnapshotService(new ScopeScanEngine(store, wideProvider), store, new AccessRegistry(config(databasePath)), 4);
  await service.initialize();
  try {
    const startedAt = performance.now();
    const started = await service.create({ accessContextId: "default", caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 1, maxItems: 2000, pageCapacity, rootFolderId: "1" });
    await service.waitForIdle(started.state.scanId);
    const completed = await service.get(started.state.scanId);
    assert.equal(completed.status, "complete");
    assert.equal(completed.folderCount, 2000);
    assert.equal(completed.pageReceiptCount, 2004);
    assert.equal(completed.frontierCount, 0);
    assert.ok(performance.now() - startedAt < 10_000, "wide frontier snapshot exceeded 10 seconds");
  } finally {
    await service.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
