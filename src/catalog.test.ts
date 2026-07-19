import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as RealMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./types.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";
import { CONTRACT_VERSION, CURSOR_ENVELOPE_VERSION, INVENTORY_CURSOR_VERSION, INVENTORY_REF_VERSION, SERVER_VERSION, SNAPSHOT_SCHEMA_VERSION, WORKSPACE_FINGERPRINT_VERSION } from "./version.js";

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;

class FakeServer {
  readonly tools = new Map<string, { definition: Record<string, unknown>; handler: Handler }>();
  registerTool(name: string, definition: Record<string, unknown>, handler: Handler): void {
    this.tools.set(name, { definition, handler });
  }
  registerResource(): void {}
  registerPrompt(): void {}
}

function schemaVariants(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const variants = (schema.anyOf ?? schema.oneOf) as Array<Record<string, unknown>> | undefined;
  return variants ?? [schema];
}

function schemaPropertyNames(schema: Record<string, unknown>): string[] {
  return [...new Set(schemaVariants(schema).flatMap((variant) => Object.keys((variant.properties as Record<string, unknown> | undefined) ?? {})))].sort();
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
    downloadExposeLocalPath: true,
    downloadStagedHttpEnabled: false,
    downloadStagedMaxFetches: 10,
    logLevel: "info",
    maxDownloadBytes: 1024,
    maxPageCapacity: 500,
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 1,
    retryMaxAttempts: 1,
    stateDatabasePath: ":memory:",
    tempDir: path.join(os.tmpdir(), `yfy-catalog-${crypto.randomUUID()}`),
    tempFileTtlSeconds: 1,
    tokenRefreshSkewSeconds: 30,
    toolsets,
    transport: "stdio",
    workflowProfiles: ["tender"]
  };
}

test("the breaking download contract advances only the public contract version", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, "1.1.0-beta.3");
  assert.equal(packageJson.version, SERVER_VERSION);
  assert.deepEqual([
    CONTRACT_VERSION,
    CURSOR_ENVELOPE_VERSION,
    INVENTORY_CURSOR_VERSION,
    INVENTORY_REF_VERSION,
    SNAPSHOT_SCHEMA_VERSION,
    WORKSPACE_FINGERPRINT_VERSION
  ], [3, 1, 1, 1, 1, 1]);
});

test("default catalog exposes the current tools and schemas", async () => {
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "organization"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    const expected = [
      "yfy_browse", "yfy_comments", "yfy_department_children", "yfy_department_get", "yfy_department_users",
      "yfy_download", "yfy_download_batch", "yfy_download_release", "yfy_get", "yfy_get_many", "yfy_group_list", "yfy_group_users",
      "yfy_inventory_cancel", "yfy_inventory_create", "yfy_inventory_get", "yfy_inventory_release", "yfy_inventory_search",
      "yfy_membership_check", "yfy_resolve", "yfy_search", "yfy_shares", "yfy_status", "yfy_user_search", "yfy_versions",
      "yfy_workspace_validate"
    ];
    assert.deepEqual([...server.tools.keys()].sort(), expected);
    assert.ok((server.tools.get("yfy_status")!.definition.outputSchema as Record<string, unknown>).places);
    assert.ok(server.tools.get("yfy_inventory_search")!.definition.outputSchema);
    const inventoryInput = server.tools.get("yfy_inventory_search")!.definition.inputSchema as z.ZodObject<z.ZodRawShape>;
    assert.deepEqual(Object.keys(inventoryInput.shape).sort(), ["case_sensitive", "cursor", "inventory", "kind", "limit", "match_fields", "query"]);
    const createInput = server.tools.get("yfy_inventory_create")!.definition.inputSchema as z.ZodObject<z.ZodRawShape>;
    assert.deepEqual(Object.keys(createInput.shape).sort(), ["limits", "refresh", "root_folder", "workspace"]);
    assert.equal((server.tools.get("yfy_inventory_create")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_inventory_cancel")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_inventory_release")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_download")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_download_batch")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    assert.equal((server.tools.get("yfy_status")!.definition.annotations as { openWorldHint: boolean }).openWorldHint, true);
    assert.equal((server.tools.get("yfy_download_release")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_download_release")!.definition.annotations as { openWorldHint: boolean }).openWorldHint, false);
  } finally {
    await runtime.close();
  }
});

test("optional toolsets preserve mutation, collaboration, admin and transfer capability", async () => {
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    for (const name of ["yfy_folder_create", "yfy_item_mutate", "yfy_file_upload", "yfy_collaboration_mutate", "yfy_admin_department_mutate", "yfy_admin_platform_sync", "yfy_transfer_ticket_get"]) {
      assert.ok(server.tools.has(name), `${name} should be registered`);
    }
    assert.equal((server.tools.get("yfy_item_mutate")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_file_upload")!.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
    assert.equal((server.tools.get("yfy_admin_user_read")!.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, false);
    for (const [name, tool] of server.tools) assert.ok(tool.definition.outputSchema, `${name} must declare outputSchema`);
  } finally {
    await runtime.close();
  }
});

test("the MCP client compiles every catalog output schema", async () => {
  const runtime = await AppRuntime.create(config(["drive", "workspace", "inventory", "organization", "mutation", "collaboration", "admin", "transfer"]));
  const server = new RealMcpServer({ name: "schema-test", version: "1.1.0-beta.3" });
  const client = new Client({ name: "schema-client", version: "1.1.0-beta.3" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    registerCatalog(server, runtime);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0);
    assert.ok(listed.tools.every((tool) => tool.outputSchema));
    for (const tool of listed.tools) {
      assert.ok(schemaVariants(tool.inputSchema as Record<string, unknown>).every((variant) => variant.additionalProperties === false), `${tool.name} input branches must be strict`);
      if (tool.name === "yfy_status") continue;
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(schemaPropertyNames(tool.inputSchema as Record<string, unknown>).length > 0, `${tool.name} must expose discoverable input properties`);
    }
    const search = listed.tools.find((tool) => tool.name === "yfy_search")!;
    assert.deepEqual(schemaPropertyNames(search.inputSchema as Record<string, unknown>), ["access_context", "cursor", "detail", "direction", "exact_name", "field", "in", "include_unverified_index_hits", "kind", "limit", "query", "sort"]);
    const searchVariants = schemaVariants(search.inputSchema as Record<string, unknown>);
    assert.ok(searchVariants.some((variant) => (variant.required as string[] | undefined)?.includes("query")));
    assert.ok(searchVariants.some((variant) => (variant.required as string[] | undefined)?.includes("cursor")));
    const exactNameVariants = searchVariants.filter((variant) => Object.prototype.hasOwnProperty.call((variant.properties as Record<string, unknown> | undefined) ?? {}, "exact_name"));
    assert.equal(exactNameVariants.length, 1);
    const exactField = ((exactNameVariants[0]!.properties as Record<string, Record<string, unknown>>).field);
    assert.deepEqual(exactField.enum ?? [exactField.const], ["name"]);
    const nonNameVariant = searchVariants.find((variant) => (variant.required as string[] | undefined)?.includes("query") && !Object.prototype.hasOwnProperty.call((variant.properties as Record<string, unknown> | undefined) ?? {}, "exact_name"))!;
    assert.deepEqual(((nonNameVariant.properties as Record<string, Record<string, unknown>>).field).enum, ["content", "creator", "tag", "all"]);
    const inventory = listed.tools.find((tool) => tool.name === "yfy_inventory_search")!;
    assert.deepEqual(schemaPropertyNames(inventory.inputSchema as Record<string, unknown>), ["case_sensitive", "cursor", "inventory", "kind", "limit", "match_fields", "query"]);
    const admin = listed.tools.find((tool) => tool.name === "yfy_admin_department_read")!;
    assert.deepEqual(schemaPropertyNames(admin.inputSchema as Record<string, unknown>), ["action", "cursor", "department_id", "include_contact", "limit", "operator_id"]);
    assert.ok(schemaVariants(admin.inputSchema as Record<string, unknown>).every((variant) => (variant.required as string[] | undefined)?.includes("action")));
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
  }
});

test("drive tools are absent when the drive toolset is disabled", async () => {
  const runtime = await AppRuntime.create(config(["workspace"]));
  const server = new FakeServer();
  try {
    registerCatalog(server as unknown as McpServer, runtime);
    assert.ok(!server.tools.has("yfy_download"));
    assert.ok(!server.tools.has("yfy_get"));
    assert.ok(server.tools.has("yfy_status"));
  } finally {
    await runtime.close();
  }
});

test("status enables only workflows whose complete tool chain is registered", async () => {
  const cases: Array<{ enabled: string[]; toolsets: AppConfig["toolsets"] }> = [
    { toolsets: ["workspace"], enabled: [] },
    { toolsets: ["drive"], enabled: ["download_for_host_parsing", "batch_zip_download"] },
    { toolsets: ["drive", "workspace"], enabled: ["download_for_host_parsing", "workspace_download", "batch_zip_download"] },
    { toolsets: ["inventory"], enabled: [] },
    { toolsets: ["workspace", "inventory"], enabled: ["absence_audit"] }
  ];
  for (const item of cases) {
    const appConfig = config(item.toolsets);
    const runtime = {
      access: {
        listScopes: () => appConfig.authorityScopes,
        resolveWorkspaceRef: () => { throw new Error("not called"); },
        workspaceRef: (id: string) => `workspace:${id}`
      },
      client: { getEnterpriseToken: async () => { throw new Error("offline"); } },
      config: appConfig,
      configFingerprint: "a".repeat(64),
      gateway: { context: () => ({ context: { id: "default", userId: "530" }, identityRef: "a".repeat(24) }) },
      instanceId: "test-instance",
      startedAtIso: "2026-07-18T00:00:00.000Z",
      tempStorage: { usage: () => ({ max_bytes: 1024, reserved_bytes: 0, used_bytes: 0 }) }
    } as unknown as AppRuntime;
    const server = new FakeServer();
    registerCatalog(server as unknown as McpServer, runtime);
    const result = await server.tools.get("yfy_status")!.handler({}, { signal: new AbortController().signal, sendNotification: async () => undefined });
    const serverIdentity = result.structuredContent?.server as Record<string, unknown>;
    assert.equal(serverIdentity.version, SERVER_VERSION);
    assert.equal(serverIdentity.contract_version, CONTRACT_VERSION);
    const workflows = result.structuredContent?.recommended_workflows as Array<Record<string, unknown>>;
    assert.deepEqual(workflows.filter((workflow) => workflow.enabled === true).map((workflow) => workflow.id), item.enabled);
    const delivery = result.structuredContent?.download_delivery as Record<string, unknown>;
    assert.equal(delivery.transport, "stdio");
    assert.equal(delivery.local_path, true);
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
