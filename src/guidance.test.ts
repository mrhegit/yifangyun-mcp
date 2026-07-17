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
  const runtime = { config: { toolsets: ["core", "organization", "authority", "snapshot", "evidence"], workflowProfiles: ["tender"], authorityScopes: [{ id: "tender" }] } } as unknown as AppRuntime;
  registerGuidance(server as unknown as McpServer, runtime);
  const handler = server.prompts.get("yfy_tender_material_audit");
  assert.ok(handler);
  const result = await handler({ scope_id: "tender", required_materials: "证书", max_depth: "5", max_items: "100" });
  assert.ok(result);
});

test("tender prompts are absent when the profile is not configured", () => {
  const server = new FakeGuidanceServer();
  const runtime = { config: { toolsets: ["core"], workflowProfiles: [], authorityScopes: [] } } as unknown as AppRuntime;
  registerGuidance(server as unknown as McpServer, runtime);
  assert.equal(server.prompts.size, 0);
});

test("server instructions only recommend available and ready capabilities", () => {
  const evidenceOnly = { config: { toolsets: ["evidence"], workflowProfiles: [], authorityScopes: [] } } as unknown as AppRuntime;
  const instructions = serverInstructions(evidenceOnly);
  assert.doesNotMatch(instructions, /yfy_context_get|snapshot|yfy_evidence_lock_current/);
  const ready = { config: { toolsets: ["core", "snapshot", "evidence"], workflowProfiles: [], authorityScopes: [{ id: "scope" }] } } as unknown as AppRuntime;
  assert.match(serverInstructions(ready), /yfy_context_get/);
  assert.match(serverInstructions(ready), /snapshots/);
  assert.match(serverInstructions(ready), /yfy_evidence_lock_current/);
});
