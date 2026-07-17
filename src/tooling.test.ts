import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "./client.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { registerCoreTools } from "./tools/coreTools.js";
import { registerSnapshotTools } from "./tools/snapshotTools.js";
import { registerTool, serializeError } from "./tools/tooling.js";

test("tool errors bypass successful output schema validation", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerTool(server, "failing_tool", {
    title: "Failing Tool",
    description: "Returns a structured tool error in text content.",
    inputSchema: {},
    outputSchema: { value: z.string() }
  }, { readOnly: true }, async () => {
    throw new YifangyunError("Expected failure.", { code: "YFY_EXPECTED_FAILURE", phase: "test" });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "failing_tool", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const content = result.content as Array<{ text?: string; type: string }>;
    const text = content.find((entry) => entry.type === "text");
    assert.equal(text?.type, "text");
    assert.equal(JSON.parse(typeof text?.text === "string" ? text.text : "{}").error.code, "YFY_EXPECTED_FAILURE");
  } finally {
    await client.close();
    await server.close();
  }
});

test("evidence integrity and Provider fallback errors use actionable categories", () => {
  assert.equal(serializeError(new YifangyunError("mismatch", { code: "YFY_EVIDENCE_CONTENT_MISMATCH" })).category, "conflict");
  assert.equal(serializeError(new YifangyunError("integrity", { code: "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED" })).category, "conflict");
  assert.equal(serializeError(new YifangyunError("fallback", { code: "YFY_DOWNLOAD_VERSION_FALLBACK_DETECTED" })).category, "provider_contract");
});

test("unexpected system errors do not expose local details", () => {
  const error = serializeError(new Error("EPERM unlink C:\\secret\\artifact.bin"));
  assert.equal(error.message, "Unexpected internal error.");
  assert.doesNotMatch(String(error.message), /secret|artifact/);
});

test("the MCP client accepts a running snapshot success result", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["snapshot"] },
    access: { resolveScope: () => ({ context: { id: "default" }, scope: { rootFolderId: "501" } }) },
    snapshots: {
      create: async () => ({ reused: false, state: {} }),
      summary: () => ({
        snapshot_id: "123e4567-e89b-12d3-a456-426614174000", status: "running", access_context: "default", root_folder_id: "501",
        scanned_file_count: 0, scanned_folder_count: 0, page_receipt_count: 0, completeness: {}, observation_window: {},
        created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z", expires_at: "2026-07-17T00:00:00.000Z",
        artifact_uri: "yfy://snapshot/test", suggested_action: "Monitor progress."
      })
    }
  } as unknown as AppRuntime;
  registerSnapshotTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool({ name: "yfy_snapshot_create", arguments: { scope_id: "tender" } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as Record<string, unknown>).status, "running");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the MCP client validates a paginated success result", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const runtime = {
    config: { maxPageCapacity: 500, toolsets: ["core"] },
    gateway: {
      context: () => ({ context: { id: "default" } }),
      getUser: async (endpoint: string) => ({
        data: { share_links: [{ id: 1 }], page_id: 0, page_capacity: 1, page_count: 2, total_count: 2, has_more: false },
        meta: { endpoint, fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }
      })
    }
  } as unknown as AppRuntime;
  registerCoreTools(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const result = await client.callTool({ name: "yfy_share_list", arguments: { item_type: "file", item_id: "1", page_id: 0, page_capacity: 1 } });
    assert.equal(result.isError, undefined);
    const page = (result.structuredContent as Record<string, unknown>).page as Record<string, unknown>;
    assert.deepEqual(page.requested, { page_id: 0, page_capacity: 1 });
    assert.deepEqual(page.effective, { page_id: 0, page_capacity: 1, page_capacity_source: "provider" });
    assert.equal(page.has_more, true);
    assert.equal(page.next_page_id, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
