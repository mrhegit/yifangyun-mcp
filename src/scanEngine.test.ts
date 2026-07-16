import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ScopeScanEngine } from "./scan/engine.js";
import { ScopeScanStore } from "./scan/store.js";
import type { ScopePageArtifact, ScopeScanPage, ScopeScanPolicy, ScopeScanProvider } from "./scan/types.js";

function meta(endpoint: string) {
  return { endpoint, fetchedAtIso: new Date().toISOString(), fetchedAtUnix: Math.floor(Date.now() / 1000), sourceApiVersion: "v2", statusCode: 200 };
}

const policy: ScopeScanPolicy = {
  caseSensitive: false,
  includeFiles: true,
  includeFolders: true,
  matchFields: ["name", "path"],
  maxDepth: 5,
  maxItems: 1000,
  pageCapacity: 2,
  queries: ["目标", "验收证书"]
};

async function tempStore(): Promise<{ dir: string; store: ScopeScanStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-scan-test-"));
  return { dir, store: new ScopeScanStore(dir, 3600) };
}

test("durable scope scan resumes from committed revision and reuses one snapshot for multiple queries", async () => {
  const { dir, store } = await tempStore();
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder", modified_at_unix: 1 }, meta: meta("/root") }),
    listChildren: async (folderId, _userId, pageId): Promise<ScopeScanPage> => {
      if (String(folderId) === "1" && pageId === 0) {
        return { files: [{ id: "10", name: "目标文件.docx", type: "file", parent_folder_id: "1" }], folders: [{ id: "2", name: "证书", type: "folder", parent_folder_id: "1" }], hasMore: true, meta: meta("/1/0"), nextPageId: 1, pageCapacity: 2, pageId: 0, paginationReliable: true };
      }
      if (String(folderId) === "1" && pageId === 1) {
        return { files: [{ id: "11", name: "其他.txt", type: "file", parent_folder_id: "1" }], folders: [], hasMore: false, meta: meta("/1/1"), pageCapacity: 2, pageId: 1, paginationReliable: true };
      }
      return { files: [{ id: "12", name: "验收证书.pdf", type: "file", parent_folder_id: "2" }], folders: [], hasMore: false, meta: meta("/2/0"), pageCapacity: 2, pageId: 0, paginationReliable: true };
    }
  };
  try {
    const firstEngine = new ScopeScanEngine(store, provider);
    const started = await firstEngine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const partial = await firstEngine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId });
    assert.equal(partial.revision, 1);
    assert.equal(partial.status, "running");

    const resumedEngine = new ScopeScanEngine(new ScopeScanStore(dir, 3600), provider);
    const completed = await resumedEngine.advance({ expectedRevision: 1, maxPages: 10, maxWallMs: 5000, scanId: started.state.scanId });
    assert.equal(completed.status, "complete");
    assert.equal(completed.pageReceiptCount, 3);
    const matches = await resumedEngine.search(completed.scanId, ["目标", "验收证书"], 0, 10);
    assert.deepEqual(matches.items.map((item) => item.name), ["目标文件.docx", "验收证书.pdf"]);
    assert.equal(resumedEngine.summary(completed).safe_to_claim_absence, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("scope scan recovers a pending page transaction after process restart", async () => {
  const { dir, store } = await tempStore();
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [], folders: [], hasMore: false, meta: meta("/page"), pageCapacity: 10, pageId: 0, paginationReliable: true })
  };
  try {
    const engine = new ScopeScanEngine(store, provider);
    const started = await engine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const observedAt = new Date().toISOString();
    const artifact: ScopePageArtifact = {
      files: [{ id: "10", name: "recovered.txt", type: "file", depth: 1, path_display: "Root/recovered.txt" }],
      folders: [],
      pageKey: "1:0",
      receipt: { attempt: 1, folderId: "1", hasMore: false, itemCount: 1, latencyMs: 1, observedAt, pageCapacity: 10, pageId: 0, responseDigest: "digest", storedItemCount: 1 }
    };
    const recoveredState = structuredClone(started.state);
    recoveredState.completedPageKeys = ["1:0"];
    recoveredState.fileCount = 1;
    recoveredState.frontier = [];
    recoveredState.observationUpdatedAt = observedAt;
    recoveredState.pageAttempts = { "1:0": 1 };
    recoveredState.pageReceiptCount = 1;
    recoveredState.revision = 1;
    recoveredState.status = "complete";
    recoveredState.updatedAt = observedAt;
    const transactionPath = path.join(dir, started.state.scanId, "pending-page-commit.json");
    await fs.writeFile(transactionPath, JSON.stringify({ artifact, state: recoveredState, version: 1 }), "utf8");

    const restartedStore = new ScopeScanStore(dir, 3600);
    const loaded = await restartedStore.load(started.state.scanId);
    const pages = await restartedStore.listPages(started.state.scanId);
    assert.equal(loaded.revision, 1);
    assert.equal(loaded.status, "complete");
    assert.equal(pages[0]?.files[0]?.name, "recovered.txt");
    await assert.rejects(() => fs.access(transactionPath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("scope scan rejects stale revisions and records malformed pagination as partial", async () => {
  const { dir, store } = await tempStore();
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [], folders: [], hasMore: true, meta: meta("/page"), nextPageId: 1, pageCapacity: 10, pageId: 0, paginationReliable: false })
  };
  try {
    const engine = new ScopeScanEngine(store, provider);
    const started = await engine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const partial = await engine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId });
    assert.equal(partial.status, "partial");
    assert.ok(partial.incompleteReasons.includes("EMPTY_PAGE_WITH_MORE"));
    assert.ok(partial.incompleteReasons.includes("PAGINATION_METADATA_INCOMPLETE"));
    await assert.rejects(() => engine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId }), /revision conflict/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scope scan commits a resumable checkpoint when the MCP request is cancelled", async () => {
  const { dir, store } = await tempStore();
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [], folders: [], hasMore: false, meta: meta("/page"), pageCapacity: 10, pageId: 0, paginationReliable: true })
  };
  try {
    const engine = new ScopeScanEngine(store, provider);
    const started = await engine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const controller = new AbortController();
    controller.abort("cancelled by test");
    const cancelledStep = await engine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId, signal: controller.signal });
    assert.equal(cancelledStep.status, "paused_retryable");
    assert.equal(cancelledStep.revision, 1);
    assert.ok(cancelledStep.incompleteReasons.includes("CLIENT_CANCELLED_STEP"));
    const persisted = await engine.get(started.state.scanId);
    assert.equal(persisted.revision, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scope scan reports a terminal local-storage failure without losing its frontier", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-scan-quota-test-"));
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [{ id: "10", name: `${"x".repeat(10000)}.txt`, type: "file" }], folders: [], hasMore: false, meta: meta("/page"), pageCapacity: 10, pageId: 0, paginationReliable: true })
  };
  try {
    const initialEngine = new ScopeScanEngine(new ScopeScanStore(dir, 3600), provider);
    const started = await initialEngine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const initialStateBytes = (await fs.stat(path.join(dir, started.state.scanId, "state.json"))).size;
    const limitedEngine = new ScopeScanEngine(new ScopeScanStore(dir, 3600, initialStateBytes + 2000), provider);
    const failed = await limitedEngine.advance({ expectedRevision: 0, maxPages: 1, maxWallMs: 5000, scanId: started.state.scanId });
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError?.code, "YFY_SCAN_STORAGE_INSUFFICIENT");
    assert.equal(failed.frontier.length, 1);
    assert.equal(failed.pageReceiptCount, 0);
    assert.deepEqual(failed.completedPageKeys, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scope scan quota includes checkpoint state growth", async () => {
  const { dir, store } = await tempStore();
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async () => ({ files: [], folders: [], hasMore: false, meta: meta("/page"), pageCapacity: 10, pageId: 0, paginationReliable: true })
  };
  try {
    const engine = new ScopeScanEngine(store, provider);
    const started = await engine.start({ accessIdentityRef: "identity", policy, rootFolderId: 1 });
    const statePath = path.join(dir, started.state.scanId, "state.json");
    const initialStateBytes = (await fs.stat(statePath)).size;
    const limitedStore = new ScopeScanStore(dir, 3600, initialStateBytes + 100);
    const oversizedState = structuredClone(started.state);
    oversizedState.incompleteReasons = ["x".repeat(1000)];
    await assert.rejects(() => limitedStore.save(oversizedState), (error: unknown) => error instanceof Error && "code" in error && error.code === "YFY_SCAN_STORAGE_INSUFFICIENT");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("scope scan handles 50000 synthetic files with bounded page steps", { skip: process.env.YFY_RUN_PERF_TESTS !== "1" }, async () => {
  const { dir, store } = await tempStore();
  const pageCapacity = 500;
  const pageCount = 100;
  const provider: ScopeScanProvider = {
    getRoot: async () => ({ folder: { id: "1", name: "Root", type: "folder" }, meta: meta("/root") }),
    listChildren: async (_folderId, _userId, pageId) => ({
      files: Array.from({ length: pageCapacity }, (_, index) => ({ id: String(pageId * pageCapacity + index + 1), name: `file-${pageId}-${index}.txt`, type: "file", parent_folder_id: "1" })),
      folders: [],
      hasMore: pageId + 1 < pageCount,
      meta: meta(`/page/${pageId}`),
      ...(pageId + 1 < pageCount ? { nextPageId: pageId + 1 } : {}),
      pageCapacity,
      pageId,
      paginationReliable: true
    })
  };
  try {
    const engine = new ScopeScanEngine(store, provider);
    const perfPolicy = { ...policy, maxItems: 50000, pageCapacity };
    let state = (await engine.start({ accessIdentityRef: "identity", policy: perfPolicy, rootFolderId: 1 })).state;
    while (state.status === "running") {
      state = await engine.advance({ expectedRevision: state.revision, maxPages: 10, maxWallMs: 30000, scanId: state.scanId });
    }
    assert.equal(state.status, "complete");
    assert.equal(state.fileCount, 50000);
    assert.equal(state.pageReceiptCount, 100);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
