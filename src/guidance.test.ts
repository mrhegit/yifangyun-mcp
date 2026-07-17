import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGuidance, serverInstructions } from "./guidance.js";
import type { AppRuntime } from "./runtime/runtime.js";

type PromptHandler = (args: Record<string, string>) => Promise<unknown> | unknown;

class FakeGuidanceServer {
  readonly prompts = new Map<string, PromptHandler>();
  registerPrompt(name: string, _definition: unknown, handler: PromptHandler): void { this.prompts.set(name, handler); }
  registerResource(): void {}
}

test("tender prompt accepts MCP string arguments", async () => {
  const server = new FakeGuidanceServer();
  const runtime = { config: { toolsets: ["drive", "workspace", "inventory", "evidence"], workflowProfiles: ["tender"], authorityScopes: [{ id: "tender" }] } } as unknown as AppRuntime;
  registerGuidance(server as unknown as McpServer, runtime);
  const handler = server.prompts.get("yfy_tender_material_audit");
  assert.ok(handler);
  const result = await handler({ workspace: "tender", required_materials: "qualification certificate", max_item_depth: "5", max_items: "100" });
  assert.ok(result);
  assert.match(JSON.stringify(result), /Hard rules/);
  assert.match(JSON.stringify(result), /max_item_depth=5/);
  const compare = server.prompts.get("yfy_tender_compare_versions");
  assert.ok(compare);
  const comparison = await compare({ file: "file:501", workspace: "tender", expected_sha256: "a".repeat(64) });
  assert.match(JSON.stringify(comparison), /Workspace: tender/);
  assert.match(JSON.stringify(comparison), /yfy_capture/);
});

test("tender prompts are absent when the profile is not configured", () => {
  const server = new FakeGuidanceServer();
  const runtime = { config: { toolsets: ["drive"], workflowProfiles: [], authorityScopes: [] } } as unknown as AppRuntime;
  registerGuidance(server as unknown as McpServer, runtime);
  assert.equal(server.prompts.size, 0);
});

test("server instructions only recommend available and ready capabilities", () => {
  const evidenceOnly = { config: { toolsets: ["evidence"], workflowProfiles: [], authorityScopes: [] } } as unknown as AppRuntime;
  const instructions = serverInstructions(evidenceOnly);
  assert.doesNotMatch(instructions, /yfy_status|inventory|yfy_capture/);
  const ready = { config: { toolsets: ["drive", "inventory", "evidence"], workflowProfiles: [], authorityScopes: [{ id: "workspace" }] } } as unknown as AppRuntime;
  assert.match(serverInstructions(ready), /yfy_status/);
  assert.match(serverInstructions(ready), /inventory/);
  assert.match(serverInstructions(ready), /yfy_capture/);
});
