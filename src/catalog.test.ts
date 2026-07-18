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
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "evidence", "organization"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    const expected = [
      "yfy_browse", "yfy_capture", "yfy_comments", "yfy_department_children", "yfy_department_get", "yfy_department_users",
      "yfy_get", "yfy_get_many", "yfy_group_list", "yfy_group_users", "yfy_inventory_cancel", "yfy_inventory_create",
      "yfy_inventory_get", "yfy_inventory_release", "yfy_inventory_search", "yfy_membership_check", "yfy_open", "yfy_resolve", "yfy_resource_release",
      "yfy_search", "yfy_shares", "yfy_status", "yfy_user_search", "yfy_versions", "yfy_workspace_validate"
    ];
    assert.deepEqual([...server.tools.keys()].sort(), expected);
    for (const removed of ["yfy_context_get", "yfy_root_list", "yfy_item_search", "yfy_authority_validate", "yfy_scope_check", "yfy_snapshot_create", "yfy_evidence_capture", "yfy_evidence_release"]) {
      assert.equal(server.tools.has(removed), false, `${removed} must not be registered`);
    }
    assert.ok((server.tools.get("yfy_status")!.definition.outputSchema as Record<string, unknown>).places);
    assert.ok(server.tools.get("yfy_inventory_search")!.definition.outputSchema);
    const inventoryInput = server.tools.get("yfy_inventory_search")!.definition.inputSchema as { shape: Record<string, unknown> };
    assert.ok(inventoryInput.shape.request);
    assert.deepEqual(Object.keys(server.tools.get("yfy_inventory_create")!.definition.inputSchema as Record<string, unknown>).sort(), ["limits", "refresh", "root_folder", "workspace"]);
    assert.equal((server.tools.get("yfy_inventory_create")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_inventory_cancel")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_inventory_release")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_capture")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, true);
  } finally {
    await runtime.close();
  }
});

test("optional toolsets preserve mutation, collaboration, admin and transfer capability", async () => {
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "evidence", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    for (const name of ["yfy_folder_create", "yfy_item_mutate", "yfy_file_upload", "yfy_collaboration_mutate", "yfy_admin_department_mutate", "yfy_admin_platform_sync", "yfy_transfer_ticket_get"]) {
      assert.ok(server.tools.has(name), `${name} should be registered`);
    }
    assert.equal((server.tools.get("yfy_item_mutate")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_file_upload")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    for (const [name, tool] of server.tools) assert.ok(tool.definition.outputSchema, `${name} must declare outputSchema`);
  } finally {
    await runtime.close();
  }
});

test("the MCP client compiles every catalog output schema", async () => {
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "evidence", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new RealMcpServer({ name: "schema-test", version: "1.0.0" });
  const client = new Client({ name: "schema-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    registerCatalog(server, runtime);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    assert.ok(listed.tools.every((tool) => tool.outputSchema));
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
  }
});

test("drive tools are absent when the drive toolset is disabled", async () => {
  const runtime = await AppRuntime.create(config(["evidence"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    assert.ok(server.tools.has("yfy_capture"));
    assert.ok(server.tools.has("yfy_resource_release"));
    assert.ok(!server.tools.has("yfy_get"));
    assert.ok(server.tools.has("yfy_status"));
  } finally {
    await runtime.close();
  }
});

test("organization tools can be enabled without the drive toolset", async () => {
  const runtime = await AppRuntime.create(config(["organization"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    assert.ok(server.tools.has("yfy_department_get"));
    assert.ok(server.tools.has("yfy_user_search"));
    assert.ok(server.tools.has("yfy_status"));
    assert.ok(!server.tools.has("yfy_get"));
  } finally {
    await runtime.close();
  }
});
