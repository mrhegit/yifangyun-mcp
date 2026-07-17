import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YifangyunError } from "./client.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { registerAdminTools } from "./tools/adminTools.js";
import { registerAuthorityEvidenceTools } from "./tools/authorityEvidenceTools.js";
import { registerCoreTools, registerOrganizationTools } from "./tools/coreTools.js";
import { registerMutationTools } from "./tools/mutationTools.js";
import { registerSnapshotTools } from "./tools/snapshotTools.js";
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

test("item search returns stable projection and hint-only authority", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files: [{ id: 1, name: "证书.pdf", type: "file", owned_by: { id: 9, name: "Owner", login: "secret" } }], folders: [], page_id: 0, page_count: 1, total_count: 1 })
    },
    access: { listContexts: () => [], listScopes: () => [] }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_item_search", { query: "证书", item_type: "all", field: "all", root: { kind: "personal" }, precise: false, sort: "score", direction: "desc", page_id: 0, page_capacity: 50 });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent?.authority as Record<string, unknown>).level, "hint_only");
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal((page.requested as Record<string, unknown>).page_capacity, 50);
  const candidate = (result.structuredContent?.candidates as Array<Record<string, unknown>>)[0];
  assert.equal((candidate.item as Record<string, unknown>).name, "证书.pdf");
  assert.ok(!Object.prototype.hasOwnProperty.call(candidate.item as object, "owned_by"));
});

test("paginated tools return one consistent page contract", async () => {
  const server = new FakeServer();
  let mode: "provider" | "fallback" = "provider";
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core", "organization"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => mode === "provider"
        ? response(endpoint, { share_links: [{ id: 1 }], page_id: 0, page_capacity: 2, page_count: 2, total_count: 3, has_more: false })
        : response(endpoint, { users: [{ id: 1, name: "User" }] })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  registerOrganizationTools(server as unknown as McpServer, runtime);
  const shares = await call(server, "yfy_share_list", { item_type: "file", item_id: "1", page_id: 0, page_capacity: 2 });
  const sharePage = shares.structuredContent?.page as Record<string, unknown>;
  assert.equal((sharePage.effective as Record<string, unknown>).page_capacity, 2);
  assert.equal(sharePage.has_more, true);
  assert.equal(sharePage.next_page_id, 1);
  mode = "fallback";
  const users = await call(server, "yfy_user_search", { page_id: 3, page_capacity: 25, include_contact: false });
  const userPage = users.structuredContent?.page as Record<string, unknown>;
  assert.equal((userPage.requested as Record<string, unknown>).page_id, 3);
  assert.equal(userPage.has_more, false);
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

test("pagination ignores impossible Provider counts and continues conservatively", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { share_links: [{ id: 1 }], page_id: 0, page_capacity: 1, page_count: 0, total_count: 0, has_more: false })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_share_list", { item_type: "file", item_id: "1", page_id: 0, page_capacity: 1 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.continuation_basis, "inconsistent");
  assert.equal(page.metadata_consistent, false);
  assert.equal(page.has_more, true);
});

test("pagination terminates on an empty page beyond the Provider range", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files: [], folders: [], page_id: 2, page_capacity: 5, page_count: 2, total_count: 9 })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_folder_list", { folder_id: "0", item_type: "all", view: "summary", page_id: 2, page_capacity: 5 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal((page.effective as Record<string, unknown>).page_id, 2);
  assert.equal(page.has_more, false);
  assert.equal(page.metadata_consistent, true);
});

test("pagination continues through an empty page when Provider counts show remaining items", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files: [], folders: [], page_id: 1, page_capacity: 5, page_count: 3, total_count: 12 })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_folder_list", { folder_id: "0", item_type: "all", view: "summary", page_id: 1, page_capacity: 5 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.continuation_basis, "page_count");
  assert.equal(page.has_more, true);
  assert.equal(page.next_page_id, 2);
});

test("item search reports the Provider capacity when it overrides the request", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files: [], folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 0 })
    },
    access: { listContexts: () => [], listScopes: () => [] }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_item_search", { query: "证书", item_type: "all", field: "all", root: { kind: "personal" }, precise: false, sort: "score", direction: "desc", page_id: 0, page_capacity: 5 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal((page.requested as Record<string, unknown>).page_capacity, 5);
  assert.equal((page.effective as Record<string, unknown>).page_capacity, 100);
});

test("item search bounds Agent context independently from Provider page capacity", async () => {
  const server = new FakeServer();
  const files = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `candidate-${index + 1}.pdf`, type: "file" }));
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: { context: access, getUser: async (endpoint: string) => response(endpoint, { files, folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 6 }) },
    access: { listContexts: () => [], listScopes: () => [] }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_item_search", { query: "candidate", root: { kind: "personal" }, max_results: 2, page_id: 0, page_capacity: 5 });
  assert.equal((result.structuredContent?.candidates as unknown[]).length, 2);
  assert.deepEqual(result.structuredContent?.candidate_summary, { eligible_count: 6, returned_count: 2, result_offset: 0, truncated: true, truncated_count: 4, next_request: { page_id: 0, result_offset: 2 } });
  assert.equal(((result.structuredContent?.page as Record<string, unknown>).returned as Record<string, unknown>).truncated_count, 4);
  const continued = await call(server, "yfy_item_search", { query: "candidate", root: { kind: "personal" }, max_results: 2, result_offset: 2, page_id: 0, page_capacity: 5 });
  assert.deepEqual((continued.structuredContent?.candidates as Array<Record<string, unknown>>).map((candidate) => (candidate.item as Record<string, unknown>).id), ["3", "4"]);
  assert.deepEqual(continued.structuredContent?.candidate_summary, { eligible_count: 6, returned_count: 2, result_offset: 2, truncated: true, truncated_count: 2, next_request: { page_id: 0, result_offset: 4 } });
});

test("item search enforces folder scope and precise file names after Provider search", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
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
    },
    access: { listContexts: () => [], listScopes: () => [] }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_item_search", { query: "test.docx", item_type: "file", field: "file_name", root: { kind: "folder", folder_id: "10" }, precise: true, sort: "score", direction: "desc", page_id: 0, page_capacity: 5 });
  assert.deepEqual((result.structuredContent?.candidates as Array<Record<string, unknown>>).map((candidate) => (candidate.item as Record<string, unknown>).id), ["1"]);
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal((page.returned as Record<string, unknown>).filtered_count, 2);
  assert.equal(page.has_more, false);
});

test("batch item reads preserve successes when one Provider request fails", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.includes("/2/")
        ? Promise.reject(new YifangyunError("missing", { code: "YFY_FILE_NOT_FOUND", statusCode: 404 }))
        : response(endpoint, { id: 1, name: "ok.pdf", type: "file" })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_items_get", { file_ids: ["1", "2"], view: "summary" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.summary, { requested_count: 2, success_count: 1, error_count: 1 });
  const results = result.structuredContent?.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.status, "success");
  assert.equal(results[1]?.status, "error");
  assert.equal((results[1]?.error as Record<string, unknown>).category, "not_found");
});

test("scope check distinguishes query and assert semantics", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["authority"] },
    access: { resolveScope: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => response(endpoint, { id: 10, name: "outside.pdf", type: "file", parent_folder_id: 2, path: [{ id: 2, name: "Other", type: "folder" }] }) }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_scope_check", { file_id: "10", scope_id: "tender", mode: "query" });
  assert.equal(query.structuredContent?.in_scope, false);
  assert.equal(query.isError, undefined);
  const assertion = await call(server, "yfy_scope_check", { file_id: "10", scope_id: "tender", mode: "assert" });
  assert.equal(assertion.isError, true);
  assert.equal(errorCode(assertion), "YFY_SCOPE_ASSERTION_FAILED");
});

test("snapshot query returns a signed context-bound cursor", async () => {
  const server = new FakeServer();
  let receivedCursor: unknown;
  const runtime = {
    config: { clientSecret: "secret", toolsets: ["snapshot"] },
    snapshots: {
      query: async (input: Record<string, unknown>) => {
        receivedCursor = input.cursor;
        return {
          items: [{ id: "10", name: "A", type: "file" }],
          nextCursor: { itemId: "10", revision: 4, sortPath: "Root/A", total: 2 },
          state: { revision: 4, scanId: input.scanId, status: "complete" },
          total: 2
        };
      },
      summary: () => ({ completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } })
    }
  } as unknown as AppRuntime;
  registerSnapshotTools(server as unknown as McpServer, runtime);
  const snapshotId = "123e4567-e89b-12d3-a456-426614174000";
  const first = await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "search", queries: ["证书"], item_type: "all", limit: 1 });
  const cursor = String(first.structuredContent?.next_cursor);
  assert.ok(cursor.length > 20);
  const second = await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "search", queries: ["证书"], item_type: "all", cursor, limit: 1 });
  assert.notEqual(second.isError, true);
  assert.deepEqual(receivedCursor, { itemId: "10", revision: 4, sortPath: "Root/A", total: 2 });
  const wrongQuery = await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "search", queries: ["合同"], item_type: "all", cursor, limit: 1 });
  assert.equal(wrongQuery.isError, true);
  assert.equal(errorCode(wrongQuery), "YFY_SNAPSHOT_CURSOR_INVALID");
  const listed = await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "list", queries: ["ignored"], item_type: "all", limit: 1 });
  const listCursor = String(listed.structuredContent?.next_cursor);
  const continuedList = await call(server, "yfy_snapshot_query", { snapshot_id: snapshotId, mode: "list", item_type: "all", cursor: listCursor, limit: 1 });
  assert.notEqual(continuedList.isError, true);
});

test("evidence capture rejects a current file version key for historical content", async () => {
  const server = new FakeServer();
  const runtime = { config: { toolsets: ["evidence"] }, access: { resolveScope: scopedAccess } } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10", version: { kind: "historical", version_id: "7" }, expected: { file_version_key: "current-key" } });
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
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10", version: { kind: "historical", version_id: "7" } });
  assert.notEqual(result.isError, true);
  assert.equal(requestedVersion, 1);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "historical_reverse_ordinal");
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
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10", version: { kind: "historical", version_id: "7" } });
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
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10", version: { kind: "historical", version_id: "7" } });
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
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10", version: { kind: "historical", version_id: "7" } });
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
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EVIDENCE_DRIFT");
  assert.match(JSON.stringify(result.content), /current_metadata_size_matches/);
});

test("current evidence capture returns one authority-bound artifact and expectation result", async () => {
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
    evidence: { register: () => `yfy://evidence/${"3".repeat(48)}` }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { file_id: "10", scope_id: "scope", expected: { sha256: "d".repeat(64) } });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "current_ordinal");
  assert.equal((result.structuredContent?.artifact as Record<string, unknown>).local_path, undefined);
  assert.equal((result.structuredContent?.artifact as Record<string, unknown>).delivery, "mcp_resource");
  assert.equal(((result.structuredContent?.expectation as Record<string, unknown>).matches), false);
});

test("HTTP evidence deletes validated files that exceed the resource limit", async () => {
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
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.bin", tempPath, sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 7, meta: response("/download", {}).meta }) },
    evidence: { register: () => { throw new Error("oversized evidence must not be registered"); } }
  } as unknown as AppRuntime;
  try {
    registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_evidence_capture", { scope_id: "scope", file_id: "10" });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const artifact = result.structuredContent?.artifact as Record<string, unknown>;
    assert.equal(artifact.delivery, "omitted");
    assert.equal(artifact.resource_uri, undefined);
    await assert.rejects(() => fs.stat(tempPath), { code: "ENOENT" });
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
