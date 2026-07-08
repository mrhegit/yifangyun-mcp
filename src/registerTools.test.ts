import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/registerTools.js";
import type { ApiJsonResponse, ApiResponseMeta, AppConfig, IdLike, JsonValue } from "./types.js";
import type { YifangyunClient } from "./client.js";

type RegisteredTool = {
  definition: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
};

class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(name: string, definition: Record<string, unknown>, handler: RegisteredTool["handler"]): void {
    this.tools.set(name, { definition, handler });
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiBaseUrl: "https://open.fangcloud.com/api",
    allowDownloadUrl: false,
    adminUserId: 999,
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    enterpriseId: 115,
    defaultUserId: 530,
    enableAdminTools: false,
    enableMutationTools: false,
    enableRawResponse: false,
    fileAccessUserStrategy: "default",
    logLevel: "info",
    maxDownloadBytes: 268435456,
    maxPageCapacity: 500,
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 100,
    retryMaxAttempts: 1,
    tempDir: "C:/temp/yifangyun-mcp-test",
    tempFileTtlSeconds: 60,
    tokenRefreshSkewSeconds: 300,
    ...overrides
  };
}

function makeMeta(endpoint: string): ApiResponseMeta {
  return {
    endpoint,
    fetchedAtIso: "2026-07-08T00:00:00.000Z",
    fetchedAtUnix: 1780000000,
    sourceApiVersion: "v2",
    statusCode: 200
  };
}

function makeResponse(endpoint: string, data: JsonValue): ApiJsonResponse {
  return { data, meta: makeMeta(endpoint) };
}

function makeClient(overrides: Partial<Record<string, (...args: any[]) => unknown>> = {}): YifangyunClient {
  const unexpected = (name: string) => async () => {
    throw new Error(`Unexpected client call: ${name}`);
  };

  return {
    getEnterpriseToken: overrides.getEnterpriseToken ?? (async () => "enterprise-token"),
    getUserToken: overrides.getUserToken ?? (async () => "user-token"),
    getEnterprise: overrides.getEnterprise ?? unexpected("getEnterprise"),
    getAsUser: overrides.getAsUser ?? unexpected("getAsUser"),
    postEnterprise: overrides.postEnterprise ?? unexpected("postEnterprise"),
    postAsUser: overrides.postAsUser ?? unexpected("postAsUser"),
    downloadFromUrlToTemp: overrides.downloadFromUrlToTemp ?? unexpected("downloadFromUrlToTemp"),
    uploadLocalFileToPresignedUrl: overrides.uploadLocalFileToPresignedUrl ?? unexpected("uploadLocalFileToPresignedUrl"),
    resolveFileAccessUser: overrides.resolveFileAccessUser ?? ((userId?: IdLike) => userId ?? 530)
  } as unknown as YifangyunClient;
}

function getTool(server: FakeServer, name: string): RegisteredTool {
  const tool = server.tools.get(name);
  assert.ok(tool, `Expected tool ${name} to be registered`);
  return tool;
}

const compatibilityWrapperTools = [
  "yfy_manage_collab",
  "yfy_admin_departments",
  "yfy_admin_groups",
  "yfy_admin_users",
  "yfy_admin_logs",
  "yfy_admin_sync"
] as const;

const mutationAtomicTools = [
  "yfy_create_folder",
  "yfy_update_file",
  "yfy_update_folder",
  "yfy_move_item",
  "yfy_copy_item",
  "yfy_delete_item",
  "yfy_restore_item",
  "yfy_upload_file",
  "yfy_upload_file_by_path",
  "yfy_upload_new_version",
  "yfy_invite_collab",
  "yfy_invite_collabs_batch",
  "yfy_get_collab_info",
  "yfy_update_collab_role",
  "yfy_delete_collab",
  "yfy_remove_collabs"
] as const;

const adminAtomicTools = [
  "yfy_admin_get_department_info",
  "yfy_admin_list_department_children",
  "yfy_admin_list_department_users",
  "yfy_admin_list_department_spaces",
  "yfy_admin_create_department",
  "yfy_admin_update_department",
  "yfy_admin_delete_department",
  "yfy_admin_add_department_user",
  "yfy_admin_remove_department_user",
  "yfy_admin_update_department_space",
  "yfy_admin_list_groups",
  "yfy_admin_get_group_info",
  "yfy_admin_list_group_users",
  "yfy_admin_create_group",
  "yfy_admin_update_group",
  "yfy_admin_delete_group",
  "yfy_admin_add_group_user",
  "yfy_admin_remove_group_user",
  "yfy_admin_get_user_info",
  "yfy_admin_lookup_user",
  "yfy_admin_create_user",
  "yfy_admin_update_user",
  "yfy_admin_delete_user",
  "yfy_admin_get_user_login_url",
  "yfy_admin_get_user_login_params",
  "yfy_admin_get_log_action_types",
  "yfy_admin_get_log_info",
  "yfy_admin_list_logs",
  "yfy_admin_list_logs_paginated",
  "yfy_admin_map_platform_user",
  "yfy_admin_map_platform_group",
  "yfy_admin_map_platform_department",
  "yfy_admin_sync_platform_users",
  "yfy_admin_sync_platform_groups",
  "yfy_admin_sync_platform_departments"
] as const;

test("registerTools honors capability gates and mutation annotations", () => {
  const defaultServer = new FakeServer();
  registerTools(defaultServer as unknown as McpServer, makeClient(), makeConfig());

  assert.ok(defaultServer.tools.has("yfy_lock_current_original"));
  assert.ok(!defaultServer.tools.has("yfy_get_download_url"));
  for (const toolName of mutationAtomicTools) {
    assert.ok(!defaultServer.tools.has(toolName), `Expected ${toolName} to be gated by mutation flag`);
  }
  for (const toolName of adminAtomicTools) {
    assert.ok(!defaultServer.tools.has(toolName), `Expected ${toolName} to be gated by admin flag`);
  }
  for (const toolName of compatibilityWrapperTools) {
    assert.ok(!defaultServer.tools.has(toolName), `Expected compatibility wrapper ${toolName} to stay removed`);
  }

  const fullServer = new FakeServer();
  registerTools(
    fullServer as unknown as McpServer,
    makeClient(),
    makeConfig({ allowDownloadUrl: true, enableMutationTools: true, enableAdminTools: true })
  );

  assert.ok(fullServer.tools.has("yfy_get_download_url"));
  for (const toolName of mutationAtomicTools) {
    assert.ok(fullServer.tools.has(toolName), `Expected mutation atomic tool ${toolName} to be registered`);
  }
  for (const toolName of adminAtomicTools) {
    assert.ok(fullServer.tools.has(toolName), `Expected admin atomic tool ${toolName} to be registered`);
  }
  for (const toolName of compatibilityWrapperTools) {
    assert.ok(!fullServer.tools.has(toolName), `Expected compatibility wrapper ${toolName} to stay removed`);
  }
  const createFolder = getTool(fullServer, "yfy_create_folder");
  assert.equal((createFolder.definition.annotations as { idempotentHint: boolean }).idempotentHint, false);
  const deleteCollab = getTool(fullServer, "yfy_delete_collab");
  assert.equal((deleteCollab.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
  const adminListGroups = getTool(fullServer, "yfy_admin_list_groups");
  assert.equal((adminListGroups.definition.annotations as { readOnlyHint: boolean }).readOnlyHint, true);
  const adminSyncUsers = getTool(fullServer, "yfy_admin_sync_platform_users");
  assert.equal((adminSyncUsers.definition.annotations as { destructiveHint: boolean }).destructiveHint, true);
});

test("yfy_lock_current_original fails fast when file is outside the requested scope", async () => {
  let downloadCalls = 0;
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string) => {
      if (pathname === "/v2/file/123/info_v2") {
        return makeResponse(pathname, {
          id: 123,
          name: "secret.docx",
          type: "file",
          parent_folder_id: 2,
          path: [
            { id: 1, type: "folder", name: "RootA" },
            { id: 2, type: "folder", name: "FolderA" }
          ]
        });
      }
      throw new Error(`Unexpected path: ${pathname}`);
    },
    downloadFromUrlToTemp: async () => {
      downloadCalls += 1;
      throw new Error("download should not be called");
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_lock_current_original");
  const result = await tool.handler({ file_id: 123, root_folder_id: 999 });

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { ok: boolean }).ok, false);
  assert.equal(downloadCalls, 0);
});

test("yfy_get_share_links redacts direct share credentials in structured output", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string) => {
      assert.equal(pathname, "/v2/file/3/share_links");
      return makeResponse(pathname, {
        share_links: [
          {
            id: 1,
            unique_name: "share-abc",
            share_link: "https://secret-share",
            url: "https://secret-url",
            password: "1234",
            password_protected: true,
            access: "company",
            item: { id: 3, type: "file", name: "doc.pdf" }
          }
        ]
      });
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_get_share_links");
  const result = await tool.handler({ item_type: "file", item_id: 3, page_id: 0 });
  const data = (result.structuredContent as { data: { share_links: Array<Record<string, unknown>> } }).data;
  const first = data.share_links[0];

  assert.equal(first.share_link_present, true);
  assert.equal(first.url_present, true);
  assert.equal(first.password_protected, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(first, "share_link"));
  assert.ok(!Object.prototype.hasOwnProperty.call(first, "url"));
  assert.ok(!Object.prototype.hasOwnProperty.call(first, "password"));
});

test("yfy_search_items_advanced toggles output density with include_full_metadata", async () => {
  const server = new FakeServer();
  const searchPayload = {
    files: [
      {
        id: 10,
        name: "report.docx",
        type: "file",
        size: 2048,
        parent_folder_id: 3,
        extension_category: "document",
        modified_at: 1700000000,
        description: "detailed",
        sha1: "abc123",
        path: [{ id: 3, type: "folder", name: "Reports" }]
      }
    ],
    folders: [],
    page_id: 0,
    page_capacity: 50,
    page_count: 1,
    total_count: 1
  } satisfies JsonValue;

  const client = makeClient({
    getAsUser: async (pathname: string) => {
      assert.equal(pathname, "/v2/item/search");
      return makeResponse(pathname, searchPayload);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_advanced");

  const light = await tool.handler({ query_words: "report", include_full_metadata: false, page_id: 0, page_capacity: 50, type: "all", query_filter: "all", sort_by: "date", sort_direction: "desc" });
  const lightFile = (((light.structuredContent as { data: { files: Array<Record<string, unknown>> } }).data.files)[0]);
  assert.ok(!Object.prototype.hasOwnProperty.call(lightFile, "sha1"));
  assert.ok(!Object.prototype.hasOwnProperty.call(lightFile, "description"));

  const full = await tool.handler({ query_words: "report", include_full_metadata: true, page_id: 0, page_capacity: 50, type: "all", query_filter: "all", sort_by: "date", sort_direction: "desc" });
  const fullFile = (((full.structuredContent as { data: { files: Array<Record<string, unknown>> } }).data.files)[0]);
  assert.equal(fullFile.sha1, "abc123");
  assert.equal(fullFile.description, "detailed");
});

test("yfy_build_scope_snapshot keeps direct-children semantics when max_depth is zero", async () => {
  const server = new FakeServer();
  const seen: string[] = [];
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      seen.push(pathname);
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/70/info") {
        return makeResponse(pathname, { id: 70, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/70/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 71, type: "folder", name: "ChildFolder" }],
          files: [{ id: 72, type: "file", name: "top.txt" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/71/children") {
        throw new Error("max_depth=0 should not descend into grandchild listings");
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_build_scope_snapshot");
  const result = await tool.handler({ root_folder_id: 70, max_depth: 0, max_items: 10, page_capacity: 200, include_files: true, include_folders: true });
  const envelope = result.structuredContent as { ok: boolean; data: { folders: Array<Record<string, unknown>>; files: Array<Record<string, unknown>>; stats: Record<string, unknown> }; warnings?: string[] };

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.folders.map((item) => item.name), ["ChildFolder"]);
  assert.deepEqual(envelope.data.files.map((item) => item.name), ["top.txt"]);
  assert.equal(envelope.data.stats.max_depth, 0);
  assert.equal(envelope.data.stats.visited_count, 2);
  assert.equal(envelope.data.stats.truncated, false);
  assert.deepEqual(envelope.warnings ?? [], []);
  assert.ok(!seen.includes("/v2/folder/71/children"));
});

test("yfy_search_items_recursive walks paginated descendants without using official search", async () => {
  const server = new FakeServer();
  const seen: string[] = [];
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      seen.push(pathname);
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/1/info") {
        return makeResponse(pathname, { id: 1, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/1/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 2, type: "folder", name: "Target Specs" }],
          files: [{ id: 10, type: "file", name: "notes.txt" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 2,
          total_count: 3
        });
      }
      if (pathname === "/v2/folder/1/children" && pageId === 1) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 11, type: "file", name: "target-overview.docx", description: "root hit", sha1: "root-sha" }],
          page_id: 1,
          page_capacity: 200,
          page_count: 2,
          total_count: 3
        });
      }
      if (pathname === "/v2/folder/2/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 3, type: "folder", name: "Nested" }],
          files: [{ id: 12, type: "file", name: "bid-target.pdf", description: "child hit", sha1: "child-sha" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/3/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 13, type: "file", name: "target-appendix.docx", description: "deep hit", sha1: "deep-sha" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 1
        });
      }
      if (pathname === "/v2/item/search") {
        throw new Error("recursive search must not call /v2/item/search");
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_recursive");
  const result = await tool.handler({
    root_folder_id: 1,
    query_words: "target",
    type: "all",
    match_mode: "contains",
    case_sensitive: false,
    max_depth: 5,
    max_items: 20,
    max_results: 10,
    page_capacity: 200,
    include_full_metadata: false
  });
  const envelope = result.structuredContent as { ok: boolean; data: { items: Array<Record<string, unknown>>; stats: Record<string, unknown> } };
  const items = envelope.data.items;
  const stats = envelope.data.stats;

  assert.equal(envelope.ok, true);
  assert.deepEqual(items.map((item) => item.name), ["Target Specs", "bid-target.pdf", "target-appendix.docx", "target-overview.docx"]);
  assert.deepEqual(items.map((item) => item.path_display), [
    "Root/Target Specs",
    "Root/Target Specs/bid-target.pdf",
    "Root/Target Specs/Nested/target-appendix.docx",
    "Root/target-overview.docx"
  ]);
  assert.equal(stats.scanned_count, 6);
  assert.equal(stats.matched_count, 4);
  assert.equal(stats.folder_match_count, 1);
  assert.equal(stats.file_match_count, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(items[0], "description"));
  assert.ok(!Object.prototype.hasOwnProperty.call(items[1], "sha1"));
  assert.ok(!seen.includes("/v2/item/search"));
});

test("yfy_search_items_recursive supports full metadata output", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/8/info") {
        return makeResponse(pathname, { id: 8, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/8/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 20, type: "file", name: "target.docx", description: "rich", sha1: "sha-rich", parent_folder_id: 8, modified_at: 1700000000 }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 1
        });
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_recursive");
  const result = await tool.handler({
    root_folder_id: 8,
    query_words: "target",
    type: "file",
    match_mode: "contains",
    case_sensitive: false,
    max_depth: 1,
    max_items: 10,
    max_results: 10,
    page_capacity: 200,
    include_full_metadata: true
  });
  const item = (((result.structuredContent as { data: { items: Array<Record<string, unknown>> } }).data.items)[0]);

  assert.equal(item.description, "rich");
  assert.equal(item.sha1, "sha-rich");
  assert.equal(item.path_display, "Root/target.docx");
});

test("yfy_search_items_recursive respects max_depth and type filtering", async () => {
  const server = new FakeServer();
  const seen: string[] = [];
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      seen.push(pathname);
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/30/info") {
        return makeResponse(pathname, { id: 30, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/30/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 31, type: "folder", name: "Target" }],
          files: [{ id: 32, type: "file", name: "target.txt", parent_folder_id: 30, modified_at: 1700000000 }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 2
        });
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_recursive");
  const result = await tool.handler({
    root_folder_id: 30,
    query_words: "target.txt",
    type: "file",
    match_mode: "exact",
    case_sensitive: false,
    max_depth: 0,
    max_items: 10,
    max_results: 10,
    page_capacity: 200,
    include_full_metadata: false
  });
  const envelope = result.structuredContent as { data: { items: Array<Record<string, unknown>>; stats: Record<string, unknown> } };

  assert.deepEqual(envelope.data.items.map((item) => item.name), ["target.txt"]);
  assert.equal(envelope.data.stats.folder_match_count, 0);
  assert.equal(envelope.data.stats.file_match_count, 1);
  assert.ok(!seen.includes("/v2/folder/31/children"));
});

test("yfy_search_items_recursive exposes traversal truncation and result limiting", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/40/info") {
        return makeResponse(pathname, { id: 40, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/40/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [],
          files: [
            { id: 41, type: "file", name: "target-a.txt" },
            { id: 42, type: "file", name: "target-b.txt" },
            { id: 43, type: "file", name: "target-c.txt" }
          ],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 3
        });
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_recursive");
  const result = await tool.handler({
    root_folder_id: 40,
    query_words: "target",
    type: "file",
    match_mode: "contains",
    case_sensitive: false,
    max_depth: 1,
    max_items: 2,
    max_results: 1,
    page_capacity: 200,
    include_full_metadata: false
  });
  const envelope = result.structuredContent as { data: { items: Array<Record<string, unknown>>; stats: Record<string, unknown> }; warnings?: string[] };

  assert.equal(envelope.data.stats.truncated, true);
  assert.equal(envelope.data.stats.result_limited, true);
  assert.equal(envelope.data.stats.scanned_count, 2);
  assert.equal(envelope.data.stats.matched_count, 2);
  assert.equal(envelope.data.stats.returned_count, 1);
  assert.deepEqual(envelope.warnings, [
    "Recursive search truncated by max_items. Increase max_items for a fuller result.",
    "Recursive search truncated by max_results. Increase max_results for more matches."
  ]);
});

test("yfy_search_items_recursive returns empty results when nothing matches", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/50/info") {
        return makeResponse(pathname, { id: 50, type: "folder", name: "Root" });
      }
      if (pathname === "/v2/folder/50/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 51, type: "folder", name: "Specs" }],
          files: [{ id: 52, type: "file", name: "notes.txt" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/51/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 53, type: "file", name: "appendix.pdf" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 1,
          total_count: 1
        });
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_search_items_recursive");
  const result = await tool.handler({
    root_folder_id: 50,
    query_words: "missing-keyword",
    type: "all",
    match_mode: "contains",
    case_sensitive: false,
    max_depth: 5,
    max_items: 20,
    max_results: 10,
    page_capacity: 200,
    include_full_metadata: false
  });
  const envelope = result.structuredContent as { ok: boolean; data: { items: Array<Record<string, unknown>>; stats: Record<string, unknown> } };

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.items, []);
  assert.equal(envelope.data.stats.matched_count, 0);
  assert.equal(envelope.data.stats.returned_count, 0);
  assert.equal(envelope.data.stats.truncated, false);
});

test("yfy_resolve_path paginates root and child listings", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getAsUser: async (pathname: string, _userId: IdLike | undefined, params?: Record<string, unknown>) => {
      const pageId = Number(params?.page_id ?? 0);
      if (pathname === "/v2/folder/personal_items" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [{ id: 1, type: "folder", name: "Other" }],
          files: [],
          page_id: 0,
          page_capacity: 200,
          page_count: 2,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/personal_items" && pageId === 1) {
        return makeResponse(pathname, {
          folders: [{ id: 2, type: "folder", name: "Target" }],
          files: [],
          page_id: 1,
          page_capacity: 200,
          page_count: 2,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/2/children" && pageId === 0) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 9, type: "file", name: "skip.txt" }],
          page_id: 0,
          page_capacity: 200,
          page_count: 2,
          total_count: 2
        });
      }
      if (pathname === "/v2/folder/2/children" && pageId === 1) {
        return makeResponse(pathname, {
          folders: [],
          files: [{ id: 10, type: "file", name: "file.txt" }],
          page_id: 1,
          page_capacity: 200,
          page_count: 2,
          total_count: 2
        });
      }
      throw new Error(`Unexpected path ${pathname} page ${pageId}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig());
  const tool = getTool(server, "yfy_resolve_path");
  const result = await tool.handler({ path: "/Target/file.txt" });
  const data = (result.structuredContent as { data: Record<string, unknown> }).data;

  assert.equal(data.resolved, true);
  assert.equal((data.resolved_item as { name: string }).name, "file.txt");
});

test("yfy_invite_collab builds the official invite body", async () => {
  const server = new FakeServer();
  const client = makeClient({
    postAsUser: async (pathname: string, userId: IdLike | undefined, body: Record<string, unknown>) => {
      assert.equal(pathname, "/v2/collab/invite");
      assert.equal(userId, 530);
      assert.deepEqual(body, {
        folder_id: 7,
        accessible_by: { type: "user", id: 42, role: "viewer" },
        invitation_message: "hello"
      });
      return makeResponse(pathname, { id: 9, role: "viewer", accepted: false });
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableMutationTools: true }));
  const tool = getTool(server, "yfy_invite_collab");
  const result = await tool.handler({ folder_id: 7, accessible_by: { type: "user", id: 42, role: "viewer" }, invitation_message: "hello", user_id: 530 });

  assert.equal((result.structuredContent as { ok: boolean }).ok, true);
});

test("yfy_admin_create_department builds a typed department body", async () => {
  const server = new FakeServer();
  const client = makeClient({
    postEnterprise: async (pathname: string, body: Record<string, unknown>) => {
      assert.equal(pathname, "/v2/admin/department/create");
      assert.deepEqual(body, {
        name: "Sales",
        parent_id: 0,
        director_id: 88,
        space_total: 20,
        hide_phone: true
      });
      return makeResponse(pathname, { id: 12, name: "Sales", parent_id: 0 });
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableAdminTools: true }));
  const tool = getTool(server, "yfy_admin_create_department");
  const result = await tool.handler({ name: "Sales", parent_id: 0, director_id: 88, space_total: 20, hide_phone: true });

  assert.equal((result.structuredContent as { ok: boolean }).ok, true);
});

test("yfy_admin_lookup_user uses explicit identifier parameters", async () => {
  const server = new FakeServer();
  const client = makeClient({
    getEnterprise: async (pathname: string, params?: Record<string, unknown>) => {
      assert.equal(pathname, "/v2/admin/user/get_user_info");
      assert.deepEqual(params, {
        identifier: "dev@example.com",
        type: "simple_phone_or_email",
        platform_id: "2"
      });
      return makeResponse(pathname, { id: 55, name: "Dev" });
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableAdminTools: true }));
  const tool = getTool(server, "yfy_admin_lookup_user");
  const result = await tool.handler({ identifier: "dev@example.com", identifier_type: "simple_phone_or_email", platform_id: 2 });

  assert.equal((result.structuredContent as { ok: boolean }).ok, true);
});

test("admin group, log, delete-user, and platform-sync atomic tools build official requests", async () => {
  const server = new FakeServer();
  const seen: string[] = [];
  const client = makeClient({
    getEnterprise: async (pathname: string, params?: Record<string, unknown>) => {
      seen.push(pathname);
      if (pathname === "/v2/admin/group/list") {
        assert.deepEqual(params, { query_words: "ops", page_id: 2 });
        return makeResponse(pathname, { groups: [{ id: 1, name: "Ops" }] });
      }
      throw new Error(`Unexpected getEnterprise path: ${pathname}`);
    },
    postEnterprise: async (pathname: string, body: Record<string, unknown>) => {
      seen.push(pathname);
      if (pathname === "/v2/admin/group/3/update") {
        assert.deepEqual(body, { name: "Ops2", visible: true });
        return makeResponse(pathname, { id: 3, name: "Ops2" });
      }
      if (pathname === "/v2/admin/user/9/delete") {
        assert.deepEqual(body, { user_receive_items: 10 });
        return makeResponse(pathname, { success: true });
      }
      if (pathname === "/v2/admin/log/log_list") {
        assert.deepEqual(body, { start_date: "2026-07-01", end_date: "2026-07-08", page_id: 1, page_capacity: 25 });
        return makeResponse(pathname, { user_activities: [], total_count: 0 });
      }
      if (pathname === "/v2/admin/platform/2/sync_groups") {
        assert.deepEqual(body, { groups: [{ id: "g1", admin_id: "u1", name: "G1", status: 1 }] });
        return makeResponse(pathname, { success: true });
      }
      throw new Error(`Unexpected postEnterprise path: ${pathname}`);
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableAdminTools: true }));
  await getTool(server, "yfy_admin_list_groups").handler({ query_words: "ops", page_id: 2 });
  await getTool(server, "yfy_admin_update_group").handler({ group_id: 3, name: "Ops2", visible: true });
  await getTool(server, "yfy_admin_delete_user").handler({ user_id: 9, transfer_to_user_id: 10 });
  await getTool(server, "yfy_admin_list_logs").handler({ start_date: "2026-07-01", end_date: "2026-07-08" });
  await getTool(server, "yfy_admin_sync_platform_groups").handler({ platform_id: 2, body: { groups: [{ id: "g1", admin_id: "u1", name: "G1", status: 1 }] } });

  assert.deepEqual(seen, [
    "/v2/admin/group/list",
    "/v2/admin/group/3/update",
    "/v2/admin/user/9/delete",
    "/v2/admin/log/log_list",
    "/v2/admin/platform/2/sync_groups"
  ]);
});
