import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as RealMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./types.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;

class FakeServer {
  readonly tools = new Map<string, { definition: Record<string, unknown>; handler: Handler }>();
  registerTool(name: string, definition: Record<string, unknown>, handler: Handler): void {
    this.tools.set(name, { definition, handler });
  }
  registerResource(): void {}
  registerPrompt(): void {}
}

function config(toolsets: AppConfig["toolsets"]): AppConfig {
  return {
    accessContexts: [{ id: "default", userId: "530" }],
    apiBaseUrl: "https://open.fangcloud.com/api",
    authorityScopes: [{ id: "tender", rootFolderId: "501", accessContext: "default", tags: ["tender"] }],
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client",
    clientSecret: "secret",
    defaultAccessContext: "default",
    defaultUserId: "530",
    enterpriseId: "115",
    logLevel: "info",
    maxDownloadBytes: 1024,
    maxPageCapacity: 500,
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 1,
    retryMaxAttempts: 1,
    stateDatabasePath: ":memory:",
    tempDir: process.cwd(),
    tempFileTtlSeconds: 1,
    tokenRefreshSkewSeconds: 30,
    toolsets,
    transport: "stdio",
    workflowProfiles: ["tender"]
  };
}

test("default catalog exposes the current tools and schemas", async () => {
  const runtime = await AppRuntime.create(config(["core", "authority", "snapshot", "evidence", "organization"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    for (const name of ["yfy_context_get", "yfy_root_list", "yfy_item_get", "yfy_item_search", "yfy_authority_validate", "yfy_snapshot_create", "yfy_snapshot_query", "yfy_evidence_capture", "yfy_evidence_release"]) {
      assert.ok(server.tools.has(name), `${name} should be registered`);
    }
    assert.ok((server.tools.get("yfy_context_get")!.definition.outputSchema as Record<string, unknown>).access_contexts);
    assert.ok(server.tools.get("yfy_snapshot_query")!.definition.outputSchema);
    const snapshotInput = server.tools.get("yfy_snapshot_query")!.definition.inputSchema as Record<string, unknown>;
    assert.ok(snapshotInput.cursor);
    assert.deepEqual(Object.keys(server.tools.get("yfy_snapshot_create")!.definition.inputSchema as Record<string, unknown>).sort(), ["case_sensitive", "include_files", "include_folders", "match_fields", "max_item_depth", "max_items", "page_capacity", "scope_id"]);
    assert.equal((server.tools.get("yfy_snapshot_create")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_snapshot_cancel")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_evidence_capture")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    const result = await server.tools.get("yfy_context_get")!.handler({}, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent?.access_contexts);
    assert.equal((result.structuredContent?.server as Record<string, unknown>).version, "1.0.0-beta.4");
    assert.ok(!Object.prototype.hasOwnProperty.call(result.structuredContent?.runtime ?? {}, "state_database_path"));
  } finally {
    await runtime.close();
  }
});

test("optional toolsets preserve mutation, collaboration, admin and transfer capability", async () => {
  const runtime = await AppRuntime.create(config(["core", "authority", "snapshot", "evidence", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    for (const name of ["yfy_folder_create", "yfy_item_mutate", "yfy_file_upload", "yfy_collaboration_mutate", "yfy_admin_department_mutate", "yfy_admin_platform_sync", "yfy_transfer_ticket_get"]) {
      assert.ok(server.tools.has(name), `${name} should be registered`);
    }
    assert.equal((server.tools.get("yfy_item_mutate")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_file_upload")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal(server.tools.size, 38);
    for (const [name, tool] of server.tools) assert.ok(tool.definition.outputSchema, `${name} must declare outputSchema`);
  } finally {
    await runtime.close();
  }
});

test("the MCP client compiles every catalog output schema", async () => {
  const runtime = await AppRuntime.create(config(["core", "authority", "snapshot", "evidence", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new RealMcpServer({ name: "schema-test", version: "1.0.0" });
  const client = new Client({ name: "schema-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    registerCatalog(server, runtime);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 38);
    assert.ok(listed.tools.every((tool) => tool.outputSchema));
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
  }
});

test("core tools are absent when the core toolset is disabled", async () => {
  const runtime = await AppRuntime.create(config(["evidence"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    assert.ok(server.tools.has("yfy_evidence_capture"));
    assert.ok(!server.tools.has("yfy_item_get"));
    assert.ok(!server.tools.has("yfy_connection_check"));
  } finally {
    await runtime.close();
  }
});

test("organization tools can be enabled without the core toolset", async () => {
  const runtime = await AppRuntime.create(config(["organization"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    assert.ok(server.tools.has("yfy_department_read"));
    assert.ok(server.tools.has("yfy_user_search"));
    assert.ok(!server.tools.has("yfy_item_get"));
  } finally {
    await runtime.close();
  }
});
