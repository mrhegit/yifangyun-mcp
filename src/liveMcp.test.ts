import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";
import { SERVER_VERSION } from "./version.js";

function loadDotEnv(filePath: string): void {
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

test("live MCP protocol exposes and executes the beta.3 evidence workflow", { skip: process.env.YFY_LIVE_MCP_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const fileId = process.env.YFY_LIVE_DOWNLOAD_FILE_ID;
  const rootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  assert.ok(fileId, "YFY_LIVE_DOWNLOAD_FILE_ID is required.");
  assert.ok(rootFolderId, "YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID is required.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-live-mcp-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TEMP_DIR = path.join(dir, "temp");
  process.env.YFY_TOOLSETS = "core,authority,snapshot,evidence,organization";
  process.env.YFY_WORKFLOW_PROFILES = "tender";
  process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "live_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  const runtime = await AppRuntime.create(loadConfig());
  const server = new McpServer({ name: "live-yifangyun", version: SERVER_VERSION });
  const client = new Client({ name: "live-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    registerCatalog(server, runtime);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    for (const name of ["yfy_context_get", "yfy_root_list", "yfy_evidence_lock_current", "yfy_evidence_release"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} should be exposed`);
    }
    const context = await client.callTool({ name: "yfy_context_get", arguments: {} });
    assert.equal((context.structuredContent as Record<string, unknown>).server instanceof Object, true);
    assert.equal(((context.structuredContent as Record<string, unknown>).server as Record<string, unknown>).version, SERVER_VERSION);
    const root = await client.callTool({ name: "yfy_root_list", arguments: { root: { kind: "scope", scope_id: "live_scope" }, page_id: 0, page_capacity: 5 } });
    assert.notEqual(root.isError, true, JSON.stringify(root.content));
    const locked = await client.callTool({ name: "yfy_evidence_lock_current", arguments: { file_id: fileId, scope_id: "live_scope" } });
    assert.notEqual(locked.isError, true, JSON.stringify(locked.content));
    const evidence = (locked.structuredContent as Record<string, unknown>).evidence as Record<string, unknown>;
    assert.match(String(evidence.sha256), /^[a-f\d]{64}$/);
    const resourceUri = String(evidence.resource_uri);
    assert.match(resourceUri, /^yfy:\/\/evidence\/[a-f\d]{48}$/);
    const released = await client.callTool({ name: "yfy_evidence_release", arguments: { resource_uri: resourceUri } });
    assert.equal((released.structuredContent as Record<string, unknown>).released, true);
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
