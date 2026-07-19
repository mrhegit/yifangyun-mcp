import { parentPort } from "node:worker_threads";
import { SqliteScopeScanStore } from "./store.js";

interface WorkerRequest {
  args: unknown[];
  id: number;
  method: string;
}

const port = parentPort;
if (!port) throw new Error("Inventory store worker requires a parent port.");

let store: SqliteScopeScanStore | undefined;

port.on("message", async (request: WorkerRequest) => {
  try {
    if (request.method === "initialize") {
      const [databasePath, ttlSeconds, maxBytes] = request.args as [string, number, number];
      store = new SqliteScopeScanStore(databasePath, ttlSeconds, maxBytes);
      port.postMessage({ id: request.id, value: null });
      return;
    }
    if (!store) throw new Error("Inventory store worker is not initialized.");
    if (request.method === "close") {
      store.close();
      port.postMessage({ id: request.id, value: null });
      return;
    }
    const method = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[request.method];
    if (typeof method !== "function") throw new Error(`Unknown inventory store method: ${request.method}`);
    const value = await method.apply(store, request.args);
    const stateIndex = request.method === "create" || request.method === "save" ? 0
      : request.method === "commitPage" ? 3
        : request.method === "removeFrontier" ? 2
          : -1;
    port.postMessage({ id: request.id, ...(stateIndex >= 0 ? { state: request.args[stateIndex] } : {}), value });
  } catch (error) {
    const source = error instanceof Error ? error : new Error(String(error));
    const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
    port.postMessage({
      error: {
        agentDetails: details.agentDetails,
        code: details.code,
        details: details.details,
        message: source.message,
        name: source.name,
        phase: details.phase,
        retryAfterMs: details.retryAfterMs,
        retryable: details.retryable,
        scanId: details.scanId,
        statusCode: details.statusCode,
        suggestedAction: details.suggestedAction
      },
      id: request.id
    });
  }
});
