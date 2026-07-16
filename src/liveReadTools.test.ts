import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
class FakeServer {
  readonly tools = new Map<string, Handler>();
  registerTool(name: string, _definition: unknown, handler: Handler): void { this.tools.set(name, handler); }
  registerResource(): void {}
  registerPrompt(): void {}
}

function loadDotEnv(filePath: string): void {
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function call(server: FakeServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const handler = server.tools.get(name);
  assert.ok(handler, `${name} is not registered`);
  const result = await handler(args, { signal: new AbortController().signal, sendNotification: async () => undefined });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent ?? {};
}

test("v1 live read-only catalog works against Yifangyun", { skip: process.env.YFY_LIVE_READ_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-v1-live-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "core,authority,snapshot,evidence,organization";
  const rootFolderId = process.env.YFY_LIVE_SCOPE_ROOT_FOLDER_ID;
  if (rootFolderId) {
    process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "live_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  }
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  try {
    await call(server, "yfy_connection_check");
    await call(server, "yfy_context_get");
    const personal = await call(server, "yfy_space_list", { space: "personal", page_id: 0, page_capacity: 5 });
    const files = Array.isArray(personal.files) ? personal.files as Array<Record<string, unknown>> : [];
    const folders = Array.isArray(personal.folders) ? personal.folders as Array<Record<string, unknown>> : [];
    const candidate = files[0] ?? folders[0];
    const query = process.env.YFY_LIVE_SEARCH_QUERY ?? "test";
    await call(server, "yfy_item_search", {
      query,
      item_type: "all",
      field: "all",
      space: "personal",
      precise: false,
      sort: "score",
      direction: "desc",
      view: "summary",
      page_id: 0,
      page_capacity: 5
    });
    if (candidate?.id && candidate.type) {
      await call(server, "yfy_item_get", { item_type: candidate.type, item_id: String(candidate.id), view: "evidence" });
    }
    if (rootFolderId) {
      await call(server, "yfy_authority_validate", { scope_id: "live_scope" });
    }
    if (rootFolderId && process.env.YFY_LIVE_SNAPSHOT_TESTS === "enabled") {
      const started = await call(server, "yfy_snapshot_create", { scope_id: "live_scope", queries: ["验收证书"], max_depth: 0, max_items: 100, page_capacity: 20 });
      const snapshotId = String(started.snapshot_id);
      let status = String(started.status);
      for (let attempt = 0; attempt < 20 && ["running", "paused_retryable"].includes(status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = await call(server, "yfy_snapshot_get", { snapshot_id: snapshotId });
        status = String(current.status);
      }
      const finalState = await call(server, "yfy_snapshot_get", { snapshot_id: snapshotId });
      assert.ok(["complete", "partial"].includes(String(finalState.status)), `Unexpected live snapshot status: ${finalState.status}`);
      await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "search", queries: ["验收证书"], item_type: "all", limit: 10 });
    }
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
