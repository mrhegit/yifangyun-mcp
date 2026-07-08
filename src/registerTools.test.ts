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

test("registerTools honors capability gates and mutation annotations", () => {
  const defaultServer = new FakeServer();
  registerTools(defaultServer as unknown as McpServer, makeClient(), makeConfig());

  assert.ok(defaultServer.tools.has("yfy_lock_current_original"));
  assert.ok(!defaultServer.tools.has("yfy_get_download_url"));
  assert.ok(!defaultServer.tools.has("yfy_create_folder"));
  assert.ok(!defaultServer.tools.has("yfy_admin_users"));

  const fullServer = new FakeServer();
  registerTools(
    fullServer as unknown as McpServer,
    makeClient(),
    makeConfig({ allowDownloadUrl: true, enableMutationTools: true, enableAdminTools: true })
  );

  assert.ok(fullServer.tools.has("yfy_get_download_url"));
  assert.ok(fullServer.tools.has("yfy_create_folder"));
  assert.ok(fullServer.tools.has("yfy_admin_users"));
  const createFolder = getTool(fullServer, "yfy_create_folder");
  assert.equal((createFolder.definition.annotations as { idempotentHint: boolean }).idempotentHint, false);
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

test("yfy_manage_collab invite fails fast when accessible_by is missing", async () => {
  let postCalls = 0;
  const server = new FakeServer();
  const client = makeClient({
    postAsUser: async () => {
      postCalls += 1;
      throw new Error("postAsUser should not be called");
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableMutationTools: true }));
  const tool = getTool(server, "yfy_manage_collab");
  const result = await tool.handler({ action: "invite", folder_id: 1 });

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { ok: boolean }).ok, false);
  assert.equal(postCalls, 0);
});

test("yfy_admin_departments create fails fast when body is missing", async () => {
  let postCalls = 0;
  const server = new FakeServer();
  const client = makeClient({
    postEnterprise: async () => {
      postCalls += 1;
      throw new Error("postEnterprise should not be called");
    }
  });

  registerTools(server as unknown as McpServer, client, makeConfig({ enableAdminTools: true }));
  const tool = getTool(server, "yfy_admin_departments");
  const result = await tool.handler({ action: "create" });

  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { ok: boolean }).ok, false);
  assert.equal(postCalls, 0);
});
