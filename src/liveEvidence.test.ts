import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
class FakeServer {
  readonly tools = new Map<string, Handler>();
  registerTool(name: string, _definition: unknown, handler: Handler): void { this.tools.set(name, handler); }
  registerResource(): void {}
  registerPrompt(): void {}
}

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

test("v1 live evidence capture downloads and hashes a controlled file", { skip: process.env.YFY_LIVE_EVIDENCE_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const fileId = process.env.YFY_LIVE_DOWNLOAD_FILE_ID;
  assert.ok(fileId, "YFY_LIVE_DOWNLOAD_FILE_ID is required for live evidence testing.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-v1-evidence-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "core,evidence,authority";
  const rootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  if (rootFolderId) process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "evidence_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  let tempPath: string | undefined;
  try {
    const handler = server.tools.get("yfy_evidence_capture")!;
    const result = await handler({ file_id: fileId, mode: rootFolderId ? "current_locked" : "download", ...(rootFolderId ? { scope_id: "evidence_scope" } : {}) }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const evidence = result.structuredContent?.evidence as Record<string, unknown>;
    assert.match(String(evidence.sha256), /^[a-f0-9]{64}$/i);
    tempPath = String(evidence.temp_path);
    assert.equal(fs.statSync(tempPath).size, evidence.size_bytes);
  } finally {
    if (tempPath) fs.rmSync(tempPath, { force: true });
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
