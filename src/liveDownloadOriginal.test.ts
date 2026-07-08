import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { YifangyunClient } from "./client.js";
import { registerTools } from "./tools/registerTools.js";

type ToolResult = { structuredContent?: Record<string, unknown>; isError?: boolean };
type RegisteredTool = { handler: (args: Record<string, unknown>) => Promise<ToolResult> };
type Candidate = { fileId: string | number; rootFolderId?: string | number; source: string };

class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(name: string, _definition: Record<string, unknown>, handler: RegisteredTool["handler"]): void {
    this.tools.set(name, { handler });
  }
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

function getTool(server: FakeServer, name: string): RegisteredTool {
  const tool = server.tools.get(name);
  assert.ok(tool, `Expected live download tool ${name} to be registered`);
  return tool;
}

function unwrap(result: ToolResult, name: string): Record<string, unknown> {
  const envelope = result.structuredContent ?? {};
  if (result.isError || envelope.ok === false) {
    const error = envelope.error && typeof envelope.error === "object" ? envelope.error as Record<string, unknown> : {};
    throw new Error(`${name} failed: ${String(error.message ?? "unknown error")}`);
  }
  const data = envelope.data;
  assert.equal(typeof data, "object", `${name} should return object data`);
  assert.ok(data !== null && !Array.isArray(data), `${name} should return object data`);
  return data as Record<string, unknown>;
}

async function call(server: FakeServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return unwrap(await getTool(server, name).handler(args), name);
}

async function tryCall(server: FakeServer, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const tool = server.tools.get(name);
  if (!tool) {
    return undefined;
  }
  const result = await tool.handler(args);
  if (result.isError || result.structuredContent?.ok === false) {
    return undefined;
  }
  return unwrap(result, name);
}

function firstObjects(values: unknown): Record<string, unknown>[] {
  return Array.isArray(values)
    ? values.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value))
    : [];
}

function pushFiles(candidates: Candidate[], files: unknown, rootFolderId: unknown, source: string): void {
  for (const file of firstObjects(files)) {
    if (file.id !== undefined) {
      candidates.push({
        fileId: file.id as string | number,
        rootFolderId: typeof rootFolderId === "string" || typeof rootFolderId === "number" ? rootFolderId : undefined,
        source
      });
    }
  }
}

async function discoverCandidates(server: FakeServer): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const folders: Array<{ id: string | number; source: string }> = [];

  const personal = await tryCall(server, "yfy_list_personal_items", { page_id: 0, page_capacity: 20 });
  pushFiles(candidates, personal?.files, undefined, "personal-root");
  for (const folder of firstObjects(personal?.folders)) {
    if (folder.id !== undefined) {
      folders.push({ id: folder.id as string | number, source: "personal-folder" });
    }
  }

  const collabs = await tryCall(server, "yfy_list_collab_items", { page_id: 0, page_capacity: 20 });
  pushFiles(candidates, collabs?.files, undefined, "collab-root");
  for (const folder of firstObjects(collabs?.folders)) {
    if (folder.id !== undefined) {
      folders.push({ id: folder.id as string | number, source: "collab-folder" });
    }
  }

  const departmentFolders = await tryCall(server, "yfy_list_department_folders", { department_id: 0, page_id: 0, page_capacity: 20 });
  for (const folder of firstObjects(departmentFolders?.folders)) {
    if (folder.id !== undefined) {
      folders.push({ id: folder.id as string | number, source: "department-folder" });
    }
  }

  for (const folder of folders.slice(0, 12)) {
    const children = await tryCall(server, "yfy_list_folder_children", { folder_id: folder.id, page_id: 0, page_capacity: 20, type: "all" });
    pushFiles(candidates, children?.files, folder.id, folder.source);
  }

  return candidates;
}

function findRootFolderId(fileInfo: Record<string, unknown>, fallbackRoot?: string | number): string | number | undefined {
  if (fallbackRoot !== undefined) {
    return fallbackRoot;
  }
  const ancestors = Array.isArray(fileInfo.ancestor_folder_ids) ? fileInfo.ancestor_folder_ids : [];
  const firstAncestor = ancestors.find((value): value is string | number => typeof value === "string" || typeof value === "number");
  if (firstAncestor !== undefined) {
    return firstAncestor;
  }
  return typeof fileInfo.parent_folder_id === "string" || typeof fileInfo.parent_folder_id === "number" ? fileInfo.parent_folder_id : undefined;
}

function assertDownloaded(download: Record<string, unknown>): void {
  assert.equal(typeof download.temp_path, "string");
  assert.equal(typeof download.sha256, "string");
  assert.match(download.sha256 as string, /^[a-f0-9]{64}$/i);
  assert.equal(typeof download.size_bytes, "number");
  assert.ok((download.size_bytes as number) >= 0);
  const stat = fs.statSync(download.temp_path as string);
  assert.equal(stat.size, download.size_bytes);
}

test("live original download returns temp file, sha256, and size", { skip: process.env.YFY_LIVE_DOWNLOAD_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);

  process.env.YFY_ALLOW_DOWNLOAD_URL = "disabled";
  process.env.YFY_ENABLE_MUTATION_TOOLS = "disabled";
  process.env.YFY_ENABLE_ADMIN_TOOLS = "disabled";
  process.env.YFY_ENABLE_RAW_RESPONSE = "disabled";

  const config = loadConfig();
  const client = new YifangyunClient(config);
  const server = new FakeServer();
  registerTools(server as unknown as McpServer, client, config);

  await call(server, "yfy_auth_test");

  const configuredFileId = process.env.YFY_LIVE_DOWNLOAD_FILE_ID;
  const configuredRootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  const candidate = configuredFileId
    ? { fileId: configuredFileId, rootFolderId: configuredRootFolderId, source: "env" }
    : (await discoverCandidates(server))[0];

  assert.ok(candidate, "No downloadable file candidate found. Set YFY_LIVE_DOWNLOAD_FILE_ID to test a specific file.");
  const file = await call(server, "yfy_get_file_info_full", { file_id: candidate.fileId });
  const size = typeof file.size === "number" ? file.size : undefined;
  if (size !== undefined) {
    assert.ok(size <= config.maxDownloadBytes, `Candidate file exceeds YFY_MAX_DOWNLOAD_BYTES: ${size}`);
  }

  const rootFolderId = findRootFolderId(file, candidate.rootFolderId);
  if (rootFolderId !== undefined) {
    const locked = await call(server, "yfy_lock_current_original", { file_id: candidate.fileId, root_folder_id: rootFolderId });
    const download = locked.download;
    assert.ok(typeof download === "object" && download !== null && !Array.isArray(download));
    assertDownloaded(download as Record<string, unknown>);
  } else {
    const download = await call(server, "yfy_download_and_hash", { file_id: candidate.fileId });
    assertDownloaded(download);
  }
});
