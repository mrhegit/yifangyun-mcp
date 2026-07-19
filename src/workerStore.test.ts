import assert from "node:assert/strict";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { WorkerScopeScanStore } from "./scan/workerStore.js";

interface WorkerStoreInternals {
  pending: Map<number, unknown>;
  request(method: string, args: unknown[]): Promise<unknown>;
  worker: Worker;
}

function internals(store: WorkerScopeScanStore): WorkerStoreInternals {
  return store as unknown as WorkerStoreInternals;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("Worker store rejects new RPCs immediately after its worker exits", async () => {
  const store = await WorkerScopeScanStore.create(":memory:", 60, 1_000_000);
  await internals(store).worker.terminate();

  await assert.rejects(() => store.load("missing"), /worker exited/i);
  await withTimeout(store.close(), 250, "close timed out");
});

test("Worker store rejects RPCs that are pending when its worker exits", async () => {
  const store = await WorkerScopeScanStore.create(":memory:", 60, 1_000_000);
  const internal = internals(store);
  const originalPostMessage = internal.worker.postMessage.bind(internal.worker);
  internal.worker.postMessage = ((message: { method?: string }) => {
    if (message.method === "load") return;
    return originalPostMessage(message);
  }) as Worker["postMessage"];
  const pending = store.load("missing");
  await internal.worker.terminate();
  await assert.rejects(() => pending, /worker exited/i);
  await store.close();
});

test("Worker store removes pending RPC state when structured clone fails", async () => {
  const store = await WorkerScopeScanStore.create(":memory:", 60, 1_000_000);
  const internal = internals(store);
  try {
    await assert.rejects(() => internal.request("load", [() => undefined]), (error: unknown) => error instanceof Error && error.name === "DataCloneError");
    assert.equal(internal.pending.size, 0);
    assert.deepEqual(await store.storageStats(), { database_bytes: 0, logical_bytes: 0, wal_bytes: 0 });
  } finally {
    await store.close();
  }
});

test("Worker store terminates even when the close RPC fails", async () => {
  const store = await WorkerScopeScanStore.create(":memory:", 60, 1_000_000);
  const internal = internals(store);
  const originalRequest = internal.request.bind(internal);
  internal.request = async (method, args) => {
    if (method === "close") throw new Error("close RPC failed");
    return originalRequest(method, args);
  };
  await assert.rejects(() => store.close(), /close RPC failed/);
  assert.equal(internal.worker.threadId, -1);
});
