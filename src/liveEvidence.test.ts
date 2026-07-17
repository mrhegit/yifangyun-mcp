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
  const rootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  assert.ok(rootFolderId, "YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID is required for authority-bound evidence testing.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-v1-evidence-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "core,evidence,authority";
  process.env.YFY_WORKFLOW_PROFILES = "";
  process.env.YFY_SCOPES_JSON = JSON.stringify([{ id: "evidence_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  const resourceUris: string[] = [];
  try {
    const handler = server.tools.get("yfy_evidence_capture")!;
    const result = await handler({ file_id: fileId, scope_id: "evidence_scope", version: { kind: "current" } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const artifact = result.structuredContent?.artifact as Record<string, unknown>;
    assert.match(String(artifact.sha256), /^[a-f0-9]{64}$/i);
    if (typeof artifact.resource_uri === "string") resourceUris.push(artifact.resource_uri);
    if (typeof artifact.local_path === "string") assert.equal(fs.statSync(artifact.local_path).size, artifact.size_bytes);
    const verified = await handler({ file_id: fileId, scope_id: "evidence_scope", version: { kind: "current" }, expected: { sha256: String(artifact.sha256), size_bytes: Number(artifact.size_bytes) } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(verified.isError, true, JSON.stringify(verified.structuredContent));
    assert.equal((verified.structuredContent?.expectation as Record<string, unknown>).matches, true);
    const verifiedArtifact = verified.structuredContent?.artifact as Record<string, unknown>;
    if (typeof verifiedArtifact?.resource_uri === "string") resourceUris.push(verifiedArtifact.resource_uri);
    const versionsHandler = server.tools.get("yfy_file_versions")!;
    const versionsResult = await versionsHandler({ file_id: fileId }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    const versions = versionsResult.structuredContent?.versions as Array<Record<string, unknown>>;
    if (process.env.YFY_LIVE_HISTORY_TESTS === "enabled" && versions.length > 1 && typeof versions[1]?.provider_version_id === "string") {
      const historical = await handler({ file_id: fileId, scope_id: "evidence_scope", version: { kind: "historical", version_id: versions[1].provider_version_id } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
      assert.notEqual(historical.isError, true, JSON.stringify(historical.structuredContent));
      const historicalArtifact = historical.structuredContent?.artifact as Record<string, unknown>;
      assert.equal(historicalArtifact.sha1, versions[1]?.sha1);
      if (typeof historicalArtifact.resource_uri === "string") resourceUris.push(historicalArtifact.resource_uri);
    }
  } finally {
    const release = server.tools.get("yfy_evidence_release");
    for (const resourceUri of resourceUris) await release?.({ resource_uri: resourceUri }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
