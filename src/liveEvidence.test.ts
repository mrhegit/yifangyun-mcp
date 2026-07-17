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

test("live evidence tools download and hash a controlled file", { skip: process.env.YFY_LIVE_EVIDENCE_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const fileId = process.env.YFY_LIVE_DOWNLOAD_FILE_ID;
  assert.ok(fileId, "YFY_LIVE_DOWNLOAD_FILE_ID is required for live evidence testing.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-v1-evidence-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "core,evidence,authority";
  const rootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  process.env.YFY_WORKFLOW_PROFILES = "";
  if (rootFolderId) process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "evidence_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  const tempPaths: string[] = [];
  try {
    const handler = server.tools.get(rootFolderId ? "yfy_evidence_lock_current" : "yfy_evidence_download")!;
    const result = await handler({ file_id: fileId, ...(rootFolderId ? { scope_id: "evidence_scope" } : { version: { kind: "current" } }) }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const evidence = result.structuredContent?.evidence as Record<string, unknown>;
    assert.match(String(evidence.sha256), /^[a-f0-9]{64}$/i);
    tempPaths.push(String(evidence.temp_path));
    assert.equal(fs.statSync(tempPaths[0]!).size, evidence.size_bytes);
    const verify = server.tools.get("yfy_evidence_verify")!;
    const verified = await verify({ file_id: fileId, version: { kind: "current" }, expected_sha256: String(evidence.sha256), expected_size_bytes: Number(evidence.size_bytes) }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(verified.isError, true, JSON.stringify(verified.structuredContent));
    assert.equal(verified.structuredContent?.matches, true);
    const verifiedEvidence = verified.structuredContent?.evidence as Record<string, unknown>;
    if (typeof verifiedEvidence?.temp_path === "string") tempPaths.push(verifiedEvidence.temp_path);
    const versionsHandler = server.tools.get("yfy_file_versions")!;
    const versionsResult = await versionsHandler({ file_id: fileId }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    const versions = versionsResult.structuredContent?.versions as Array<Record<string, unknown>>;
    if (versions.length > 1) {
      const historical = await server.tools.get("yfy_evidence_download")!({ file_id: fileId, version: { kind: "history", generations_back: 1 } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
      assert.notEqual(historical.isError, true, JSON.stringify(historical.structuredContent));
      assert.equal((historical.structuredContent?.evidence as Record<string, unknown>).sha1, versions[1]?.sha1);
      const historicalPath = (historical.structuredContent?.evidence as Record<string, unknown>).temp_path;
      if (typeof historicalPath === "string") tempPaths.push(historicalPath);
      const outOfRange = await server.tools.get("yfy_evidence_download")!({ file_id: fileId, version: { kind: "history", generations_back: versions.length } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
      assert.equal(outOfRange.isError, true);
    }
  } finally {
    for (const tempPath of tempPaths) fs.rmSync(tempPath, { force: true });
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
