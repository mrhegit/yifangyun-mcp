import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "./client.js";
import { decodeCanonicalBase64Url } from "./domain/base64url.js";
import { decodeCursor, encodeCursor } from "./domain/cursors.js";
import { formatItemRef } from "./domain/refs.js";
import { DownloadRegistry } from "./runtime/downloads.js";
import { TempStorageManager } from "./runtime/tempStorage.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { registerDownloadTools } from "./tools/downloadTools.js";
import { registerDriveTools } from "./tools/driveTools.js";
import { registerInventoryTools } from "./tools/inventoryTools.js";
import { serializeToolText } from "./tools/resultDelivery.js";
import { registerTool, serializeError } from "./tools/tooling.js";

const IDENTITY_REF = "a".repeat(24);
const FILE_1 = formatItemRef("file", "1", "default", IDENTITY_REF);
const FILE_10 = formatItemRef("file", "10", "default", IDENTITY_REF);
const WORKSPACE_SCOPE = "workspace:scope";
const WORKSPACE_TENDER = "workspace:tender";
const WORKSPACE_FINGERPRINT = "b".repeat(64);

test("ordinary cursor errors expose only the stable reason enum", () => {
  const schema = z.object({ offset: z.number().int() }).strict();
  const expectReason = (value: string, reason: string) => {
    assert.throws(() => decodeCursor("secret", WORKSPACE_FINGERPRINT, "test", value, schema), (error: unknown) => {
      return error instanceof YifangyunError && error.message === "Cursor is invalid or expired." && error.agentDetails?.reason === reason;
    });
  };
  expectReason("%%%", "not_base64url");
  expectReason(Buffer.from("{}", "utf8").toString("base64url"), "envelope_invalid");
  const valid = encodeCursor("secret", WORKSPACE_FINGERPRINT, "test", { offset: 1 });
  const legacyVersion = JSON.parse(decodeCanonicalBase64Url(valid).toString("utf8")) as Record<string, unknown>;
  legacyVersion.version = 2;
  expectReason(Buffer.from(JSON.stringify(legacyVersion), "utf8").toString("base64url"), "envelope_invalid");
  const signatureInvalid = JSON.parse(decodeCanonicalBase64Url(valid).toString("utf8")) as Record<string, unknown>;
  signatureInvalid.signature = "0".repeat(64);
  expectReason(Buffer.from(JSON.stringify(signatureInvalid), "utf8").toString("base64url"), "signature_invalid");
  expectReason(encodeCursor("secret", WORKSPACE_FINGERPRINT, "test", { offset: "bad" }), "payload_invalid");
});

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

test("download integrity, delivery configuration and Provider errors use actionable categories", () => {
  assert.equal(serializeError(new YifangyunError("mismatch", { code: "YFY_DOWNLOAD_CONTENT_MISMATCH" })).category, "provider_contract");
  assert.equal(serializeError(new YifangyunError("integrity", { code: "YFY_DOWNLOAD_INTEGRITY_FAILED" })).category, "conflict");
  assert.equal(serializeError(new YifangyunError("delivery", { code: "YFY_DOWNLOAD_DELIVERY_CHANNEL_UNAVAILABLE" })).category, "configuration");
  assert.equal(serializeError(new YifangyunError("ticket", { code: "YFY_DOWNLOAD_TICKET_INVALID" })).category, "provider_contract");
  assert.equal(serializeError(new YifangyunError("stream", { code: "YFY_DOWNLOAD_STREAM_FAILED", retryable: true })).category, "provider_unavailable");
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
  }, { readOnly: true }, async () => {
    const longCursor = `cursor-${"x".repeat(800)}`;
    return {
      items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, value: "x".repeat(1000), provider_path_chain: [{ id: "501", name: "Workspace Root", type: "folder" }, { id: "502", name: "Bid Documents", type: "folder" }] })),
      page: { returned_count: 20, has_more: true, next_cursor: longCursor },
      next_action: { tool: "large_result", arguments: { cursor: longCursor } }
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "large_result", arguments: {} });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    assert.ok(text.length <= 12_000);
    const compact = JSON.parse(text) as Record<string, unknown>;
    const delivery = compact.text_delivery as Record<string, unknown>;
    assert.ok(["compact_preview", "control_only"].includes(String(delivery.mode)));
    assert.equal(delivery.continuation_ready, true);
    const control = compact.control as Record<string, unknown>;
    assert.equal(((control.next_action as Record<string, unknown>).tool), "large_result");
    const page = control.page as Record<string, unknown>;
    assert.ok(String(page.next_cursor).length > 800);
    assert.ok(!String(page.next_cursor).includes("characters omitted"));
    if (compact.result_preview) {
      const resultPreview = compact.result_preview as Record<string, unknown>;
      const itemPreview = resultPreview.items as { items: Array<Record<string, unknown>>; omitted_count: number };
      assert.equal(itemPreview.items[0]?.id, "item-0");
      assert.ok(itemPreview.omitted_count > 0);
    }
    assert.equal(((result.structuredContent as Record<string, unknown>).items as unknown[]).length, 20);
  } finally {
    await client.close();
    await server.close();
  }
});

test("compact text keeps download anchors without copying preview body text", () => {
  const body = "sensitive-body-".repeat(4000);
  const text = serializeToolText("yfy_download", {
    status: "ready",
    agent_hint: "Open local_path",
    cleanup: { mode: "ttl", ttl_seconds: 60, release_tool: "yfy_download_release", release_args: { download_id: `dl_${"a".repeat(32)}` } },
    download: {
      download_id: `dl_${"a".repeat(32)}`,
      local_path: "C:/temp/bid.txt",
      fetch_url: null,
      media_type: "text/plain",
      sha256: "b".repeat(64),
      sha1: "a".repeat(40),
      size_bytes: body.length,
      expires_at: "2026-07-19T00:00:00.000Z"
    },
    preview: { kind: "utf8_text", complete: true, charset: "utf-8", bytes: body.length, text: body }
  }, 12_000);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const control = parsed.control as Record<string, unknown>;
  const download = control.download as Record<string, unknown>;
  assert.ok(text.length <= 12_000);
  assert.equal(download.download_id, `dl_${"a".repeat(32)}`);
  assert.equal(download.local_path, "C:/temp/bid.txt");
  assert.doesNotMatch(text, /sensitive-body/);
});

test("text redaction removes nested transfer URLs", () => {
  const text = serializeToolText("transfer", {
    do_not_echo_url: true,
    download_url: "https://download.example/root?token=secret",
    nested: { download_url: "https://download.example/nested?token=secret" }
  });
  assert.doesNotMatch(text, /download\.example|token=secret/);
  assert.equal((JSON.parse(text) as Record<string, unknown>).download_url, "***redacted***");
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
        status: "running", updatedAt: "2026-07-16T00:00:00.000Z", workspaceFingerprint: String(input.workspaceFingerprint), workspaceId: "tender", workspaceRef: WORKSPACE_TENDER, workspaceRootFolderId: "501"
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
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.status, "running");
    assert.equal(structured.suggested_wait_ms, 750);
    assert.equal((structured.agent_guidance as Record<string, unknown>).may_claim_absence, false);
    assert.equal((structured.scan_root as Record<string, unknown>).id, "501");
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
    const result = await client.callTool({ name: "yfy_shares", arguments: { item: FILE_1, limit: 1 } });
    assert.equal(result.isError, undefined);
    const page = (result.structuredContent as Record<string, unknown>).page as Record<string, unknown>;
    assert.equal(page.returned_count, 1);
    assert.equal(page.has_more, true);
    assert.equal(typeof page.next_cursor, "string");
    const nextAction = (result.structuredContent as Record<string, unknown>).next_action as { tool: string; arguments: Record<string, unknown> };
    assert.deepEqual(Object.keys(nextAction.arguments), ["cursor"]);
    const mixed = await client.callTool({ name: nextAction.tool, arguments: { ...nextAction.arguments, limit: 5 } });
    assert.equal(mixed.isError, true);
    const mixedContent = mixed.content as Array<{ text?: string; type: string }>;
    const mixedError = JSON.parse(mixedContent.find((entry) => entry.type === "text")?.text ?? "{}") as {
      error?: { diagnostics?: Record<string, unknown>; suggested_action?: string };
    };
    assert.equal(mixedError.error?.diagnostics?.reason, "pagination_mixed_args");
    assert.deepEqual(mixedError.error?.diagnostics?.unexpected_keys, ["limit"]);
    assert.match(mixedError.error?.suggested_action ?? "", /fixed fields returned by next_action/);
    const second = await client.callTool({ name: nextAction.tool, arguments: nextAction.arguments });
    assert.equal(second.isError, undefined, JSON.stringify(second.content));
    assert.equal((((second.structuredContent as Record<string, unknown>).shares as Array<Record<string, unknown>>)[0]?.id), "2");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the real MCP client validates yfy_download path and release", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-tooling-dl-"));
  const source = path.join(dir, "report.pdf");
  const body = "pdf-body!";
  await fs.writeFile(source, body);
  const sha1 = crypto.createHash("sha1").update(body).digest("hex");
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const tempStorage = new TempStorageManager(dir, 1_048_576, 60);
  const downloads = new DownloadRegistry(tempStorage, 60);
  const server = new McpServer({ name: "test-server", version: "1.1.0-beta.1" });
  const runtime = {
    config: { tempFileTtlSeconds: 60, toolsets: ["drive"], transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false },
    access: { resolveWorkspaceRef: () => ({ context: { id: "default", userId: "530" }, identityRef: IDENTITY_REF, scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: {
      context: () => ({ context: { id: "default", userId: "530" }, identityRef: IDENTITY_REF }),
      getUser: async (endpoint: string) => ({
        data: endpoint.endsWith("/versions")
          ? { file_versions: [{ current: true, sha1, size: Buffer.byteLength(body), modified_at: 1 }] }
          : endpoint.endsWith("/download_v2") ? { download_url: "https://download.example/file" }
            : { id: 10, name: "report.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] },
        meta: { endpoint, fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }
      })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "document.pdf", tempPath: source, sha1, sha256, sizeBytes: Buffer.byteLength(body), meta: { endpoint: "/download", fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 } }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  registerDownloadTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const captured = await client.callTool({ name: "yfy_download", arguments: { workspace: WORKSPACE_SCOPE, file: FILE_10 } });
    assert.equal(captured.isError, undefined, JSON.stringify(captured.content));
    const download = (captured.structuredContent as Record<string, unknown>).download as Record<string, unknown>;
    assert.equal(typeof download.local_path, "string");
    assert.equal(download.fetch_url, null);
    assert.match(String(download.download_id), /^dl_[a-f0-9]{32}$/);
    const released = await client.callTool({ name: "yfy_download_release", arguments: { download_id: download.download_id } });
    assert.equal(((released.structuredContent as Record<string, unknown>).status), "released");
  } finally {
    await client.close();
    await server.close();
    await downloads.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the real MCP client returns text preview for yfy_download", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-tooling-txt-"));
  const body = "verified text";
  const source = path.join(dir, "notes.txt");
  await fs.writeFile(source, body);
  const sha1 = crypto.createHash("sha1").update(body).digest("hex");
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const tempStorage = new TempStorageManager(dir, 1_048_576, 60);
  const downloads = new DownloadRegistry(tempStorage, 60);
  const server = new McpServer({ name: "test-server", version: "1.1.0-beta.1" });
  const runtime = {
    config: { tempFileTtlSeconds: 60, toolsets: ["drive"], transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false, textPreviewMaxBytes: 32768 },
    gateway: {
      context: () => ({ context: { id: "default", userId: "530" }, identityRef: IDENTITY_REF }),
      getUser: async (endpoint: string) => ({
        data: endpoint.endsWith("/versions")
          ? { file_versions: [{ current: true, sha1, size: body.length, modified_at: 1 }] }
          : endpoint.endsWith("/download_v2") ? { download_url: "https://download.example/file" }
            : { id: 10, name: "notes.txt", type: "file", size: body.length, modified_at: 1, file_version_key: "v1" },
        meta: { endpoint, fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }
      })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "notes.txt", tempPath: source, sha1, sha256, sizeBytes: body.length, contentType: "text/plain", meta: { endpoint: "/download", fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 } }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  registerDownloadTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({ name: "yfy_download", arguments: { file: FILE_10, include_text_preview: true } });
    assert.equal(opened.isError, undefined, JSON.stringify(opened.content));
    const preview = (opened.structuredContent as Record<string, unknown>).preview as Record<string, unknown>;
    assert.equal(preview.text, body);
    const download = (opened.structuredContent as Record<string, unknown>).download as Record<string, unknown>;
    assert.equal(typeof download.local_path, "string");
  } finally {
    await client.close();
    await server.close();
    await downloads.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
