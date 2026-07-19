import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ content?: unknown; structuredContent?: Record<string, unknown>; isError?: boolean }>;
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
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  return result.structuredContent ?? {};
}

test("live read-only catalog works against Yifangyun", { skip: process.env.YFY_LIVE_READ_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-v1-live-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "drive,workspace,inventory,organization";
  const rootFolderId = process.env.YFY_LIVE_WORKSPACE_ROOT_FOLDER_ID;
  process.env.YFY_WORKFLOW_PROFILES = rootFolderId ? "tender" : "";
  if (rootFolderId) {
    process.env.YFY_WORKSPACES_JSON = JSON.stringify([{ id: "live_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  }
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  try {
    const status = await call(server, "yfy_status");
    assert.equal(status.connected, true);
    const personal = await call(server, "yfy_browse", { at: "personal", limit: 5 });
    const items = Array.isArray(personal.items) ? personal.items as Array<Record<string, unknown>> : [];
    const files = items.filter((item) => item.type === "file");
    const folders = items.filter((item) => item.type === "folder");
    const candidate = files[0] ?? folders[0];
    const personalPage = personal.page as Record<string, unknown>;
    assert.equal(typeof personalPage.has_more, "boolean");
    const query = process.env.YFY_LIVE_SEARCH_QUERY ?? "test";
    const search = await call(server, "yfy_search", { query, in: "personal", limit: 5 });
    assert.deepEqual(search.coverage, { mode: "provider_index", exhaustive: false });
    if (candidate?.ref && candidate.type) {
      const item = await call(server, "yfy_get", { ref: String(candidate.ref) });
      assert.equal((item.item as Record<string, unknown>).id, String(candidate.id));
      if (typeof candidate.name === "string") {
        const resolved = await call(server, "yfy_resolve", { path: candidate.name, from: "personal" });
        assert.equal((resolved.outcome as Record<string, unknown>).status, "resolved");
      }
      await call(server, "yfy_shares", { item: String(candidate.ref), limit: 5 });
      if (candidate.type === "file") {
        const batch = await call(server, "yfy_get_many", { refs: [String(candidate.ref)] });
        assert.equal((batch.summary as Record<string, unknown>).success_count, 1);
        await call(server, "yfy_versions", { file: String(candidate.ref) });
        await call(server, "yfy_comments", { file: String(candidate.ref) });
      }
    }
    const folderCandidate = folders.find((entry) => entry.id && entry.type === "folder");
    if (folderCandidate?.id) {
      const children = await call(server, "yfy_browse", { at: String(folderCandidate.ref), kind: "file", limit: 5 });
      const child = Array.isArray(children.items) ? (children.items as Array<Record<string, unknown>>)[0] : undefined;
      if (child?.name) {
        const scoped = await call(server, "yfy_search", { query: String(child.name), in: String(folderCandidate.ref), kind: "file", field: "name", exact_name: true, limit: 5 });
        const hits = Array.isArray(scoped.hits) ? scoped.hits as Array<Record<string, unknown>> : [];
        assert.ok(hits.every((hit) => (hit.item as Record<string, unknown>).name === child.name));
      }
    }
    if (rootFolderId) {
      await call(server, "yfy_workspace_validate", { workspace: "workspace:live_scope" });
    }
    if (rootFolderId && process.env.YFY_LIVE_INVENTORY_TESTS === "enabled") {
      const started = await call(server, "yfy_inventory_create", { workspace: "workspace:live_scope", refresh: { mode: "force_refresh" }, limits: { max_item_depth: 1, max_items: 100 } });
      const inventory = String(started.inventory);
      let status = String(started.status);
      for (let attempt = 0; attempt < 20 && ["running", "retry_wait"].includes(status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const current = await call(server, "yfy_inventory_get", { inventory });
        status = String(current.status);
      }
      const finalState = await call(server, "yfy_inventory_get", { inventory });
      assert.ok(["complete", "partial"].includes(String(finalState.status)), `Unexpected live inventory status: ${finalState.status}`);
      await call(server, "yfy_inventory_search", { inventory, query: "验收证书", kind: "all", limit: 10 });
    }
  } finally {
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
