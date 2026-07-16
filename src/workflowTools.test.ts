import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowTools } from "./tools/registerWorkflowTools.js";
import type { ApiJsonResponse, AppConfig, JsonValue } from "./types.js";
import type { YifangyunClient } from "./client.js";

type ToolHandler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;

class FakeServer {
  readonly tools = new Map<string, ToolHandler>();
  readonly resources = new Map<string, unknown>();

  registerTool(name: string, _definition: unknown, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  registerResource(name: string, ..._args: unknown[]): void {
    this.resources.set(name, _args);
  }
}

function response(endpoint: string, data: JsonValue): ApiJsonResponse {
  return { data, meta: { endpoint, fetchedAtIso: new Date().toISOString(), fetchedAtUnix: Math.floor(Date.now() / 1000), sourceApiVersion: "v2", statusCode: 200 } };
}

function config(scanDir: string): AppConfig {
  return {
    apiBaseUrl: "https://open.fangcloud.com/api",
    allowDownloadUrl: false,
    clientId: "client",
    clientSecret: "secret",
    defaultUserId: 530,
    enableAdminTools: false,
    enableMutationTools: false,
    enableRawResponse: false,
    enterpriseId: 115,
    fileAccessUserStrategy: "default",
    logLevel: "info",
    maxDownloadBytes: 1024,
    maxPageCapacity: 500,
    oauthBaseUrl: "https://open.fangcloud.com",
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 10,
    retryMaxAttempts: 1,
    scanDir,
    scanTtlSeconds: 3600,
    tempDir: path.dirname(scanDir),
    tempFileTtlSeconds: 60,
    tokenRefreshSkewSeconds: 300
  };
}

test("workflow tools expose durable start, advance, status, search and manifest resource", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-workflow-test-"));
  const server = new FakeServer();
  const client = {
    resolveAccessIdentityRef: () => "identity",
    getAsUser: async (endpoint: string, _userId?: unknown, params?: Record<string, unknown>) => {
      if (endpoint.endsWith("/info")) {
        return response(endpoint, { id: 1, name: "Root", type: "folder", modified_at: 1, space: { id: 480, name: "Bid", type: "department" } });
      }
      const pageId = Number(params?.page_id ?? 0);
      return response(endpoint, {
        files: [{ id: 10, name: "验收证书.pdf", type: "file", parent_folder_id: 1 }],
        folders: [],
        page_id: pageId,
        page_capacity: 200,
        page_count: 1,
        total_count: 1
      });
    }
  } as unknown as YifangyunClient;
  try {
    registerWorkflowTools(server as unknown as McpServer, client, config(path.join(dir, "scans")));
    for (const name of ["yfy_start_scope_scan", "yfy_advance_scope_scan", "yfy_get_scope_scan", "yfy_cancel_scope_scan", "yfy_search_scope_snapshot", "yfy_validate_authority_root"]) {
      assert.ok(server.tools.has(name), `${name} should be registered`);
    }
    assert.ok(server.resources.has("yfy_scope_scan_manifest"));
    const extra = { signal: new AbortController().signal, sendNotification: async () => undefined };
    const started = await server.tools.get("yfy_start_scope_scan")!({
      root_folder_id: 1,
      queries: ["验收证书"],
      match_fields: ["name", "path"],
      max_depth: 5,
      max_items: 100,
      page_capacity: 200,
      include_files: true,
      include_folders: true,
      case_sensitive: false
    }, extra);
    const startData = started.structuredContent?.data as Record<string, unknown>;
    const advanced = await server.tools.get("yfy_advance_scope_scan")!({ scan_id: startData.scan_id, expected_revision: 0, max_pages: 5, max_wall_ms: 5000 }, extra);
    const advanceData = advanced.structuredContent?.data as Record<string, unknown>;
    assert.equal(advanceData.status, "complete");
    assert.equal(advanceData.pagination_complete, true);
    const searched = await server.tools.get("yfy_search_scope_snapshot")!({ scan_id: startData.scan_id, queries: ["验收证书"], offset: 0, limit: 10 }, extra);
    const searchData = searched.structuredContent?.data as { total_matches: number };
    assert.equal(searchData.total_matches, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("authority root validation does not coerce a null folder id into a valid id", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-workflow-null-id-test-"));
  const server = new FakeServer();
  const client = {
    resolveAccessIdentityRef: () => "identity",
    getAsUser: async (endpoint: string) => endpoint.endsWith("/info")
      ? response(endpoint, { id: null, name: "Root", type: "folder" })
      : response(endpoint, { files: [], folders: [], page_id: 0, page_capacity: 1, page_count: 1, total_count: 0 })
  } as unknown as YifangyunClient;
  try {
    registerWorkflowTools(server as unknown as McpServer, client, config(path.join(dir, "scans")));
    const extra = { signal: new AbortController().signal, sendNotification: async () => undefined };
    const result = await server.tools.get("yfy_validate_authority_root")!({ root_folder_id: 1 }, extra);
    const data = result.structuredContent?.data as { checks: { exists: boolean }; validation_passed: boolean };
    assert.equal(data.checks.exists, false);
    assert.equal(data.validation_passed, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
