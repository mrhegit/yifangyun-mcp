import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "./client.js";
import { decodeCanonicalBase64Url } from "./domain/base64url.js";
import { formatItemRef } from "./domain/refs.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { registerWorkspaceContentTools } from "./tools/workspaceContentTools.js";
import { registerDriveTools } from "./tools/driveTools.js";
import { registerInventoryTools } from "./tools/inventoryTools.js";
import { registerTool, serializeError } from "./tools/tooling.js";

const IDENTITY_REF = "a".repeat(24);
const FILE_1 = formatItemRef("file", "1", "default", IDENTITY_REF);
const FILE_10 = formatItemRef("file", "10", "default", IDENTITY_REF);
const WORKSPACE_SCOPE = "workspace:scope";
const WORKSPACE_TENDER = "workspace:tender";
const WORKSPACE_FINGERPRINT = "b".repeat(64);

test("tool errors bypass successful output schema validation", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTool(server, "failing_tool", {
    title: "Failing Tool",
    description: "Returns a structured tool error in text content.",
    inputSchema: {},
    outputSchema: { value: z.string() }
  }, { readOnly: true }, async () => {
    throw new YifangyunError("Expected failure.", { code: "YFY_EXPECTED_FAILURE", phase: "test" });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "failing_tool", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const content = result.content as Array<{ text?: string; type: string }>;
    const text = content.find((entry) => entry.type === "text");
    assert.equal(text?.type, "text");
    assert.equal(JSON.parse(typeof text?.text === "string" ? text.text : "{}").error.code, "YFY_EXPECTED_FAILURE");
  } finally {
    await client.close();
    await server.close();
  }
});

test("evidence integrity and Provider fallback errors use actionable categories", () => {
  assert.equal(serializeError(new YifangyunError("mismatch", { code: "YFY_EVIDENCE_CONTENT_MISMATCH" })).category, "provider_contract");
  assert.equal(serializeError(new YifangyunError("integrity", { code: "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED" })).category, "conflict");
  assert.equal(serializeError(new YifangyunError("fallback", { code: "YFY_DOWNLOAD_VERSION_FALLBACK_DETECTED" })).category, "provider_contract");
});

test("stale snapshot cursors expose a recoverable state category and safe diagnostics", () => {
  const error = serializeError(new YifangyunError("stale", {
    code: "YFY_INVENTORY_CURSOR_STALE",
    agentDetails: { current_revision: 2, cursor_revision: 1, restart_required: true },
    suggestedAction: "Retry without cursor."
  }));
  assert.equal(error.category, "stale_state");
  assert.deepEqual(error.diagnostics, { current_revision: 2, cursor_revision: 1, restart_required: true });
});

test("snapshot query input and capacity errors use recoverable categories", () => {
  assert.equal(serializeError(new YifangyunError("empty", { code: "YFY_INVENTORY_QUERY_EMPTY" })).category, "invalid_input");
  assert.equal(serializeError(new YifangyunError("short", { code: "YFY_INVENTORY_QUERY_TOO_SHORT" })).category, "capacity_limit");
  assert.equal(serializeError(new YifangyunError("broad", { code: "YFY_INVENTORY_QUERY_TOO_BROAD" })).category, "capacity_limit");
});

test("all cursor errors use recoverable categories", () => {
  assert.equal(serializeError(new YifangyunError("cursor", { code: "YFY_CURSOR_INVALID" })).category, "invalid_input");
  assert.equal(serializeError(new YifangyunError("cursor", { code: "YFY_CURSOR_STALE" })).category, "stale_state");
});

test("unavailable Provider files are not misreported as missing", () => {
  const error = serializeError(new YifangyunError("not locked", { code: "YFY_PROVIDER_HTTP_ERROR", details: { api_code: "file_not_locked" } }));
  assert.equal(error.code, "YFY_FILE_UNAVAILABLE");
  assert.equal(error.category, "provider_contract");
});

test("signed values reject non-canonical Base64URL aliases", () => {
  assert.equal(decodeCanonicalBase64Url("Zg").toString("utf8"), "f");
  assert.throws(() => decodeCanonicalBase64Url("Zh"), /canonical Base64URL/);
});

test("large tool results retain useful data and continuation in compact text", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTool(server, "large_result", {
    title: "Large Result",
    description: "Returns enough data to exercise compact text delivery.",
    inputSchema: {},
    outputSchema: { items: z.array(z.object({ id: z.string(), value: z.string(), provider_path_chain: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) })), page: z.record(z.unknown()), next_action: z.record(z.unknown()) }
  }, { readOnly: true }, async () => ({
    items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, value: "x".repeat(1000), provider_path_chain: [{ id: "501", name: "Workspace Root", type: "folder" }, { id: "502", name: "Bid Documents", type: "folder" }] })),
    page: { returned_count: 20, has_more: true, next_cursor: "cursor" },
    next_action: { tool: "large_result", arguments: { cursor: "cursor" } }
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "large_result", arguments: {} });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    const compact = JSON.parse(text) as Record<string, unknown>;
    assert.ok(text.length <= 12_000);
    assert.equal(((compact.text_delivery as Record<string, unknown>).mode), "compact_preview");
    const resultPreview = compact.result_preview as Record<string, unknown>;
    const itemPreview = resultPreview.items as { items: Array<Record<string, unknown>>; omitted_count: number };
    assert.equal(itemPreview.items[0]?.id, "item-0");
    assert.match(JSON.stringify(itemPreview.items[0]?.provider_path_chain), /Workspace Root|501/);
    assert.ok(itemPreview.omitted_count > 0);
    assert.equal(((resultPreview.next_action as Record<string, unknown>).tool), "large_result");
    assert.equal(((result.structuredContent as Record<string, unknown>).items as unknown[]).length, 20);
  } finally {
    await client.close();
    await server.close();
  }
});

test("invalid successful output becomes a tool error and runs rollback", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  let rolledBack = false;
  registerTool(server, "invalid_output", {
    title: "Invalid Output",
    description: "Returns an invalid result for contract testing.",
    inputSchema: {},
    outputSchema: { value: z.string() }
  }, { readOnly: false, onInvalidOutput: async () => { rolledBack = true; } }, async () => ({ value: "ok", unexpected: true }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool({ name: "invalid_output", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(rolledBack, true);
    assert.match(JSON.stringify(result.content), /YFY_TOOL_OUTPUT_INVALID/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("unexpected system errors do not expose local details", () => {
  const error = serializeError(new Error("EPERM unlink C:\\secret\\artifact.bin"));
  assert.equal(error.message, "Unexpected internal error.");
  assert.doesNotMatch(String(error.message), /secret|artifact/);
});

test("the MCP client accepts a running inventory success result", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  let createInput: Record<string, unknown> | undefined;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => ({ context: { id: "default" }, identityRef: IDENTITY_REF, scope: { id: "tender", rootFolderId: "501", tags: [] } }) },
    snapshots: {
      create: async (input: Record<string, unknown>) => { createInput = input; return ({ reused: false, reuseReason: "new", state: {
        accessContextId: "default", accessIdentityRef: IDENTITY_REF, artifactToken: "token", commitWatermark: 0, createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
        fileCount: 0, folderCount: 0, frontierCount: 1, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
        pageReceiptCount: 0, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 },
        policyHash: "hash", receiptDigest: "digest", revision: 0, retryCount: 0, rootFolder: {}, rootFolderId: "501", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174000",
        status: "running", updatedAt: "2026-07-16T00:00:00.000Z", workspaceFingerprint: WORKSPACE_FINGERPRINT, workspaceId: "tender", workspaceRef: WORKSPACE_TENDER
      } }); },
      summary: () => ({ terminal: false, completeness: { pagination_complete: false, safe_to_claim_absence: false, scope: "observed_subset_only", consistency_level: "partial_observation", incomplete_reasons: [] } }),
      storageStats: () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool({ name: "yfy_inventory_create", arguments: { workspace: WORKSPACE_TENDER, refresh: { mode: "reuse_if_fresh", max_age_seconds: 300 }, limits: { max_item_depth: 100, max_items: 100000 } } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as Record<string, unknown>).status, "running");
    assert.equal(createInput?.maxItemDepth, 100);
    assert.equal(createInput?.maxItems, 100_000);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the MCP client validates a paginated success result", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: () => ({ context: { id: "default" }, identityRef: IDENTITY_REF }),
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => ({
        data: { share_links: [{ id: Number(params.page_id ?? 0) + 1 }], page_id: Number(params.page_id ?? 0), page_capacity: 1, page_count: 2, total_count: 2, has_more: false },
        meta: { endpoint, fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool({ name: "yfy_shares", arguments: { request: { mode: "first_request", item: FILE_1, limit: 1 } } });
    assert.equal(result.isError, undefined);
    const page = (result.structuredContent as Record<string, unknown>).page as Record<string, unknown>;
    assert.equal(page.returned_count, 1);
    assert.equal(page.has_more, true);
    assert.equal(typeof page.next_cursor, "string");
    const nextAction = (result.structuredContent as Record<string, unknown>).next_action as { tool: string; arguments: Record<string, unknown> };
    assert.deepEqual(Object.keys(nextAction.arguments), ["request"]);
    const mixed = await client.callTool({ name: nextAction.tool, arguments: { ...nextAction.arguments, limit: 5 } });
    assert.equal(mixed.isError, true);
    const second = await client.callTool({ name: nextAction.tool, arguments: nextAction.arguments });
    assert.equal(second.isError, undefined, JSON.stringify(second.content));
    assert.equal((((second.structuredContent as Record<string, unknown>).shares as Array<Record<string, unknown>>)[0]?.id), "2");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the real MCP client validates current evidence capture and release", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const resourceUri = `yfy://evidence/${"a".repeat(48)}`;
  const runtime = {
    config: { maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, toolsets: ["evidence"], transport: "stdio" },
    access: { resolveWorkspaceRef: () => ({ context: { id: "default", userId: "530" }, identityRef: IDENTITY_REF, scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => ({
      data: endpoint.endsWith("/versions")
        ? { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9, modified_at: 1 }] }
        : endpoint.endsWith("/download_v2") ? { download_url: "https://download.example/file" }
          : { id: 10, name: "evidence.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] },
      meta: { endpoint, fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }
    }) },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/evidence.pdf", sha1: "a".repeat(40), sha256: "b".repeat(64), sizeBytes: 9, meta: { endpoint: "/download", fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 } }) },
    evidence: { register: async () => resourceUri, release: async () => true, read: async () => ({ kind: "blob", blob: "", mimeType: "application/pdf", name: "evidence.pdf" }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const captured = await client.callTool({ name: "yfy_capture", arguments: { workspace: WORKSPACE_SCOPE, file: FILE_10 } });
    assert.equal(captured.isError, undefined, JSON.stringify(captured.content));
    const resource = (captured.structuredContent as Record<string, unknown>).resource as Record<string, unknown>;
    assert.equal(resource.resource_uri, resourceUri);
    assert.equal(resource.local_path, undefined);
    const released = await client.callTool({ name: "yfy_resource_release", arguments: { resource_uri: resourceUri } });
    assert.equal(((released.structuredContent as Record<string, unknown>).status), "released");
  } finally {
    await client.close();
    await server.close();
  }
});
