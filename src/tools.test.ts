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
  const result = await call(server, "yfy_item_search", { query: "证书", item_type: "all", field: "all", space: "personal", precise: false, sort: "score", direction: "desc", view: "full", page_id: 0, page_capacity: 50 });
  assert.notEqual(result.isError, true);
  assert.equal((result.structuredContent?.authority as Record<string, unknown>).level, "hint_only");
  const file = (result.structuredContent?.files as Array<Record<string, unknown>>)[0];
  assert.equal((file.owned_by as Record<string, unknown>).name, "Owner");
  assert.ok(!Object.prototype.hasOwnProperty.call(file.owned_by as object, "login"));
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
  assert.deepEqual(shares.structuredContent?.page, { page_id: 0, page_capacity: 2, page_count: 2, total_count: 3, has_more: true, next_page_id: 1 });
  mode = "fallback";
  const users = await call(server, "yfy_user_search", { page_id: 3, page_capacity: 25, include_contact: false });
  assert.deepEqual(users.structuredContent?.page, { page_id: 3, page_capacity: 25, has_more: false });
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
  assert.deepEqual(result.structuredContent?.page, { page_id: 0, page_capacity: 2, has_more: true, next_page_id: 1 });
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
  assert.deepEqual(result.structuredContent?.page, { page_id: 0, page_capacity: 1, has_more: true, next_page_id: 1 });
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
      summary: () => ({ completeness: { pagination_complete: true } })
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
});

test("evidence capture rejects metadata drift and removes the candidate artifact", async () => {
  const server = new FakeServer();
  let infoCalls = 0;
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: {
      resolveContext: access,
      resolveScope: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } })
    },
    gateway: {
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ id: 7, current: true }] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        infoCalls += 1;
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 10, sha1: infoCalls === 1 ? "a".repeat(40) : "b".repeat(40), modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/nonexistent-evidence.pdf", sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 10, meta: response("/download", {}).meta }) }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { file_id: "10", mode: "current_locked", scope_id: "scope" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EVIDENCE_DRIFT");
});

test("evidence verify rejects an empty comparison", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: { resolveContext: access }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_verify", { file_id: "10", verify_content: false });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_INPUT_INVALID");
});

test("evidence verify rejects empty expected strings without fail-open", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: { resolveContext: access }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_verify", { file_id: "10", expected_sha256: "", verify_content: false });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_INPUT_INVALID");
});

test("current_locked evidence rejects missing drift anchors", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: { resolveScope: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: {
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ id: 7, current: true }] })
        : response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, path: [{ id: "501", name: "Root", type: "folder" }] })
    }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { file_id: "10", mode: "current_locked", scope_id: "scope" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EVIDENCE_METADATA_INCOMPLETE");
});

test("evidence capture removes downloaded bytes when post-download recheck fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-recheck-"));
  const tempPath = path.join(dir, "candidate.pdf");
  await fs.writeFile(tempPath, "candidate");
  const server = new FakeServer();
  let infoCalls = 0;
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: { resolveScope: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: {
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ id: 7, current: true }] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        infoCalls += 1;
        if (infoCalls > 1) throw new YifangyunError("recheck failed", { code: "YFY_PROVIDER_TEST" });
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 9, sha1: "a".repeat(40), modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath, sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) }
  } as unknown as AppRuntime;
  try {
    registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_evidence_capture", { file_id: "10", mode: "current_locked", scope_id: "scope" });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_PROVIDER_TEST");
    await assert.rejects(() => fs.stat(tempPath), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("current_locked evidence fails when the Provider has no current version id", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"] },
    access: {
      resolveScope: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } })
    },
    gateway: {
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [] })
        : response(endpoint, { id: "10", name: "evidence.pdf", type: "file", path: [{ id: "501", name: "Root", type: "folder" }] })
    }
  } as unknown as AppRuntime;
  registerAuthorityEvidenceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_evidence_capture", { file_id: "10", mode: "current_locked", scope_id: "scope" });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_CURRENT_VERSION_NOT_FOUND");
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
