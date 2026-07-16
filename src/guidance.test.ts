import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGuidance, SERVER_INSTRUCTIONS } from "./guidance.js";
import type { AppConfig } from "./types.js";

type ResourceHandler = (uri: URL) => Promise<{ contents: Array<{ text: string; uri: string }> }>;
type PromptHandler = (args: Record<string, unknown>) => { messages: Array<{ content: { text: string; type: string }; role: string }> };

class FakeGuidanceServer {
  readonly prompts = new Map<string, { config: Record<string, unknown>; handler: PromptHandler }>();
  readonly resources = new Map<string, { config: Record<string, unknown>; handler: ResourceHandler; uri: string }>();

  registerResource(name: string, uri: string, config: Record<string, unknown>, handler: ResourceHandler): void {
    this.resources.set(name, { config, handler, uri });
  }

  registerPrompt(name: string, config: Record<string, unknown>, handler: PromptHandler): void {
    this.prompts.set(name, { config, handler });
  }
}

function makeConfig(): AppConfig {
  return {
    apiBaseUrl: "https://open.fangcloud.com/api",
    allowDownloadUrl: false,
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    enterpriseId: 115,
    defaultUserId: 530,
    enableAdminTools: true,
    enableMutationTools: true,
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
    tokenRefreshSkewSeconds: 300
  };
}

test("SERVER_INSTRUCTIONS stays concise and action-oriented", () => {
  assert.match(SERVER_INSTRUCTIONS, /OpenAPI-first/);
  assert.match(SERVER_INSTRUCTIONS, /atomic tools/);
  assert.ok(SERVER_INSTRUCTIONS.length < 800);
});

test("registerGuidance exposes minimal prompts and resources", async () => {
  const server = new FakeGuidanceServer();
  registerGuidance(server as unknown as McpServer, makeConfig());

  assert.ok(server.resources.has("yfy_overview"));
  assert.ok(server.resources.has("yfy_workflows"));
  assert.ok(server.resources.has("yfy_safety"));
  assert.ok(server.prompts.has("yfy_find_and_lock_original"));
  assert.ok(server.prompts.has("yfy_snapshot_folder"));
  assert.ok(server.prompts.has("yfy_safe_upload_new_version"));

  const overview = server.resources.get("yfy_overview");
  assert.ok(overview);
  const resource = await overview.handler(new URL(overview.uri));
  assert.match(resource.contents[0].text, /mutation=enabled/);
  assert.match(resource.contents[0].text, /yfy_start_scope_scan/);

  const prompt = server.prompts.get("yfy_find_and_lock_original");
  assert.ok(prompt);
  const result = prompt.handler({ file_hint: "contract.docx", root_folder_id: 9 });
  assert.match(result.messages[0].content.text, /yfy_lock_current_original/);
  assert.match(result.messages[0].content.text, /durable scope scan/i);
});
