import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { YifangyunClient } from "./client.js";
import { registerTools } from "./tools/registerTools.js";
import { registerWorkflowTools } from "./tools/registerWorkflowTools.js";

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
};

class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(name: string, _definition: Record<string, unknown>, handler: RegisteredTool["handler"]): void {
    this.tools.set(name, { handler });
  }

  registerResource(): void {}
}

function loadDotEnv(filePath: string): void {
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function tool(server: FakeServer, name: string): RegisteredTool {
  const found = server.tools.get(name);
  assert.ok(found, `Expected live read tool ${name} to be registered`);
  return found;
}

function resultData(result: { structuredContent?: Record<string, unknown>; isError?: boolean }, name: string): Record<string, unknown> {
  const envelope = result.structuredContent ?? {};
  if (result.isError || envelope.ok === false) {
    const error = envelope.error && typeof envelope.error === "object" ? envelope.error as Record<string, unknown> : {};
    throw new Error(`${name} failed: ${String(error.message ?? "unknown error")}`);
  }
  const data = envelope.data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

async function required(server: FakeServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await tool(server, name).handler(args, { signal: new AbortController().signal, sendNotification: async () => undefined });
  return resultData(result, name);
}

async function optional(server: FakeServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const found = server.tools.get(name);
  if (!found) {
    return undefined;
  }
  const result = await found.handler(args);
  return resultData(result, name);
}

function firstObject(values: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  return values.find((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value));
}

test("live read-only tools work against configured Yifangyun environment", { skip: process.env.YFY_LIVE_READ_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);

  process.env.YFY_ALLOW_DOWNLOAD_URL = "disabled";
  process.env.YFY_ENABLE_MUTATION_TOOLS = "disabled";
  process.env.YFY_ENABLE_RAW_RESPONSE = "disabled";

  const config = loadConfig();
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-live-scan-"));
  config.scanDir = scanDir;
  const client = new YifangyunClient(config);
  const server = new FakeServer();
  registerTools(server as unknown as McpServer, client, config);
  registerWorkflowTools(server as unknown as McpServer, client, config);

  await required(server, "yfy_auth_test");
  await required(server, "yfy_get_user_info");
  await optional(server, "yfy_get_department_info", { department_id: 0 });
  await optional(server, "yfy_list_department_children", { department_id: 0 });
  await optional(server, "yfy_list_department_users", { department_id: 0, page_id: 0 });
  const departmentFolders = await optional(server, "yfy_list_department_folders", { department_id: 0, page_id: 0, page_capacity: 5 });
  await optional(server, "yfy_get_user_by_query", { page_id: 0 });
  await optional(server, "yfy_list_groups");
  const collabItems = await optional(server, "yfy_list_collab_items", { page_id: 0, page_capacity: 5 });

  const personal = await required(server, "yfy_list_personal_items", { page_id: 0, page_capacity: 5 });
  const firstFolder = firstObject(personal.folders) ?? firstObject(departmentFolders?.folders) ?? firstObject(collabItems?.folders);
  const firstFile = firstObject(personal.files) ?? firstObject(collabItems?.files);
  const searchTerm = String(firstFile?.name ?? firstFolder?.name ?? "test");
  const search = await required(server, "yfy_search_items", { query_words: searchTerm, page_id: 0, page_capacity: 5, type: "all", query_filter: "all" });
  const advancedSearch = await required(server, "yfy_search_items_advanced", { query_words: searchTerm, page_id: 0, page_capacity: 5, type: "all", query_filter: "all", include_full_metadata: false });
  await optional(server, "yfy_resolve_path", { path: `/${searchTerm}` });

  const folderCandidate = firstFolder ?? firstObject(search.folders) ?? firstObject(advancedSearch.folders);
  const fileCandidate = firstFile ?? firstObject(search.files) ?? firstObject(advancedSearch.files);

  if (folderCandidate?.id !== undefined) {
    const folderId = folderCandidate.id;
    await required(server, "yfy_get_folder_info", { folder_id: folderId });
    const folderChildren = await required(server, "yfy_list_folder_children", { folder_id: folderId, page_id: 0, page_capacity: 5, type: "all" });
    await required(server, "yfy_get_folder_ancestors", { folder_id: folderId });
    await required(server, "yfy_build_scope_snapshot", { root_folder_id: folderId, max_depth: 1, max_items: 20, page_capacity: 5 });
    await required(server, "yfy_list_folder_tree", { root_folder_id: folderId, max_depth: 1, max_items: 20, page_capacity: 5 });
    const childSearchItem = firstObject(folderChildren.files) ?? firstObject(folderChildren.folders);
    const recursiveQuery = childSearchItem?.name !== undefined ? String(childSearchItem.name) : "__mcp_live_probe_no_match__";
    const recursive = await required(server, "yfy_search_items_recursive", {
        root_folder_id: folderId,
        query_words: recursiveQuery,
        type: "all",
        match_mode: "contains",
        case_sensitive: false,
        max_depth: 1,
        max_items: 20,
        max_results: 5,
        page_capacity: 5,
        include_full_metadata: false
      });
    if (childSearchItem?.name !== undefined) {
      const recursiveItems = Array.isArray(recursive.items) ? recursive.items : [];
      assert.ok(recursiveItems.length >= 1, "Expected recursive search to return at least one match for a known child item name");
      assert.ok(String(recursiveItems[0]?.path_display ?? "").includes(recursiveQuery), "Expected recursive search result path to include the queried child name");
    } else {
      const recursiveStats = recursive.stats && typeof recursive.stats === "object" && !Array.isArray(recursive.stats)
        ? recursive.stats as Record<string, unknown>
        : {};
      assert.equal(Number(recursiveStats.returned_count ?? 0), 0, "Expected no recursive matches when probing a synthetic no-match query in an empty folder");
    }
  }

  if (fileCandidate?.id !== undefined) {
    const fileId = fileCandidate.id;
    await required(server, "yfy_get_file_info", { file_id: fileId });
    await required(server, "yfy_get_file_info_full", { file_id: fileId });
    await required(server, "yfy_get_file_versions", { file_id: fileId });
    await required(server, "yfy_get_file_ancestors", { file_id: fileId });
    await required(server, "yfy_verify_file_current_version", { file_id: fileId, verify_download_hash: false });
    await optional(server, "yfy_get_share_links", { item_type: "file", item_id: fileId, page_id: 0 });
    await optional(server, "yfy_get_comments", { file_id: fileId });
    await optional(server, "yfy_batch_get_file_info", { file_ids: [fileId] });
  }

  if (server.tools.has("yfy_admin_get_log_action_types")) {
    await optional(server, "yfy_admin_get_log_action_types", { is_all: false, action_types: [1] });
    await optional(server, "yfy_admin_list_groups", { page_id: 0 });
  }

  const liveScopeRoot = process.env.YFY_LIVE_SCOPE_ROOT_FOLDER_ID;
  if (liveScopeRoot) {
    await required(server, "yfy_validate_authority_root", { root_folder_id: liveScopeRoot });
    const started = await required(server, "yfy_start_scope_scan", {
      root_folder_id: liveScopeRoot,
      queries: ["验收证书"],
      match_fields: ["name", "path"],
      max_depth: 5,
      max_items: 10000,
      page_capacity: 100,
      include_files: true,
      include_folders: true,
      case_sensitive: false
    });
    const advanced = await required(server, "yfy_advance_scope_scan", {
      scan_id: started.scan_id,
      expected_revision: started.revision,
      max_pages: 2,
      max_wall_ms: 10000
    });
    assert.ok(Number(advanced.page_receipt_count ?? 0) >= 1);
    if (advanced.status === "running" || advanced.status === "paused_retryable") {
      await required(server, "yfy_cancel_scope_scan", { scan_id: started.scan_id, expected_revision: advanced.revision });
    }
  }
  fs.rmSync(scanDir, { recursive: true, force: true });
});
