import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YifangyunError } from "./client.js";
import { provenance } from "./domain/projectors.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { registerAdminTools } from "./tools/adminTools.js";
import { normalizedMediaType, registerWorkspaceContentTools } from "./tools/workspaceContentTools.js";
import { registerDriveTools } from "./tools/driveTools.js";
import { registerMutationTools } from "./tools/mutationTools.js";
import { registerInventoryTools } from "./tools/inventoryTools.js";
import { registerTransferTools } from "./tools/transferTools.js";
import type { ApiJsonResponse, JsonValue } from "./types.js";

type ToolResult = { content?: Array<{ text?: string; type: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<ToolResult>;
class FakeServer {
  readonly tools = new Map<string, Handler>();
  registerTool(name: string, _definition: unknown, handler: Handler): void { this.tools.set(name, handler); }
  registerResource(): void {}
  registerPrompt(): void {}
}

function response(endpoint: string, data: JsonValue): ApiJsonResponse {
  return { data, meta: { endpoint, fetchedAtIso: new Date().toISOString(), fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 } };
}

function access() {
  return { context: { id: "default", userId: "530" }, identityRef: "identity" };
}

function scopedAccess() {
  return { ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } };
}

async function call(server: FakeServer, name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
  const handler = server.tools.get(name)!;
  return handler(args, { signal, sendNotification: async () => undefined });
}

function errorCode(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  return ((JSON.parse(text) as { error?: { code?: string } }).error?.code);
}

function errorCategory(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  return ((JSON.parse(text) as { error?: { category?: string } }).error?.category);
}

test("provenance exposes a logical operation without transport paths", () => {
  const value = provenance({ endpoint: "https://download.example/secret/path?token=value", fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }, "private-context", "content_download");
  assert.deepEqual(value, { source: "yifangyun_openapi", operation: "content_download", observed_at: "2026-07-16T00:00:00.000Z" });
  assert.doesNotMatch(JSON.stringify(value), /download\.example|secret\/path|private-context/);
});

test("legacy Office media types are normalized for MCP clients", () => {
  assert.equal(normalizedMediaType("application/excel", undefined), "application/vnd.ms-excel");
  assert.equal(normalizedMediaType("application/powerpoint; charset=binary", undefined), "application/vnd.ms-powerpoint");
  assert.equal(normalizedMediaType("application/octet-stream", "application/pdf"), "application/pdf");
});

test("drive search hides Provider pagination behind one cursor", async () => {
  const server = new FakeServer();
  const files = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `candidate-${index + 1}.pdf`, type: "file", owned_by: { id: 9, name: "Owner", login: "secret" } }));
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files, folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3 })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_search", { query: "candidate", in: "personal", limit: 2 });
  assert.deepEqual(first.structuredContent?.coverage, { mode: "provider_index", exhaustive: false });
  assert.equal((first.structuredContent?.hits as unknown[]).length, 2);
  const page = first.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.returned_count, 2);
  assert.equal(page.has_more, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(page, "page_id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(page, "page_capacity"));
  const cursor = String(page.next_cursor);
  const second = await call(server, "yfy_search", { cursor });
  assert.deepEqual((second.structuredContent?.hits as Array<Record<string, unknown>>).map((hit) => (hit.item as Record<string, unknown>).ref), ["file:3"]);
  assert.doesNotMatch(JSON.stringify(first.structuredContent), /login|secret/);
  const standard = await call(server, "yfy_search", { query: "candidate", in: "personal", detail: "standard" });
  assert.equal((((standard.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).owned_by as Record<string, unknown>).name, "Owner");
});

test("admin log pagination counts user activity rows", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["admin"] },
    gateway: {
      postEnterprise: async (endpoint: string) => response(endpoint, { user_activities: [{ id: 1 }, { id: 2 }] })
    }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_admin_log_query", { action: "list", start_date: "2026-07-01", end_date: "2026-07-02", page_id: 0, page_capacity: 2 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal((page.returned as Record<string, unknown>).provider_count, 2);
  assert.equal(page.has_more, true);
});

test("drive search enforces folder scope and exact names", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/info") ? response(endpoint, { id: 10, name: "Target", type: "folder", space: { type: "personal" } }) : response(endpoint, {
        files: [
          { id: 1, name: "test.docx", type: "file", parent_folder_id: 10, path: [{ id: 10, name: "Target", type: "folder" }] },
          { id: 2, name: "test-copy.docx", type: "file", parent_folder_id: 10, path: [{ id: 10, name: "Target", type: "folder" }] },
          { id: 3, name: "test.docx", type: "file", parent_folder_id: 20, path: [{ id: 20, name: "Other", type: "folder" }] }
        ],
        folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_search", { query: "test.docx", in: "folder:10", kind: "file", field: "name", exact_name: true, limit: 5 });
  const item = ((result.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>);
  assert.equal(item.ref, "file:1");
  assert.equal(item.path_basis, "provider_supplied");
  assert.equal(item.path_chain, undefined);
  assert.deepEqual((item.provider_path_chain as Array<Record<string, unknown>>).map((entry) => entry.id), ["10"]);
});

test("drive batch reads preserve successes when one Provider request fails", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.includes("/2/")
        ? Promise.reject(new YifangyunError("missing", { code: "YFY_FILE_NOT_FOUND", statusCode: 404 }))
        : response(endpoint, { id: 1, name: "ok.pdf", type: "file" })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_get_many", { refs: ["file:1", "file:2"], detail: "basic" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.summary, { requested_count: 2, success_count: 1, error_count: 1 });
  const results = result.structuredContent?.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.status, "success");
  assert.equal(results[1]?.status, "error");
  assert.equal((results[1]?.error as Record<string, unknown>).category, "not_found");
});

test("current file versions omit historical VersionRef values", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { file_versions: [
        { current: true, sha1: "a".repeat(40), size: 9, modified_at: 2 },
        { id: 7, current: false, sha1: "b".repeat(40), size: 8, modified_at: 1 }
      ] })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_versions", { file: "file:10" });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const versions = result.structuredContent?.versions as Array<Record<string, unknown>>;
  assert.equal(versions[0]?.current, true);
  assert.equal(versions[0]?.ref, undefined);
  assert.equal(versions[1]?.ref, "version:10:7");
});

test("workspace membership distinguishes query and assert semantics", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveScope: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => response(endpoint, { id: 10, name: "outside.pdf", type: "file", parent_folder_id: 2, path: [{ id: 2, name: "Other", type: "folder" }] }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: "file:10", workspace: "tender", mode: "query" });
  assert.equal(query.structuredContent?.in_workspace, false);
  assert.equal(query.structuredContent?.path_basis, "configured_workspace_root");
  assert.deepEqual(query.structuredContent?.workspace_relative_ancestor_chain, []);
  assert.equal((query.structuredContent?.file as Record<string, unknown>).path_basis, "provider_supplied");
  assert.equal(query.isError, undefined);
  const assertion = await call(server, "yfy_membership_check", { file: "file:10", workspace: "tender", mode: "assert" });
  assert.equal(assertion.isError, true);
  assert.equal(errorCode(assertion), "YFY_WORKSPACE_MEMBERSHIP_FAILED");
  assert.equal(errorCategory(assertion), "authorization");
});

test("inventory search returns a signed context-bound cursor", async () => {
  const server = new FakeServer();
  let receivedCursor: unknown;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveScope: () => ({ context: { id: "default" }, scope: { rootFolderId: "501" } }) },
    snapshots: {
      create: async () => ({ reused: false, reuseReason: "new", state: {
        accessContextId: "default", accessIdentityRef: "identity", artifactToken: "token", createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
        fileCount: 1, folderCount: 0, frontierCount: 0, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
        pageReceiptCount: 1, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 },
        policyHash: "hash", receiptDigest: "digest", revision: 4, rootFolder: {}, rootFolderId: "501", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174000",
        status: "complete", updatedAt: "2026-07-16T00:00:00.000Z"
      } }),
      query: async (input: Record<string, unknown>) => {
        receivedCursor = input.cursor;
        return {
          items: [{ id: "10", name: "A", type: "file" }],
          nextCursor: { itemId: "10", revision: 4, sortPath: "Root/A", total: 2 },
          state: { revision: 4, scanId: input.scanId, status: "complete" },
          total: 2
        };
      },
      summary: () => ({ terminal: true, completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: "tender" });
  const inventory = String(created.structuredContent?.inventory);
  const first = await call(server, "yfy_inventory_search", { inventory, query: "证书", kind: "all", limit: 1 });
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);
  assert.ok(cursor.length > 20);
  const second = await call(server, "yfy_inventory_search", { inventory, cursor });
  assert.notEqual(second.isError, true);
  assert.deepEqual(receivedCursor, { itemId: "10", revision: 4, sortPath: "Root/A", total: 2 });
});

test("inventory cancel reports the terminal state won by a concurrent completion", async () => {
  const server = new FakeServer();
  const running = {
    accessContextId: "default", accessIdentityRef: "identity", artifactToken: "token", createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
    fileCount: 0, folderCount: 0, frontierCount: 1, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
    pageReceiptCount: 0, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 },
    policyHash: "hash", receiptDigest: "digest", revision: 1, rootFolder: {}, rootFolderId: "501", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174000",
    status: "running", updatedAt: "2026-07-16T00:00:00.000Z"
  };
  const complete = { ...running, status: "complete", revision: 2 };
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveScope: () => ({ context: { id: "default" }, scope: { rootFolderId: "501" } }) },
    snapshots: {
      create: async () => ({ reused: false, reuseReason: "new", state: running }),
      get: async () => running,
      cancel: async () => complete,
      summary: (state: Record<string, unknown>) => ({ terminal: state.status === "complete", completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: "scope" });
  const inventory = String(created.structuredContent?.inventory);
  const result = await call(server, "yfy_inventory_cancel", { inventory });
  assert.equal((result.structuredContent?.cancellation as Record<string, unknown>).outcome, "already_terminal");
  assert.equal(result.structuredContent?.status, "complete");
});

test("ordinary open does not require workspace ancestry metadata", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "ordinary.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1" })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "ordinary.pdf", tempPath: "C:/temp/ordinary.pdf", sha1: "a".repeat(40), sha256: "b".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"5".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_open", { file: "file:10" });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(((result.structuredContent?.assurance as Record<string, unknown>).checks as Record<string, unknown>).workspace_membership, "not_applicable");
});

test("evidence capture rejects a current file version key for historical content", async () => {
  const server = new FakeServer();
  const runtime = { config: { toolsets: ["evidence"] }, access: { resolveScope: scopedAccess } } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10", version: "version:10:7", expected: { file_version_key: "current-key" } });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_INPUT_INVALID");
});

test("evidence capture validates a historical version with the reverse-ordinal strategy", async () => {
  const server = new FakeServer();
  let requestedVersion: unknown;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveScope: scopedAccess },
    gateway: {
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
          { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
          { id: 7, current: false, sha1: "b".repeat(40), size: 9, modified_at: 1 }
        ] });
        if (endpoint.endsWith("/download_v2")) { requestedVersion = params.version; return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/evidence.pdf", sha1: "b".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"1".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10", version: "version:10:7" });
  assert.notEqual(result.isError, true);
  assert.equal(requestedVersion, 1);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "historical_reverse_ordinal");
  assert.deepEqual((result.structuredContent?.provenance as Array<Record<string, unknown>>).map((entry) => entry.operation), [
    "file_metadata_before", "version_history_before", "download_ticket", "content_download", "version_history_after", "file_metadata_after"
  ]);
});

test("evidence capture falls back to a validated historical version-id strategy", async () => {
  const server = new FakeServer();
  const requestedVersions: unknown[] = [];
  let selectedVersion: unknown;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveScope: scopedAccess },
    gateway: {
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }, { id: 7, current: false, sha1: "b".repeat(40), size: 9 }, { id: 8, current: false, sha1: "e".repeat(40), size: 8 }] });
        if (endpoint.endsWith("/download_v2")) { selectedVersion = params.version; requestedVersions.push(params.version); return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => selectedVersion === "7"
      ? ({ fileName: "evidence.pdf", tempPath: "C:/temp/history.pdf", sha1: "b".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta })
      : ({ fileName: "evidence.pdf", tempPath: "C:/temp/current.pdf", sha1: "a".repeat(40), sha256: "d".repeat(64), sizeBytes: 10, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"2".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10", version: "version:10:7" });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.deepEqual(requestedVersions, [2, 1, "7"]);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "historical_version_id");
});

test("evidence capture returns provider-contract diagnostics when history is unavailable", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveScope: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
        { current: true, sha1: "a".repeat(40), size: 10 },
        { id: 7, current: false, sha1: "b".repeat(40), size: 9 }
      ] });
      if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/current.pdf", sha1: "a".repeat(40), sha256: "d".repeat(64), sizeBytes: 10, meta: response("/download", {}).meta }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10", version: "version:10:7" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_HISTORICAL_CAPTURE_UNAVAILABLE");
  assert.match(JSON.stringify(result.content), /provider_contract|attempts/);
});

test("historical evidence capture preserves authorization errors", async () => {
  const server = new FakeServer();
  let downloadRequests = 0;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveScope: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }, { id: 7, current: false, sha1: "b".repeat(40), size: 9 }] });
      if (endpoint.endsWith("/download_v2")) {
        downloadRequests += 1;
        throw new YifangyunError("forbidden", { code: "YFY_PERMISSION_DENIED", statusCode: 403 });
      }
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10", version: "version:10:7" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_PERMISSION_DENIED");
  assert.equal(downloadRequests, 1);
});

test("current evidence capture rejects disagreement with current file metadata", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveScope: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9 }] });
      if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/metadata-mismatch.pdf", sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => { throw new Error("mismatched evidence must not be registered"); } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EVIDENCE_DRIFT");
  assert.match(JSON.stringify(result.content), /current_metadata_size/);
});

test("capture rolls back content when an expectation does not match", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveScope: scopedAccess },
    gateway: {
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9, modified_at: 1 }] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/evidence.pdf", sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => { throw new Error("mismatched content must not be registered"); } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { file: "file:10", workspace: "scope", expected: { sha256: "d".repeat(64) } });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EXPECTATION_MISMATCH");
  assert.match(JSON.stringify(result.content), /actual|expected|sha256/);
});

test("large captured content returns a multipart resource without a local path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-evidence-large-"));
  const tempPath = path.join(dir, "evidence.bin");
  await fs.writeFile(tempPath, "content");
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1, tempFileTtlSeconds: 60, transport: "http" }, access: { resolveScope: scopedAccess },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/versions")
      ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 7, modified_at: 1 }] })
      : endpoint.endsWith("/download_v2") ? response(endpoint, { download_url: "https://download.example/file" })
        : response(endpoint, { id: 10, name: "evidence.bin", type: "file", size: 7, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] }) },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.xls", tempPath, sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 7, contentType: "application/excel", meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"4".repeat(48)}` }
  } as unknown as AppRuntime;
  try {
    registerWorkspaceContentTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_capture", { workspace: "scope", file: "file:10" });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const resource = result.structuredContent?.resource as Record<string, unknown>;
    assert.equal(resource.delivery, "multipart_resource");
    assert.equal(resource.media_type, "application/vnd.ms-excel");
    assert.match(String(resource.resource_uri), /\/manifest$/);
    const link = result.content?.find((entry) => entry.type === "resource_link") as ({ mimeType?: string } | undefined);
    assert.equal(link?.mimeType, "application/json");
    assert.equal(resource.local_path, undefined);
    assert.equal((await fs.stat(tempPath)).size, 7);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("transfer tickets are current-only and claim metadata-only validation", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["transfer"] }, access: { resolveContext: access },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/versions")
      ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 7 }] })
      : response(endpoint, { download_url: "https://download.example/file" }) }
  } as unknown as AppRuntime;
  registerTransferTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_transfer_ticket_get", { file_id: "10" });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).validation_level, "metadata_only");
});

test("mutation and admin grouped tools build official requests", async () => {
  const server = new FakeServer();
  const calls: Array<{ body: JsonValue; endpoint: string }> = [];
  const runtime = {
    config: { toolsets: ["mutation", "admin"] },
    gateway: {
      context: access,
      postUser: async (endpoint: string, _context: string, body: JsonValue) => { calls.push({ endpoint, body }); return response(endpoint, { id: 9, name: "Folder", type: "folder" }); },
      postEnterprise: async (endpoint: string, body: JsonValue) => { calls.push({ endpoint, body }); return response(endpoint, { id: 8, name: "Group" }); }
    }
  } as unknown as AppRuntime;
  registerMutationTools(server as unknown as McpServer, runtime);
  registerAdminTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_folder_create", { name: "Bid", parent_folder_id: "1" });
  assert.notEqual(created.isError, true);
  const group = await call(server, "yfy_admin_group_mutate", { action: "create", name: "Reviewers" });
  assert.notEqual(group.isError, true);
  assert.equal(calls[0]?.endpoint, "/v2/folder/create");
  assert.equal(calls[1]?.endpoint, "/v2/admin/group/create");
});

test("mutation tools propagate the MCP cancellation signal to Provider calls", async () => {
  const server = new FakeServer();
  let receivedSignal: AbortSignal | undefined;
  const runtime = {
    config: { toolsets: ["mutation"] },
    gateway: {
      context: access,
      postUser: async (_endpoint: string, _context: string, _body: JsonValue, _params: Record<string, unknown>, signal?: AbortSignal) => {
        receivedSignal = signal;
        return response("/v2/folder/create", { id: 9, name: "Folder", type: "folder" });
      }
    }
  } as unknown as AppRuntime;
  registerMutationTools(server as unknown as McpServer, runtime);
  const controller = new AbortController();
  await call(server, "yfy_folder_create", { name: "Bid", parent_folder_id: "1" }, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("local upload requires a configured root and rejects paths outside it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-upload-root-"));
  const server = new FakeServer();
  const uploadRootDir = path.join(dir, "allowed");
  const outsidePath = path.join(dir, "secret.txt");
  await fs.mkdir(uploadRootDir);
  await fs.writeFile(outsidePath, "secret");
  const runtime = {
    config: { toolsets: ["mutation"], uploadRootDir },
    gateway: { context: access }
  } as unknown as AppRuntime;
  try {
    registerMutationTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_file_upload", { local_path: outsidePath, parent_folder_id: "1", overwrite: false });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_UPLOAD_SOURCE_OUT_OF_SCOPE");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("local upload remains bound to the validated file after its path is replaced", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-upload-binding-"));
  const uploadRootDir = path.join(dir, "allowed");
  const sourcePath = path.join(uploadRootDir, "source.txt");
  const replacementPath = path.join(dir, "replacement.txt");
  const displacedPath = path.join(dir, "displaced.txt");
  await fs.mkdir(uploadRootDir);
  await fs.writeFile(sourcePath, "VALIDATED");
  await fs.writeFile(replacementPath, "OUTSIDE_SECRET");
  const server = new FakeServer();
  let uploaded = "";
  const runtime = {
    config: { maxDownloadBytes: 1024, toolsets: ["mutation"], uploadRootDir },
    gateway: {
      context: access,
      postUser: async (endpoint: string) => {
        await fs.rename(sourcePath, displacedPath);
        await fs.copyFile(replacementPath, sourcePath);
        return response(endpoint, { presign_url: "https://upload.example/file" });
      }
    },
    client: {
      uploadLocalFileToPresignedUrl: async (_url: string, source: Awaited<ReturnType<typeof fs.open>>, fileName: string) => {
        const stat = await source.stat();
        const content = Buffer.alloc(stat.size);
        await source.read(content, 0, content.length, 0);
        uploaded = content.toString("utf8");
        return { deliveryMethod: "PUT_BINARY", fileName, remoteStatusCode: 200, sizeBytes: stat.size };
      }
    }
  } as unknown as AppRuntime;
  try {
    registerMutationTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_file_upload", { local_path: sourcePath, parent_folder_id: "1", overwrite: false });
    assert.notEqual(result.isError, true);
    assert.equal(uploaded, "VALIDATED");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
