import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";
import { formatItemRef } from "./domain/refs.js";

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

test("live download tools stage a controlled file with hash", { skip: process.env.YFY_LIVE_DOWNLOAD_TESTS !== "enabled" }, async () => {
  const envPath = process.env.YFY_LIVE_ENV_PATH ?? path.resolve(process.cwd(), ".env");
  assert.ok(fs.existsSync(envPath), `Live env file not found: ${envPath}`);
  loadDotEnv(envPath);
  const fileId = process.env.YFY_LIVE_DOWNLOAD_FILE_ID;
  assert.ok(fileId, "YFY_LIVE_DOWNLOAD_FILE_ID is required for live download testing.");
  const rootFolderId = process.env.YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID;
  assert.ok(rootFolderId, "YFY_LIVE_DOWNLOAD_ROOT_FOLDER_ID is required for workspace-bound download testing.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yfy-download-"));
  process.env.YFY_STATE_DB = path.join(dir, "state.sqlite");
  process.env.YFY_TOOLSETS = "drive,workspace";
  process.env.YFY_WORKFLOW_PROFILES = "";
  process.env.YFY_WORKSPACES_JSON = JSON.stringify([{ id: "download_scope", root_folder_id: rootFolderId, access_context: "default", tags: ["live-test"] }]);
  process.env.YFY_DOWNLOAD_EXPOSE_LOCAL_PATH = "true";
  const runtime = await AppRuntime.create(loadConfig());
  const server = new FakeServer();
  registerCatalog(server as unknown as McpServer, runtime);
  const downloadIds: string[] = [];
  try {
    const access = runtime.access.resolveContext("default");
    const fileRef = formatItemRef("file", fileId, access.context.id, access.identityRef);
    const handler = server.tools.get("yfy_download")!;
    const result = await handler({ file: fileRef, workspace: "workspace:download_scope" }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    const download = result.structuredContent?.download as Record<string, unknown>;
    assert.match(String(download.sha256), /^[a-f0-9]{64}$/i);
    assert.equal(typeof download.local_path, "string");
    assert.ok(fs.existsSync(String(download.local_path)));
    if (typeof download.download_id === "string") downloadIds.push(download.download_id);
    const verified = await handler({ file: fileRef, workspace: "workspace:download_scope", expected: { sha256: String(download.sha256), size_bytes: Number(download.size_bytes) } }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    assert.notEqual(verified.isError, true, JSON.stringify(verified.structuredContent));
    const verifiedDownload = verified.structuredContent?.download as Record<string, unknown>;
    if (typeof verifiedDownload?.download_id === "string") downloadIds.push(verifiedDownload.download_id);
    const versionsHandler = server.tools.get("yfy_versions")!;
    const versionsResult = await versionsHandler({ file: fileRef }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    const versions = versionsResult.structuredContent?.versions as Array<Record<string, unknown>>;
    if (process.env.YFY_LIVE_HISTORY_TESTS === "enabled" && versions.length > 1 && typeof versions[1]?.ref === "string") {
      const historical = await handler({ file: fileRef, workspace: "workspace:download_scope", version: versions[1].ref }, { signal: new AbortController().signal, sendNotification: async () => undefined });
      assert.notEqual(historical.isError, true, JSON.stringify(historical.structuredContent));
      const historicalDownload = historical.structuredContent?.download as Record<string, unknown>;
      assert.equal(historicalDownload.sha1, versions[1]?.sha1);
      if (typeof historicalDownload.download_id === "string") downloadIds.push(historicalDownload.download_id);
    }
  } finally {
    const release = server.tools.get("yfy_download_release");
    for (const downloadId of downloadIds) await release?.({ download_id: downloadId }, { signal: new AbortController().signal, sendNotification: async () => undefined });
    await runtime.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
