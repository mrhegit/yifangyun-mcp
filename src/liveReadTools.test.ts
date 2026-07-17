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
  process.env.YFY_TOOLSETS = "core,authority,snapshot,evidence,organization";
  const rootFolderId = process.env.YFY_LIVE_SCOPE_ROOT_FOLDER_ID;
  process.env.YFY_WORKFLOW_PROFILES = rootFolderId ? "tender" : "";
  if (rootFolderId) {
    process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "live_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  }
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  try {
    const connection = await call(server, "yfy_connection_check");
    assert.equal(connection.authenticated, true);
    const context = await call(server, "yfy_context_get");
    assert.ok(Array.isArray(context.access_contexts));
    const personal = await call(server, "yfy_root_list", { root: { kind: "personal" }, page_id: 0, page_capacity: 5 });
    const files = Array.isArray(personal.files) ? personal.files as Array<Record<string, unknown>> : [];
    const folders = Array.isArray(personal.folders) ? personal.folders as Array<Record<string, unknown>> : [];
    const candidate = files[0] ?? folders[0];
    const personalPage = personal.page as Record<string, unknown>;
    assert.equal((personalPage.requested as Record<string, unknown>).page_id, 0);
    assert.equal(typeof personalPage.has_more, "boolean");
    if (typeof personalPage.page_count === "number") {
      const beyond = await call(server, "yfy_root_list", { root: { kind: "personal" }, page_id: personalPage.page_count, page_capacity: 5 });
      assert.equal((beyond.page as Record<string, unknown>).has_more, false);
    }
    const query = process.env.YFY_LIVE_SEARCH_QUERY ?? "test";
    const search = await call(server, "yfy_item_search", {
      query,
      item_type: "all",
      field: "all",
      root: { kind: "personal" },
      precise: false,
      sort: "score",
      direction: "desc",
      page_id: 0,
      page_capacity: 5
    });
    assert.deepEqual(search.authority, { level: "hint_only", safe_to_claim_absence: false });
    const searchPage = search.page as Record<string, unknown>;
    if (typeof searchPage.page_count === "number") {
      const beyond = await call(server, "yfy_item_search", {
        query, item_type: "all", field: "all", root: { kind: "personal" }, precise: false,
        sort: "score", direction: "desc", page_id: searchPage.page_count, page_capacity: 5
      });
      assert.equal((beyond.page as Record<string, unknown>).has_more, false);
    }
    if (candidate?.id && candidate.type) {
      const item = await call(server, "yfy_item_get", { item_type: candidate.type, item_id: String(candidate.id), view: "evidence" });
      assert.equal((item.item as Record<string, unknown>).id, String(candidate.id));
      if (typeof candidate.name === "string") {
        const resolved = await call(server, "yfy_path_resolve", { path: candidate.name, root: { kind: "personal" } });
        assert.equal(resolved.resolved, true);
      }
      await call(server, "yfy_share_list", { item_type: candidate.type, item_id: String(candidate.id), page_id: 0, page_capacity: 5 });
      if (candidate.type === "file") {
        const batch = await call(server, "yfy_items_get", { file_ids: [String(candidate.id)], view: "summary" });
        assert.equal((batch.summary as Record<string, unknown>).success_count, 1);
        await call(server, "yfy_file_versions", { file_id: String(candidate.id) });
        await call(server, "yfy_file_comments", { file_id: String(candidate.id) });
      }
    }
    const folderCandidate = folders.find((entry) => entry.id && entry.type === "folder");
    if (folderCandidate?.id) {
      const children = await call(server, "yfy_folder_list", { folder_id: String(folderCandidate.id), item_type: "file", view: "evidence", page_id: 0, page_capacity: 5 });
      const child = Array.isArray(children.files) ? (children.files as Array<Record<string, unknown>>)[0] : undefined;
      if (child?.name) {
        const scoped = await call(server, "yfy_item_search", {
          query: String(child.name), item_type: "file", field: "file_name", root: { kind: "folder", folder_id: String(folderCandidate.id) }, precise: true,
          sort: "score", direction: "desc", page_id: 0, page_capacity: 5
        });
        const scopedCandidates = Array.isArray(scoped.candidates) ? scoped.candidates as Array<Record<string, unknown>> : [];
        assert.ok(scopedCandidates.every((candidate) => (candidate.item as Record<string, unknown>).name === child.name));
        assert.ok(scopedCandidates.every((candidate) => ((candidate.verification as Record<string, unknown>).folder_scope === "verified")));
      }
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
