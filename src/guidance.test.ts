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
  const result = await handler({ workspace: "workspace:tender", required_materials: "qualification certificate", max_item_depth: "5", max_items: "100" });
  assert.ok(result);
  assert.match(JSON.stringify(result), /Hard rules/);
  assert.match(JSON.stringify(result), /limits=\{max_item_depth:5,max_items:100\}/);
  const compare = server.prompts.get("yfy_tender_compare_versions");
  assert.ok(compare);
  const comparison = await compare({ file: `file:501@default.${"a".repeat(24)}`, workspace: "workspace:tender", expected_sha256: "a".repeat(64) });
  assert.match(JSON.stringify(comparison), /Workspace: workspace:tender/);
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
  assert.match(instructions, /yfy_status/);
  assert.doesNotMatch(instructions, /inventory|yfy_capture/);
  const ready = { config: { toolsets: ["drive", "inventory", "evidence", "transfer"], workflowProfiles: [], authorityScopes: [{ id: "workspace" }] } } as unknown as AppRuntime;
  const readyInstructions = serverInstructions(ready);
  assert.match(readyInstructions, /ItemRef.*yfy_get/);
  assert.match(readyInstructions, /yfy_open/);
  assert.match(readyInstructions, /safe_to_claim_absence=true/);
  assert.match(readyInstructions, /agent_guidance/);
  assert.match(readyInstructions, /claim_allowed=true/);
  assert.match(readyInstructions, /content_delivery/);
  assert.match(readyInstructions, /must_release/);
  assert.match(readyInstructions, /yfy_capture/);
  assert.match(readyInstructions, /release every returned resource/i);
  assert.match(readyInstructions, /Do not use yfy_transfer_ticket_get/);
});
