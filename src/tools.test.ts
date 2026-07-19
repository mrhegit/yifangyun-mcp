import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { YifangyunError } from "./client.js";
import { provenance } from "./domain/projectors.js";
import { formatItemRef, formatVersionRef, parseItemRef } from "./domain/refs.js";
import type { AppRuntime } from "./runtime/runtime.js";
import { DownloadRegistry } from "./runtime/downloads.js";
import { TempStorageManager } from "./runtime/tempStorage.js";
import { registerAdminTools } from "./tools/adminTools.js";
import { normalizedMediaType, registerWorkspaceTools } from "./tools/workspaceTools.js";
import { registerDownloadTools } from "./tools/downloadTools.js";
import { registerDriveTools } from "./tools/driveTools.js";
import { registerMutationTools } from "./tools/mutationTools.js";
import { registerInventoryTools } from "./tools/inventoryTools.js";
import { registerOrganizationTools } from "./tools/organizationTools.js";
import { registerTransferTools } from "./tools/transferTools.js";
import type { ApiJsonResponse, JsonValue } from "./types.js";

type ToolResult = { content?: Array<{ resource?: { mimeType?: string; text?: string; uri?: string }; text?: string; type: string; uri?: string; mimeType?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra: { _meta?: { progressToken?: string | number }; signal: AbortSignal; sendNotification: (notification?: unknown) => Promise<void> }) => Promise<ToolResult>;
type ResourceHandler = (uri: URL, variables: Record<string, string>) => Promise<{ contents: Array<{ text?: string }> }>;
class FakeServer {
  readonly tools = new Map<string, Handler>();
  readonly resources = new Map<string, ResourceHandler>();
  registerTool(name: string, _definition: unknown, handler: Handler): void { this.tools.set(name, handler); }
  registerResource(name: string, _template: unknown, _definition: unknown, handler: ResourceHandler): void { this.resources.set(name, handler); }
  registerPrompt(): void {}
}

function response(endpoint: string, data: JsonValue): ApiJsonResponse {
  return { data, meta: { endpoint, fetchedAtIso: new Date().toISOString(), fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 } };
}

function downloadHarness(root: string, ttlSeconds = 60, maxBytes = 1_048_576) {
  const tempStorage = new TempStorageManager(root, maxBytes, ttlSeconds);
  return { downloads: new DownloadRegistry(tempStorage, ttlSeconds), tempStorage };
}

function contentHashes(body: string | Buffer) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    sha1: crypto.createHash("sha1").update(bytes).digest("hex"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length
  };
}

function access() {
  return { context: { id: "default", userId: "530" }, identityRef: IDENTITY_REF };
}

function scopedAccess() {
  return { ...access(), scope: { id: "scope", rootFolderId: "501", accessContext: "default", tags: [] } };
}

const IDENTITY_REF = "a".repeat(24);
const FILE_1 = formatItemRef("file", "1", "default", IDENTITY_REF);
const FILE_2 = formatItemRef("file", "2", "default", IDENTITY_REF);
const FILE_10 = formatItemRef("file", "10", "default", IDENTITY_REF);
const FOLDER_1 = formatItemRef("folder", "1", "default", IDENTITY_REF);
const FOLDER_10 = formatItemRef("folder", "10", "default", IDENTITY_REF);
const WORKSPACE_SCOPE = "workspace:scope";
const WORKSPACE_TENDER = "workspace:tender";
const VERSION_10_7 = formatVersionRef(FILE_10, "7");
const WORKSPACE_FINGERPRINT = "b".repeat(64);

async function call(server: FakeServer, name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
  const handler = server.tools.get(name)!;
  return handler(args, { signal, sendNotification: async () => undefined });
}

function errorCode(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  return ((JSON.parse(text) as { error?: { code?: string } }).error?.code);
}

function errorCategory(result: ToolResult): string | undefined {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  return ((JSON.parse(text) as { error?: { category?: string } }).error?.category);
}

test("provenance exposes a logical operation without transport paths", () => {
  const value = provenance({ endpoint: "https://download.example/secret/path?token=value", fetchedAtIso: "2026-07-16T00:00:00.000Z", fetchedAtUnix: 1, sourceApiVersion: "v2", statusCode: 200 }, "private-context", "content_download");
  assert.deepEqual(value, { source: "yifangyun_openapi", operation: "content_download", observed_at: "2026-07-16T00:00:00.000Z" });
  assert.doesNotMatch(JSON.stringify(value), /download\.example|secret\/path|private-context/);
});

test("Office media types are normalized for MCP clients", () => {
  assert.equal(normalizedMediaType("application/excel", undefined), "application/vnd.ms-excel");
  assert.equal(normalizedMediaType("application/powerpoint; charset=binary", undefined), "application/vnd.ms-powerpoint");
  assert.equal(normalizedMediaType("application/octet-stream", "application/pdf"), "application/pdf");
  assert.equal(normalizedMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(normalizedMediaType("application/octet-stream", "application/zip", "workbook.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(normalizedMediaType("application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip", "slides.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
});

test("media type falls back from magic sniff then file extension including svg", () => {
  assert.equal(normalizedMediaType("application/octet-stream", undefined, "diagram.svg"), "image/svg+xml");
  assert.equal(normalizedMediaType(undefined, undefined, "notes.md"), "text/markdown");
  assert.equal(normalizedMediaType(undefined, undefined, "rows.csv"), "text/csv");
  assert.equal(normalizedMediaType(undefined, "image/svg+xml", "ignored.bin"), "image/svg+xml");
  assert.equal(normalizedMediaType("text/plain", "application/pdf", "mislabelled.txt"), "application/pdf");
  assert.equal(normalizedMediaType("text/plain", "application/json", "data.json"), "text/plain");
  assert.equal(normalizedMediaType("application/octet-stream", undefined, "blob.bin"), "application/octet-stream");
});

test("context-bound refs reject unbound numeric IDs and preserve identity", () => {
  assert.deepEqual(parseItemRef(FILE_10), { type: "file", id: "10", accessContextId: "default", identityRef: IDENTITY_REF });
  assert.throws(() => parseItemRef("file:10"), /Item reference is invalid/);
});

test("stale item refs are reported as recoverable stale state", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"] },
    gateway: { context: () => ({ context: { id: "default", userId: "530" }, identityRef: "b".repeat(24) }) }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_get", { ref: FILE_10 });
  assert.equal(errorCode(result), "YFY_REF_IDENTITY_MISMATCH");
  assert.equal(errorCategory(result), "stale_state");
});

test("drive search hides Provider pagination behind one cursor", async () => {
  const server = new FakeServer();
  const files = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `candidate-${index + 1}.pdf`, type: "file", owned_by: { id: 9, name: "Owner", login: "secret" } }));
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files, folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3 })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_search", { query: "candidate", in: "personal", limit: 2 });
  const coverage = first.structuredContent?.coverage as Record<string, unknown>;
  assert.equal(coverage.mode, "provider_index");
  assert.equal(coverage.exhaustive, false);
  assert.equal(coverage.agent_must_read, true);
  assert.equal(coverage.does_not_prove_current_existence, true);
  assert.equal(coverage.does_not_prove_absence, true);
  assert.deepEqual(coverage.counts, {
    provider_raw: 3,
    returned: 2,
    returned_verified: 2,
    returned_unverified: 0,
    verified_hits: 3,
    unverified_index_hits: 0,
    scope_rejected: 0,
    disambiguation_groups: 0,
    filtered_out_reason_counts: {
      exact_name_mismatch: 0,
      scope_rejected: 0,
      malformed_item: 0,
      unverified_omitted_by_default: 0,
      unverified_omitted_by_explicit_request: 0
    }
  });
  assert.equal(first.structuredContent?.selection_policy, "must_disambiguate");
  assert.equal(typeof coverage.note, "string");
  assert.ok(((first.structuredContent?.agent_warnings as string[]) ?? []).some((warning) => /non-exhaustive|candidates only/i.test(warning)));
  assert.equal((first.structuredContent?.hits as unknown[]).length, 2);
  assert.deepEqual(first.structuredContent?.unverified_hits, []);
  assert.equal((((first.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>).claim_allowed), true);
  assert.equal((((first.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>).trust), "locally_verified");
  const page = first.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.returned_count, 2);
  assert.equal(page.has_more, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(page, "page_id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(page, "page_capacity"));
  const cursor = String(page.next_cursor);
  const second = await call(server, "yfy_search", { cursor });
  assert.deepEqual((second.structuredContent?.hits as Array<Record<string, unknown>>).map((hit) => (hit.item as Record<string, unknown>).ref), [formatItemRef("file", "3", "default", IDENTITY_REF)]);
  assert.doesNotMatch(JSON.stringify(first.structuredContent), /login|secret/);
  const standard = await call(server, "yfy_search", { query: "candidate", in: "personal", detail: "standard" });
  assert.equal((((standard.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).owned_by as Record<string, unknown>).name, "Owner");
});

test("drive search continues after an empty filtered Provider page", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => Number(params.page_id ?? 0) === 0
        ? response(endpoint, { files: [{ id: 1, name: "other.pdf", type: "file" }], folders: [], page_id: 0, next_page_id: 1, page_capacity: 50, page_count: 2, total_count: 2 })
        : response(endpoint, { files: [{ id: 2, name: "target.pdf", type: "file" }], folders: [] })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_search", { query: "target.pdf", in: "personal", field: "name", exact_name: true });
  assert.equal(first.structuredContent?.selection_policy, "continue_search");
  assert.equal((first.structuredContent?.page as Record<string, unknown>).has_more, true);
  assert.match(((first.structuredContent?.recommended_actions as string[]) ?? []).join(" "), /execute next_action/i);
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);
  const second = await call(server, "yfy_search", { cursor });
  assert.equal(second.structuredContent?.selection_policy, "single_candidate_ok");
  assert.equal((((second.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), FILE_2);
});

test("content search defaults to unverified candidates but honors explicit false", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, {
        files: [{ id: 1, name: "document.pdf", type: "file", snippet: "contains target phrase" }],
        folders: [], page_id: 0, page_capacity: 50, page_count: 1, total_count: 1
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const defaults = await call(server, "yfy_search", { query: "target", field: "content", in: "personal" });
  assert.equal((defaults.structuredContent?.unverified_hits as unknown[]).length, 1);
  assert.equal((defaults.structuredContent?.content_search_policy as Record<string, unknown>).include_unverified_index_hits_effective, true);
  const omitted = await call(server, "yfy_search", { query: "target", field: "content", in: "personal", include_unverified_index_hits: false });
  assert.equal((omitted.structuredContent?.unverified_hits as unknown[]).length, 0);
  assert.equal((omitted.structuredContent?.content_search_policy as Record<string, unknown>).include_unverified_index_hits_effective, false);
  const omittedCounts = (((omitted.structuredContent?.coverage as Record<string, unknown>).counts as Record<string, unknown>).filtered_out_reason_counts as Record<string, unknown>);
  assert.equal(omittedCounts.unverified_omitted_by_default, 0);
  assert.equal(omittedCounts.unverified_omitted_by_explicit_request, 1);
});

test("drive search keeps must_disambiguate after candidates appear on different Provider pages", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => Number(params.page_id ?? 0) === 0
        ? response(endpoint, { files: [{ id: 1, name: "target-a.pdf", type: "file" }], folders: [], page_id: 0, next_page_id: 1, page_count: 2, total_count: 2 })
        : response(endpoint, { files: [{ id: 2, name: "target-b.pdf", type: "file" }], folders: [] })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_search", { query: "target", in: "personal" });
  assert.equal(first.structuredContent?.selection_policy, "must_disambiguate");
  const second = await call(server, "yfy_search", { cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal(second.structuredContent?.selection_policy, "must_disambiguate");
});

test("drive search preserves cumulative selection policy when the final Provider page is empty", async () => {
  for (const candidateCount of [1, 2]) {
    const server = new FakeServer();
    const runtime = {
      config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
      gateway: {
        context: access,
        getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => Number(params.page_id ?? 0) === 0
          ? response(endpoint, { files: Array.from({ length: candidateCount }, (_, index) => ({ id: index + 1, name: `target-${index + 1}.pdf`, type: "file" })), folders: [], page_id: 0, page_count: 2, next_page_id: 1 })
          : response(endpoint, { files: [], folders: [] })
      }
    } as unknown as AppRuntime;
    registerDriveTools(server as unknown as McpServer, runtime);
    const first = await call(server, "yfy_search", { query: "target", in: "personal" });
    const second = await call(server, "yfy_search", { cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) });
    assert.notEqual(second.isError, true, JSON.stringify(second.content));
    assert.equal(second.structuredContent?.selection_policy, candidateCount === 1 ? "single_candidate_ok" : "must_disambiguate");
  }
});

test("drive search excludes provider_index_only hits by default", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, {
        files: [
          { id: 1, name: "unrelated-a.pdf", type: "file" },
          { id: 2, name: "candidate-match.pdf", type: "file" },
          { id: 3, name: "unrelated-b.pdf", type: "file", snippet: "no useful text" }
        ],
        folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_search", { query: "candidate", in: "personal", limit: 10 });
  const hits = result.structuredContent?.hits as Array<Record<string, unknown>>;
  assert.equal(hits.length, 1);
  assert.equal((hits[0]?.item as Record<string, unknown>).ref, FILE_2);
  assert.equal((hits[0]?.match as Record<string, unknown>).claim_allowed, true);
  assert.deepEqual(result.structuredContent?.unverified_hits, []);
  const counts = (result.structuredContent?.coverage as Record<string, unknown>).counts as Record<string, unknown>;
  assert.equal(counts.provider_raw, 3);
  assert.equal(counts.verified_hits, 1);
  assert.equal(counts.unverified_index_hits, 2);
  assert.equal(counts.returned, 1);

  const included = await call(server, "yfy_search", { query: "candidate", in: "personal", include_unverified_index_hits: true, limit: 10 });
  assert.equal((included.structuredContent?.hits as unknown[]).length, 1);
  const unverified = included.structuredContent?.unverified_hits as Array<Record<string, unknown>>;
  assert.equal(unverified.length, 2);
  assert.equal((unverified[0]?.match as Record<string, unknown>).claim_allowed, false);
  assert.equal((unverified[0]?.match as Record<string, unknown>).trust, "unverified_index_hit");

  const orderedFirst = await call(server, "yfy_search", { query: "candidate", in: "personal", include_unverified_index_hits: true, limit: 1 });
  assert.equal((orderedFirst.structuredContent?.hits as unknown[]).length, 0);
  assert.equal((((orderedFirst.structuredContent?.unverified_hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), FILE_1);
  const orderedSecond = await call(server, "yfy_search", { cursor: String((orderedFirst.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal((((orderedSecond.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), FILE_2);
  const orderedThird = await call(server, "yfy_search", { cursor: String((orderedSecond.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal((((orderedThird.structuredContent?.unverified_hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), formatItemRef("file", "3", "default", IDENTITY_REF));
});

test("drive search marks same-name hits for disambiguation", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, {
        files: [
          { id: 1, name: "招标公告.pdf", type: "file", parent_folder_id: 10 },
          { id: 2, name: "招标公告.pdf", type: "file", parent_folder_id: 20 },
          { id: 3, name: "other.pdf", type: "file" }
        ],
        folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_search", { query: "招标公告.pdf", in: "personal", field: "name", exact_name: true, limit: 10 });
  const hits = result.structuredContent?.hits as Array<Record<string, unknown>>;
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    const match = hit.match as Record<string, unknown>;
    assert.equal(match.disambiguation_required, true);
    assert.equal(match.same_name_hit_count_in_provider_page, 2);
    assert.deepEqual(match.uniqueness, { status: "multiple_in_provider_page", basis: "non_exhaustive_provider_search" });
    assert.equal(match.claim_allowed, true);
  }
  assert.equal(((result.structuredContent?.coverage as Record<string, unknown>).counts as Record<string, unknown>).disambiguation_groups, 1);
  assert.equal(result.structuredContent?.selection_policy, "must_disambiguate");
  assert.ok(((result.structuredContent?.recommended_actions as string[]) ?? []).some((item) => /must_disambiguate|path uniqueness/i.test(item)));
});

test("drive search preserves disambiguation and total limits across verified and unverified continuation", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, {
        files: [
          { id: 1, name: "same.pdf", type: "file" },
          { id: 2, name: "same.pdf", type: "file" },
          { id: 3, name: "unrelated.pdf", type: "file" }
        ],
        folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);

  const first = await call(server, "yfy_search", { query: "same", in: "personal", field: "all", include_unverified_index_hits: true, limit: 1 });
  const firstHit = ((first.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>);
  assert.equal(firstHit.disambiguation_required, true);
  assert.equal(firstHit.same_name_hit_count_in_provider_page, 2);
  assert.equal((first.structuredContent?.page as Record<string, unknown>).returned_count, 1);

  const second = await call(server, "yfy_search", { cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal((second.structuredContent?.page as Record<string, unknown>).returned_count, 1);
  assert.equal((((second.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>).disambiguation_required), true);

  const third = await call(server, "yfy_search", { cursor: String((second.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal((third.structuredContent?.hits as unknown[]).length, 0);
  assert.equal((third.structuredContent?.unverified_hits as unknown[]).length, 1);
  assert.equal((third.structuredContent?.page as Record<string, unknown>).returned_count, 1);
  assert.equal((third.structuredContent?.page as Record<string, unknown>).has_more, false);
});

test("ordinary cursors are invalid after the effective configuration changes", async () => {
  const firstServer = new FakeServer();
  const firstRuntime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    configFingerprint: "a".repeat(64),
    gateway: { context: access, getUser: async (endpoint: string) => response(endpoint, { files: [{ id: 1, name: "one.pdf", type: "file" }, { id: 2, name: "two.pdf", type: "file" }], folders: [], page_id: 0, page_capacity: 50, page_count: 1, total_count: 2 }) }
  } as unknown as AppRuntime;
  registerDriveTools(firstServer as unknown as McpServer, firstRuntime);
  const first = await call(firstServer, "yfy_browse", { at: "personal", limit: 1 });
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);

  const secondServer = new FakeServer();
  const secondRuntime = {
    ...firstRuntime,
    configFingerprint: "b".repeat(64),
    gateway: { context: access, getUser: async () => { throw new Error("stale cursor must fail before Provider I/O"); } }
  } as unknown as AppRuntime;
  registerDriveTools(secondServer as unknown as McpServer, secondRuntime);
  const continued = await call(secondServer, "yfy_browse", { cursor });
  assert.equal(errorCode(continued), "YFY_CURSOR_INVALID");
  const errorText = JSON.stringify(continued.content);
  assert.match(errorText, /Cursor is invalid or expired\./);
  assert.doesNotMatch(errorText, /Invalid cursor:/);
  assert.doesNotMatch(errorText, /envelope is invalid|signature is invalid|not unpadded|not canonical/);
});

test("admin log pagination counts user activity rows", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["admin"] },
    configFingerprint: "a".repeat(64),
    gateway: {
      postEnterprise: async (endpoint: string) => response(endpoint, { user_activities: [{ id: 1 }, { id: 2 }], page_id: 0, page_capacity: 2, page_count: 2, total_count: 4 })
    }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_admin_log_query", { action: "list", start_date: "2026-07-01", end_date: "2026-07-02", limit: 2 });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.returned_count, 2);
  assert.equal(page.has_more, true);
  const nextArguments = ((result.structuredContent?.next_action as Record<string, unknown>).arguments as Record<string, unknown>);
  assert.equal(nextArguments.action, "list");
  const mixed = await call(server, "yfy_admin_log_query", { ...nextArguments, limit: 1 });
  const mixedError = JSON.parse(mixed.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(mixedError.error?.diagnostics?.reason, "pagination_mixed_args");
  assert.deepEqual(mixedError.error?.diagnostics?.unexpected_keys, ["limit"]);
});

test("admin log pagination uses the capacity actually sent to Provider", async () => {
  const server = new FakeServer();
  let providerBody!: Record<string, unknown>;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 2, toolsets: ["admin"] },
    configFingerprint: "a".repeat(64),
    gateway: {
      postEnterprise: async (endpoint: string, body: Record<string, unknown>) => {
        providerBody = body;
        return response(endpoint, { user_activities: [{ id: 1 }, { id: 2 }] });
      }
    }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_admin_log_query", { action: "list", start_date: "2026-07-01", end_date: "2026-07-02", limit: 100 });
  assert.equal(providerBody.page_capacity, 2);
  assert.equal((result.structuredContent?.page as Record<string, unknown>).has_more, true);
});

test("admin list tools enforce local limit when Provider ignores page capacity", async () => {
  const server = new FakeServer();
  let providerParams!: Record<string, unknown>;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["admin"] },
    configFingerprint: "a".repeat(64),
    gateway: {
      getEnterprise: async (endpoint: string, params: Record<string, unknown>) => {
        providerParams = params;
        return response(endpoint, { groups: [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }] });
      }
    }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_admin_group_read", { action: "list", limit: 1 });
  assert.equal((first.structuredContent?.groups as unknown[]).length, 1);
  assert.equal((first.structuredContent?.page as Record<string, unknown>).returned_count, 1);
  assert.equal(providerParams.page_capacity, undefined);
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);
  const second = await call(server, "yfy_admin_group_read", { action: "list", cursor });
  assert.equal((((second.structuredContent?.groups as Array<Record<string, unknown>>)[0]?.name)), "B");
});

test("admin lists without pagination metadata continue to an empty page", async () => {
  const cases = [
    { action: "list", endpoint: "/v2/admin/group/list", firstKey: "groups", toolArgs: { action: "list", limit: 100 } },
    { action: "users", endpoint: "/v2/admin/group/7/users", firstKey: "users", toolArgs: { action: "users", group_id: "7", limit: 100 } },
    { action: "users", endpoint: "/v2/admin/department/8/users", firstKey: "users", toolArgs: { action: "users", department_id: "8", limit: 100 } }
  ] as const;
  for (const item of cases) {
    const server = new FakeServer();
    const runtime = {
      config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["admin"] },
      configFingerprint: "a".repeat(64),
      gateway: {
        getEnterprise: async (endpoint: string, params: Record<string, unknown>) => {
          assert.equal(endpoint, item.endpoint);
          const pageId = Number(params.page_id ?? 0);
          return response(endpoint, pageId === 0 ? { [item.firstKey]: [{ id: 1, name: "A" }] } : pageId === 1 ? { [item.firstKey]: [{ id: 2, name: "B" }] } : { [item.firstKey]: [] });
        }
      }
    } as unknown as AppRuntime;
    registerAdminTools(server as unknown as McpServer, runtime);
    const tool = item.endpoint.includes("department") ? "yfy_admin_department_read" : "yfy_admin_group_read";
    const first = await call(server, tool, item.toolArgs);
    assert.equal((first.structuredContent?.page as Record<string, unknown>).has_more, true);
    const second = await call(server, tool, { action: item.action, cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) });
    assert.equal((second.structuredContent?.page as Record<string, unknown>).has_more, true);
    const third = await call(server, tool, { action: item.action, cursor: String((second.structuredContent?.page as Record<string, unknown>).next_cursor) });
    assert.equal((third.structuredContent?.page as Record<string, unknown>).has_more, false);
  }
});

test("admin pagination rejects a repeated Provider page", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["admin"] },
    configFingerprint: "a".repeat(64),
    gateway: { getEnterprise: async (endpoint: string) => response(endpoint, { groups: [{ id: 1, name: "same" }] }) }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const first = await call(server, "yfy_admin_group_read", { action: "list", limit: 100 });
  const second = await call(server, "yfy_admin_group_read", { action: "list", cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) });
  assert.equal(errorCode(second), "YFY_PROVIDER_PAGINATION_STALLED");
  assert.equal(errorCategory(second), "provider_contract");
});

test("admin action validators reject fields that would be ignored", async () => {
  const server = new FakeServer();
  let providerCalled = false;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["admin"] },
    gateway: {
      getEnterprise: async () => { providerCalled = true; return response("/unexpected", {}); },
      postEnterprise: async () => { providerCalled = true; return response("/unexpected", {}); }
    }
  } as unknown as AppRuntime;
  registerAdminTools(server as unknown as McpServer, runtime);
  const group = await call(server, "yfy_admin_group_read", { action: "get", group_id: "1", query: "ignored" });
  assert.equal(errorCode(group), "YFY_INPUT_INVALID");
  const logs = await call(server, "yfy_admin_log_query", { action: "list", start_date: "2026-07-01", end_date: "2026-07-02", date: "2026-07-01" });
  assert.equal(errorCode(logs), "YFY_INPUT_INVALID");
  assert.equal(providerCalled, false);
});

test("drive search enforces folder scope and exact names", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/info") ? response(endpoint, { id: 10, name: "Target", type: "folder", space: { type: "personal" } }) : response(endpoint, {
        files: [
          { id: 1, name: "test.docx", type: "file", parent_folder_id: 10, path: [{ id: 10, name: "Target", type: "folder" }] },
          { id: 2, name: "test-copy.docx", type: "file", parent_folder_id: 10, path: [{ id: 10, name: "Target", type: "folder" }] },
          { id: 3, name: "test.docx", type: "file", parent_folder_id: 20, path: [{ id: 20, name: "Other", type: "folder" }] }
        ],
        folders: [], page_id: 0, page_capacity: 100, page_count: 1, total_count: 3
      })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_search", { query: "test.docx", in: FOLDER_10, kind: "file", field: "name", exact_name: true, limit: 5 });
  const item = ((result.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>);
  assert.equal(item.ref, FILE_1);
  assert.equal(item.path_basis, "provider_supplied");
  assert.equal(item.path_chain, undefined);
  assert.deepEqual((item.provider_path_chain as Array<Record<string, unknown>>).map((entry) => entry.id), ["10"]);
});

test("drive resolve returns ambiguous candidates instead of guessing", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { files: [{ id: 1, name: "same.pdf", type: "file" }, { id: 2, name: "same.pdf", type: "file" }], folders: [], page_id: 0, page_capacity: 500, page_count: 1 })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_resolve", { path: "same.pdf", from: "personal" });
  const outcome = result.structuredContent?.outcome as Record<string, unknown>;
  assert.equal(outcome.status, "ambiguous");
  assert.deepEqual((outcome.candidates as Array<Record<string, unknown>>).map((item) => item.ref), [FILE_1, FILE_2]);
});

test("drive batch reads preserve successes when one Provider request fails", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.includes("/2/")
        ? Promise.reject(new YifangyunError("missing", { code: "YFY_FILE_NOT_FOUND", statusCode: 404 }))
        : response(endpoint, { id: 1, name: "ok.pdf", type: "file" })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_get_many", { refs: [FILE_1, FILE_2], detail: "basic" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.summary, { requested_count: 2, success_count: 1, error_count: 1 });
  const results = result.structuredContent?.results as Array<Record<string, unknown>>;
  assert.equal(results[0]?.status, "success");
  assert.equal(results[1]?.status, "error");
  assert.equal((results[1]?.error as Record<string, unknown>).category, "not_found");
});

test("current file versions omit historical VersionRef values", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["drive"] },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => response(endpoint, { file_versions: [
        { current: true, sha1: "a".repeat(40), size: 9, modified_at: 2 },
        { id: 7, current: false, sha1: "b".repeat(40), size: 8, modified_at: 1 },
        { current: false, sha1: "c".repeat(40), size: 7, modified_at: 0 }
      ] })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_versions", { file: FILE_10 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const versions = result.structuredContent?.versions as Array<Record<string, unknown>>;
  assert.equal(versions[0]?.current, true);
  assert.equal(versions[0]?.ref, null);
  assert.ok(Object.prototype.hasOwnProperty.call(versions[0], "ref"));
  assert.deepEqual(versions[0]?.usage, {
    for_download: "omit_version_parameter",
    note: "Current version: omit the version parameter on yfy_download."
  });
  assert.equal(versions[1]?.ref, VERSION_10_7);
  assert.deepEqual(versions[1]?.usage, {
    for_download: "pass_version_ref",
    note: "Historical version: pass this ref as the version parameter on yfy_download."
  });
  assert.equal(versions[2]?.download_ready, false);
  assert.equal(versions[2]?.ref, null);
  assert.deepEqual(versions[2]?.usage, {
    for_download: "unavailable",
    note: "Historical version lacks a Provider version ID and cannot be selected safely."
  });
  assert.deepEqual(result.structuredContent?.version_selection_rules, {
    current: "Omit the version parameter on yfy_download for the current version. Do not invent a version ref.",
    historical: "Copy the historical version ref from this result and pass it as the version parameter on yfy_download."
  });
});

test("workspace membership distinguishes query and assert semantics", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.includes("/folder/501/info")
      ? response(endpoint, { id: 501, name: "Root", type: "folder", space: { id: 1, type: "department" } })
      : response(endpoint, { id: 10, name: "outside.pdf", type: "file", parent_folder_id: 2, path: [{ id: 2, name: "Other", type: "folder" }], space: { id: 2, type: "department" } }) }
  } as unknown as AppRuntime;
  registerWorkspaceTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "outside");
  assert.equal(query.structuredContent?.path_basis, "configured_workspace_root");
  assert.deepEqual(query.structuredContent?.relative_ancestor_chain, []);
  assert.equal((query.structuredContent?.file as Record<string, unknown>).path_basis, "provider_supplied");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "different_space_id");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, true);
  assert.equal(interpretation.may_download, false);
  assert.deepEqual((query.structuredContent?.diagnostics as Record<string, unknown>).observed_file_space, { id: "2", type: "department" });
  assert.deepEqual((query.structuredContent?.diagnostics as Record<string, unknown>).observed_root_space, { id: "1", type: "department" });
  assert.equal(query.isError, undefined);
  const assertion = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "assert" });
  assert.equal(assertion.isError, true);
  assert.equal(errorCode(assertion), "YFY_WORKSPACE_MEMBERSHIP_FAILED");
  assert.equal(errorCategory(assertion), "authorization");
  const diagnostics = JSON.parse(assertion.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(diagnostics.error?.diagnostics?.reason, "different_space_id");
  assert.equal((diagnostics.error?.diagnostics?.agent_interpretation as Record<string, unknown> | undefined)?.may_download, false);
});

test("workspace membership marks different space types as outside", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.includes("/folder/501/info")
      ? response(endpoint, { id: 501, name: "Root", type: "folder", space: { type: "department" } })
      : response(endpoint, { id: 10, name: "personal.svg", type: "file", parent_folder_id: 0, space: { type: "personal" } }) }
  } as unknown as AppRuntime;
  registerWorkspaceTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "outside");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "different_space_type");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_outside, true);
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_download, false);
});

test("workspace membership reports unavailable when ancestry is incomplete", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => response(endpoint, { id: 10, name: "unknown.pdf", type: "file", parent_folder_id: 2 }) }
  } as unknown as AppRuntime;
  registerWorkspaceTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "unavailable");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "missing_ancestor_chain");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, false);
  assert.equal(interpretation.may_download, false);
  const nextSteps = interpretation.next_steps as string[];
  assert.match(nextSteps[0] ?? "", /Do not re-run yfy_membership_check on the same file ref/i);
  assert.match(nextSteps.join(" "), /yfy_browse|yfy_resolve/);
  const assertion = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "assert" });
  assert.equal(errorCode(assertion), "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE");
  assert.equal(errorCategory(assertion), "provider_contract");
  const diagnostics = JSON.parse(assertion.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown>; suggested_action?: string } };
  assert.equal(diagnostics.error?.diagnostics?.reason, "missing_ancestor_chain");
  assert.equal((diagnostics.error?.diagnostics?.agent_interpretation as Record<string, unknown> | undefined)?.may_claim_outside, false);
  assert.equal(diagnostics.error?.suggested_action, nextSteps[0]);
});

test("workspace membership rejects conflicting path and storage-space signals", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.includes("/folder/501/info")
      ? response(endpoint, { id: 501, name: "Root", type: "folder", space: { id: 1, type: "Department" } })
      : response(endpoint, { id: 10, name: "conflict.pdf", type: "file", parent_folder_id: 501, path: [{ id: 501, name: "Root", type: "folder" }], space: { id: 2, type: "department" } }) }
  } as unknown as AppRuntime;
  registerWorkspaceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(result.structuredContent?.membership, "unavailable");
  assert.equal((result.structuredContent?.diagnostics as Record<string, unknown>).reason, "conflicting_membership_signals");
  const interpretation = result.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, false);
  assert.equal(interpretation.may_download, false);
  const nextSteps = interpretation.next_steps as string[];
  assert.match(nextSteps[0] ?? "", /Stop automatic download/i);
  assert.match(nextSteps.join(" "), /diagnostics/i);
});

test("workspace validation keeps missing metadata unavailable instead of invalid", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/info")
      ? response(endpoint, { name: "Root", type: "folder", is_deleted: false, in_trash: false })
      : response(endpoint, { files: [], folders: [], page_count: 1 }) }
  } as unknown as AppRuntime;
  registerWorkspaceTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_workspace_validate", { workspace: WORKSPACE_TENDER, expected_path: ["Root"] });
  assert.equal(result.structuredContent?.verdict, "unavailable");
  const checks = result.structuredContent?.checks as Record<string, unknown>;
  assert.equal(checks.exists, "unavailable");
  assert.equal(checks.expected_path_matches, "unavailable");
});

test("inventory search returns a signed context-bound cursor", async () => {
  const server = new FakeServer();
  let receivedCursor: unknown;
  let state!: Record<string, unknown>;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", tags: [] } }) },
    gateway: {
      getUser: async (endpoint: string) => endpoint.includes("/folder/10/")
        ? response(endpoint, { id: 10, name: "Subtree", type: "folder", parent_folder_id: 501, path: [{ id: 501, name: "Root", type: "folder" }], space: { id: 7, type: "department" } })
        : response(endpoint, { id: 501, name: "Root", type: "folder", space: { id: 7, type: "department" } })
    },
    snapshots: {
      create: async (input: Record<string, unknown>) => {
        state = {
        accessContextId: "default", accessIdentityRef: IDENTITY_REF, artifactToken: "token", commitWatermark: 1, createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
        fileCount: 1, folderCount: 0, frontierCount: 0, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
        pageReceiptCount: 1, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 },
        policyHash: "hash", receiptDigest: "digest", revision: 4, retryCount: 0, rootFolder: {}, rootFolderId: String(input.rootFolderId), rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174000",
        status: "complete", updatedAt: "2026-07-16T00:00:00.000Z", workspaceFingerprint: input.workspaceFingerprint, workspaceId: "tender", workspaceRef: WORKSPACE_TENDER, workspaceRootFolderId: "501"
        };
        return { reused: false, reuseReason: "new", state };
      },
      get: async () => state,
      query: async (input: Record<string, unknown>) => {
        receivedCursor = input.cursor;
        return {
          items: [{ id: "10", name: "A", type: "file" }],
          nextCursor: { itemId: "file:10", sortPath: "Root/A", total: 2, watermark: 1 },
          state,
          total: 2
        };
      },
      summary: () => ({ terminal: true, completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "observed_subtree", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } }),
      manifest: async () => ({ completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "observed_subtree", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] }, observation_digest: "digest" }),
      storageStats: async () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_TENDER, root_folder: FOLDER_10, refresh: { mode: "reuse_if_fresh", max_age_seconds: 300 }, limits: { max_item_depth: 20, max_items: 50000 } });
  assert.notEqual(created.isError, true, JSON.stringify(created.content));
  assert.equal((created.structuredContent?.agent_guidance as Record<string, unknown>)?.may_claim_absence, true);
  assert.equal((created.structuredContent?.scan_root as Record<string, unknown>)?.id, "10");
  const inventory = String(created.structuredContent?.inventory);
  assert.match(inventory, /^inventory:123e4567-e89b-12d3-a456-426614174000@default\.[a-f0-9]{24}$/);
  assert.notEqual(inventory, `inventory:${String(state.scanId)}`);
  assert.equal(created.structuredContent?.inventory_id, state.scanId);
  const got = await call(server, "yfy_inventory_get", { inventory });
  assert.equal(String(got.structuredContent?.inventory), inventory);
  const first = await call(server, "yfy_inventory_search", { inventory, query: "证书", kind: "all", limit: 1 });
  assert.equal(String(first.structuredContent?.inventory), inventory);
  assert.equal((first.structuredContent?.scan_root as Record<string, unknown>)?.id, "10");
  assert.equal((first.structuredContent?.agent_guidance as Record<string, unknown>)?.may_claim_absence, true);
  assert.equal(((first.structuredContent?.completeness as Record<string, unknown>)?.scope), "observed_subtree");
  const manifestUri = String(created.structuredContent?.manifest_uri);
  const manifestResult = await server.resources.get("yfy_inventory_manifest")!(new URL(manifestUri), { inventory_id: String(state.scanId), artifact_token: String(state.artifactToken), access_context: "default" });
  const manifest = JSON.parse(manifestResult.contents[0]?.text ?? "{}") as Record<string, unknown>;
  assert.equal((manifest.scan_root as Record<string, unknown>).id, "10");
  assert.equal((manifest.agent_guidance as Record<string, unknown>).may_claim_absence, true);
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);
  assert.ok(cursor.length > 20);
  const second = await call(server, "yfy_inventory_search", { inventory, cursor });
  assert.notEqual(second.isError, true, JSON.stringify(second.content));
  assert.deepEqual(receivedCursor, { itemId: "file:10", sortPath: "Root/A", total: 2, watermark: 1 });
  const mixed = await call(server, "yfy_inventory_search", { inventory, cursor, limit: 2 });
  const mixedError = JSON.parse(mixed.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(mixedError.error?.diagnostics?.reason, "pagination_mixed_args");
  assert.deepEqual(mixedError.error?.diagnostics?.unexpected_keys, ["limit"]);
  const currentEnvelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  const legacyEnvelope: Record<string, unknown> = { ...currentEnvelope, version: 3 };
  delete legacyEnvelope.signature;
  const legacyCursor = Buffer.from(JSON.stringify({
    ...legacyEnvelope,
    signature: crypto.createHmac("sha256", "secret").update(JSON.stringify(legacyEnvelope)).digest("hex")
  }), "utf8").toString("base64url");
  const legacy = await call(server, "yfy_inventory_search", { inventory, cursor: legacyCursor });
  assert.equal(errorCode(legacy), "YFY_INVENTORY_CURSOR_INVALID");
  const legacyError = JSON.parse(legacy.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(legacyError.error?.diagnostics?.reason, "envelope_invalid");
  const invalid = await call(server, "yfy_inventory_search", { inventory, cursor: "%%%" });
  const error = JSON.parse(invalid.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(error.error?.diagnostics?.reason, "not_base64url");
});

test("inventory refs preserve non-default identity across instances and release idempotently", async () => {
  const server = new FakeServer();
  const secondaryIdentity = "c".repeat(24);
  const secondaryWorkspace = {
    context: { id: "secondary", userId: "531" },
    identityRef: secondaryIdentity,
    scope: { id: "secondary-scope", rootFolderId: "901", accessContext: "secondary", tags: [] }
  };
  let exists = true;
  let state!: Record<string, unknown>;
  const snapshots = {
    create: async (input: Record<string, unknown>) => {
      state = {
        accessContextId: "secondary", accessIdentityRef: secondaryIdentity, artifactToken: "token", commitWatermark: 1, createdAt: "2026-07-18T00:00:00.000Z", expiresAt: "2026-07-19T00:00:00.000Z",
        fileCount: 1, folderCount: 0, frontierCount: 0, incompleteReasons: [], observationStartedAt: "2026-07-18T00:00:00.000Z", observationUpdatedAt: "2026-07-18T00:00:00.000Z",
        pageReceiptCount: 1, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 8, maxItems: 1000, pageCapacity: 500 },
        policyHash: "hash", receiptDigest: "digest", revision: 1, retryCount: 0, rootFolder: {}, rootFolderId: "901", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174099",
        status: "complete", updatedAt: "2026-07-18T00:00:00.000Z", workspaceFingerprint: input.workspaceFingerprint, workspaceId: "secondary-scope", workspaceRef: "workspace:secondary-scope", workspaceRootFolderId: "901"
      };
      return { reused: false, reuseReason: "new", state };
    },
    get: async (_inventoryId: string, accessContext: string) => {
      if (accessContext !== "secondary") throw new YifangyunError("wrong context", { code: "YFY_INVENTORY_ACCESS_DENIED" });
      if (!exists) throw new YifangyunError("missing", { code: "YFY_INVENTORY_NOT_FOUND" });
      return state;
    },
    release: async (_inventoryId: string, accessContext: string) => {
      if (accessContext !== "secondary") throw new YifangyunError("wrong context", { code: "YFY_INVENTORY_ACCESS_DENIED" });
      if (!exists) return false;
      exists = false;
      return true;
    },
    summary: () => ({ terminal: true, completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } }),
    storageStats: () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
  };
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => secondaryWorkspace },
    snapshots
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: "workspace:secondary-scope", refresh: { mode: "force_refresh" }, limits: { max_item_depth: 8, max_items: 1000 } });
  const inventory = String(created.structuredContent?.inventory);
  assert.match(inventory, /^inventory:123e4567-e89b-12d3-a456-426614174099@secondary\.[a-f0-9]{24}$/);
  const read = await call(server, "yfy_inventory_get", { inventory });
  assert.notEqual(read.isError, true, JSON.stringify(read.content));
  assert.equal(String(read.structuredContent?.inventory), inventory);
  assert.equal((read.structuredContent?.workspace as Record<string, unknown>).access_context, "secondary");
  const forged = await call(server, "yfy_inventory_get", { inventory: inventory.slice(0, -4) + "dead" });
  assert.equal(errorCode(forged), "YFY_INPUT_INVALID");

  const restartedServer = new FakeServer();
  const restartedRuntime = { ...runtime } as AppRuntime;
  registerInventoryTools(restartedServer as unknown as McpServer, restartedRuntime);
  const durable = await call(restartedServer, "yfy_inventory_get", { inventory });
  assert.notEqual(durable.isError, true, JSON.stringify(durable.content));

  const wrongSecretServer = new FakeServer();
  const wrongSecretRuntime = { ...runtime, config: { ...runtime.config, clientSecret: "different-secret" } } as AppRuntime;
  registerInventoryTools(wrongSecretServer as unknown as McpServer, wrongSecretRuntime);
  const wrongSecret = await call(wrongSecretServer, "yfy_inventory_get", { inventory });
  assert.equal(errorCode(wrongSecret), "YFY_INPUT_INVALID");

  const released = await call(server, "yfy_inventory_release", { inventory });
  assert.equal(released.structuredContent?.status, "released");
  const repeated = await call(server, "yfy_inventory_release", { inventory });
  assert.equal(repeated.structuredContent?.status, "already_unavailable");
  const forgedMissing = await call(server, "yfy_inventory_release", { inventory: inventory.replace("174099", "174098") });
  assert.equal(errorCode(forgedMissing), "YFY_INPUT_INVALID");
  const wrongSecretRelease = await call(wrongSecretServer, "yfy_inventory_release", { inventory });
  assert.equal(errorCode(wrongSecretRelease), "YFY_INPUT_INVALID");
});

test("inventory refs become stale when the configured workspace root changes", async () => {
  const server = new FakeServer();
  let configuredRoot = "501";
  let storageFails = false;
  let state!: Record<string, unknown>;
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "scope", rootFolderId: configuredRoot, tags: [] } }) },
    snapshots: {
      create: async (input: Record<string, unknown>) => {
        state = {
          accessContextId: "default", accessIdentityRef: IDENTITY_REF, artifactToken: "token", commitWatermark: 1, createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
          fileCount: 1, folderCount: 0, frontierCount: 0, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
          pageReceiptCount: 1, policy: { includeFiles: true, includeFolders: true, maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 }, policyHash: "hash", receiptDigest: "digest",
          revision: 1, retryCount: 0, rootFolder: {}, rootFolderId: "501", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174001", status: "complete",
          updatedAt: "2026-07-16T00:00:00.000Z", workspaceFingerprint: input.workspaceFingerprint, workspaceId: "scope", workspaceRef: WORKSPACE_SCOPE, workspaceRootFolderId: "501"
        };
        return { reused: false, reuseReason: "new", state };
      },
      get: async () => state,
      summary: () => ({ terminal: true, completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } }),
      storageStats: async () => {
        if (storageFails) throw new Error("storage stats unavailable");
        return { database_bytes: 0, logical_bytes: 0, wal_bytes: 0 };
      }
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_SCOPE, refresh: { mode: "force_refresh" }, limits: { max_item_depth: 20, max_items: 50000 } });
  const inventory = String(created.structuredContent?.inventory);
  const before = await call(server, "yfy_inventory_get", { inventory });
  assert.notEqual(before.isError, true, JSON.stringify(before.content));
  storageFails = true;
  const storageFailure = await call(server, "yfy_inventory_get", { inventory });
  assert.equal(storageFailure.isError, true);
  storageFails = false;
  configuredRoot = "999";
  const after = await call(server, "yfy_inventory_get", { inventory });
  assert.equal(errorCode(after), "YFY_INVENTORY_STALE");
  assert.equal(errorCategory(after), "stale_state");
});

test("inventory root_folder rejects conflicting path and storage-space signals", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", tags: [] } }) },
    gateway: {
      getUser: async (endpoint: string) => endpoint.includes("/folder/10/")
        ? response(endpoint, { id: 10, name: "Conflict", type: "folder", path: [{ id: 501, name: "Root", type: "folder" }], space: { id: 7, type: "personal" } })
        : response(endpoint, { id: 501, name: "Root", type: "folder", space: { id: 7, type: "department" } })
    },
    snapshots: { create: async () => { throw new Error("conflicting membership must fail before inventory creation"); } }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_SCOPE, root_folder: FOLDER_10, refresh: { mode: "force_refresh" }, limits: { max_item_depth: 20, max_items: 50000 } });
  assert.equal(errorCode(result), "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE");
  assert.match(JSON.stringify(result.content), /conflicting_membership_signals/);
});

test("inventory cancel reports the terminal state won by a concurrent completion", async () => {
  const server = new FakeServer();
  let running!: Record<string, unknown>;
  let complete!: Record<string, unknown>;
  const base = {
    accessContextId: "default", accessIdentityRef: IDENTITY_REF, artifactToken: "token", commitWatermark: 0, createdAt: "2026-07-16T00:00:00.000Z", expiresAt: "2026-07-17T00:00:00.000Z",
    fileCount: 0, folderCount: 0, frontierCount: 1, incompleteReasons: [], observationStartedAt: "2026-07-16T00:00:00.000Z", observationUpdatedAt: "2026-07-16T00:00:00.000Z",
    pageReceiptCount: 0, policy: { caseSensitive: false, includeFiles: true, includeFolders: true, matchFields: ["name", "path"], maxItemDepth: 20, maxItems: 50000, pageCapacity: 500 },
    policyHash: "hash", receiptDigest: "digest", revision: 1, retryCount: 0, rootFolder: {}, rootFolderId: "501", rootObservationDigest: "root", scanId: "123e4567-e89b-12d3-a456-426614174000",
    status: "running", updatedAt: "2026-07-16T00:00:00.000Z", workspaceId: "scope", workspaceRef: WORKSPACE_SCOPE, workspaceRootFolderId: "501"
  };
  const runtime = {
    config: { clientSecret: "secret", maxPageCapacity: 500, toolsets: ["inventory"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "scope", rootFolderId: "501", tags: [] } }) },
    snapshots: {
      create: async (input: Record<string, unknown>) => {
        running = { ...base, workspaceFingerprint: input.workspaceFingerprint };
        complete = { ...running, status: "complete", revision: 2 };
        return { reused: false, reuseReason: "new", state: running };
      },
      get: async () => running,
      cancel: async () => complete,
      summary: (state: Record<string, unknown>) => ({ terminal: state.status === "complete", completeness: { pagination_complete: true, safe_to_claim_absence: true, scope: "entire_observed_accessible_scope", consistency_level: "best_effort_complete_observation", incomplete_reasons: [] } }),
      storageStats: () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_SCOPE, refresh: { mode: "reuse_if_fresh", max_age_seconds: 300 }, limits: { max_item_depth: 20, max_items: 50000 } });
  const inventory = String(created.structuredContent?.inventory);
  const result = await call(server, "yfy_inventory_cancel", { inventory });
  assert.equal((result.structuredContent?.cancellation as Record<string, unknown>).outcome, "already_terminal");
  assert.equal(result.structuredContent?.status, "complete");
});

test("yfy_download returns a verified stdio local_path and release handle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-bin-"));
  const body = "pdf-bytes!";
  const hashes = contentHashes(body);
  const source = path.join(root, "source.pdf");
  await fs.writeFile(source, body);
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "ordinary.pdf", type: "file", size: hashes.sizeBytes, modified_at: 1, file_version_key: "v1" })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "ordinary.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { file: FILE_10 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.structuredContent?.status, "ready");
    const download = result.structuredContent?.download as Record<string, unknown>;
    assert.equal(typeof download.local_path, "string");
    assert.equal(download.fetch_url, null);
    assert.equal(download.media_type, "application/pdf");
    assert.equal(download.sha256, hashes.sha256);
    assert.equal(await fs.readFile(String(download.local_path), "utf8"), body);
    assert.equal(result.structuredContent?.preview, null);
    assert.equal((result.structuredContent?.cleanup as Record<string, unknown>).release_tool, "yfy_download_release");
    const released = await call(server, "yfy_download_release", { download_id: download.download_id });
    assert.equal(released.structuredContent?.status, "released");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download text preview is opt-in and bounded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-txt-"));
  const body = "hello preview";
  const source = path.join(root, "notes.txt");
  await fs.writeFile(source, body);
  const hashes = contentHashes(body);
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false, textPreviewMaxBytes: 32768 },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: body.length, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "notes.txt", type: "file", size: body.length, modified_at: 1, file_version_key: "v1" })
    },
    client: {
      downloadFromUrlToTemp: async () => ({
        fileName: "notes.txt",
        tempPath: source,
        ...hashes,
        contentType: "text/plain",
        meta: response("/download", {}).meta
      })
    },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { file: FILE_10, include_text_preview: true });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const preview = result.structuredContent?.preview as Record<string, unknown>;
    assert.equal(preview.kind, "utf8_text");
    assert.equal(preview.text, body);
    assert.equal(typeof (result.structuredContent?.download as Record<string, unknown>).local_path, "string");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download enforces workspace membership for a historical version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-hist-"));
  const body = "history";
  const hashes = contentHashes(body);
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  let requestedVersion: unknown;
  const source = path.join(root, "history.pdf");
  await fs.writeFile(source, body);
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      context: access,
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown> = {}) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
          { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
          { id: 7, current: false, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }
        ] });
        if (endpoint.endsWith("/download_v2")) { requestedVersion = params.version; return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: 10, name: "report.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "history.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(requestedVersion, "7");
    assert.equal((result.structuredContent?.workspace as Record<string, unknown>).membership, "inside");
    assert.equal(typeof (result.structuredContent?.download as Record<string, unknown>).local_path, "string");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download preserves historical Provider version ids beyond MAX_SAFE_INTEGER", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-large-version-"));
  const body = "history";
  const hashes = contentHashes(body);
  const source = path.join(root, "history.pdf");
  const providerVersionId = "90071992547409931234";
  const versionRef = formatVersionRef(FILE_10, providerVersionId);
  let requestedVersion: unknown;
  await fs.writeFile(source, body);
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      context: access,
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown> = {}) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
          { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
          { id: providerVersionId, current: false, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }
        ] });
        if (endpoint.endsWith("/download_v2")) { requestedVersion = params.version; return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: 10, name: "report.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "history.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: versionRef });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(requestedVersion, providerVersionId);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download retries a failed transfer stream with a fresh ticket", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-stream-retry-"));
  const body = "retried";
  const hashes = contentHashes(body);
  const source = path.join(root, "retried.pdf");
  let ticketCalls = 0;
  let transferCalls = 0;
  const timeoutBudgets: number[] = [];
  const notifications: unknown[] = [];
  await fs.writeFile(source, body);
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false, downloadWallTimeoutMs: 5000 },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? (ticketCalls += 1, response(endpoint, { download_url: `https://download.example/file-${ticketCalls}` }))
          : response(endpoint, { id: 10, name: "retried.pdf", type: "file", size: hashes.sizeBytes, modified_at: 1, file_version_key: "v1" })
    },
    client: {
      downloadFromUrlToTemp: async (_url: string, options: { onProgress?: (bytes: number, totalBytes?: number) => void; timeoutMs?: number }) => {
        transferCalls += 1;
        timeoutBudgets.push(options.timeoutMs ?? 0);
        if (transferCalls === 1) {
          options.onProgress?.(5, hashes.sizeBytes);
          await new Promise((resolve) => setTimeout(resolve, 1050));
          throw new YifangyunError("stream reset", { code: "YFY_DOWNLOAD_STREAM_FAILED", phase: "download_stream", retryable: true });
        }
        options.onProgress?.(1, hashes.sizeBytes);
        options.onProgress?.(hashes.sizeBytes, hashes.sizeBytes);
        return { fileName: "retried.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta };
      }
    },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await server.tools.get("yfy_download")!({ file: FILE_10 }, {
      _meta: { progressToken: "download-progress" },
      signal: new AbortController().signal,
      sendNotification: async (notification) => { notifications.push(notification); }
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(ticketCalls, 2);
    assert.equal(transferCalls, 2);
    assert.ok(timeoutBudgets[1]! < timeoutBudgets[0]!);
    assert.deepEqual(notifications.map((notification) => ((notification as { params: { progress: number } }).params.progress)), [5, hashes.sizeBytes]);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download enforces one wall timeout across all stream attempts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-wall-timeout-"));
  const body = "timeout";
  const hashes = contentHashes(body);
  let ticketCalls = 0;
  let transferCalls = 0;
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false, downloadWallTimeoutMs: 30 },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? (ticketCalls += 1, response(endpoint, { download_url: `https://download.example/file-${ticketCalls}` }))
          : response(endpoint, { id: 10, name: "timeout.pdf", type: "file", size: hashes.sizeBytes, modified_at: 1, file_version_key: "v1" })
    },
    client: {
      downloadFromUrlToTemp: async () => {
        transferCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new YifangyunError("stream reset", { code: "YFY_DOWNLOAD_STREAM_FAILED", phase: "download_stream", retryable: true });
      }
    },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { file: FILE_10 });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_PROVIDER_TIMEOUT");
    assert.equal(ticketCalls, 1);
    assert.equal(transferCalls, 1);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download cancellation prevents a stream retry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-retry-cancel-"));
  const hashes = contentHashes("cancelled");
  let ticketCalls = 0;
  let transferCalls = 0;
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false, downloadWallTimeoutMs: 5000 },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? (ticketCalls += 1, response(endpoint, { download_url: "https://download.example/file" }))
          : response(endpoint, { id: 10, name: "cancelled.pdf", type: "file", size: hashes.sizeBytes, modified_at: 1, file_version_key: "v1" })
    },
    client: {
      downloadFromUrlToTemp: async (_url: string, options: { signal?: AbortSignal }) => {
        transferCalls += 1;
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new YifangyunError("cancelled", { code: "YFY_DOWNLOAD_STREAM_FAILED", phase: "download_stream", retryable: true });
      }
    },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  const controller = new AbortController();
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const resultPromise = call(server, "yfy_download", { file: FILE_10 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const result = await resultPromise;
    assert.equal(result.isError, true);
    assert.equal(ticketCalls, 1);
    assert.equal(transferCalls, 1);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download reports an unavailable historical original without substitution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-unavail-"));
  const source = path.join(root, "current.pdf");
  await fs.writeFile(source, "current!!!");
  const hashes = contentHashes("current!!!");
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
          { current: true, sha1: "a".repeat(40), size: 10 },
          { id: 7, current: false, sha1: "b".repeat(40), size: 9 }
        ] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        return response(endpoint, { id: "10", name: "report.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "current.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_HISTORICAL_DOWNLOAD_UNAVAILABLE");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download rolls back when expectation does not match", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-exp-"));
  const source = path.join(root, "report.pdf");
  await fs.writeFile(source, "content9!");
  const hashes = contentHashes("content9!");
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        return response(endpoint, { id: 10, name: "report.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "document.pdf", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { file: FILE_10, workspace: WORKSPACE_SCOPE, expected: { sha256: "d".repeat(64) } });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_EXPECTATION_MISMATCH");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download_release is idempotent at the tool layer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-rel-"));
  const source = path.join(root, "a.bin");
  await fs.writeFile(source, "abc");
  const hashes = contentHashes("abc");
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], tempFileTtlSeconds: 60, transport: "stdio", downloadExposeLocalPath: true, downloadStagedHttpEnabled: false },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "a.bin", type: "file", size: 3, modified_at: 1, file_version_key: "v1" })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "a.bin", tempPath: source, ...hashes, meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { file: FILE_10 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const id = (result.structuredContent?.download as Record<string, unknown>).download_id;
    const first = await call(server, "yfy_download_release", { download_id: id });
    assert.equal(first.structuredContent?.status, "released");
    const second = await call(server, "yfy_download_release", { download_id: id });
    assert.equal(second.structuredContent?.status, "already_unavailable");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("yfy_download on http transport returns fetch_url without local_path by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-http-"));
  const source = path.join(root, "report.bin");
  await fs.writeFile(source, "content");
  const hashes = contentHashes("content");
  const { downloads, tempStorage } = downloadHarness(root);
  const server = new FakeServer();
  const runtime = {
    config: {
      toolsets: ["drive"],
      tempFileTtlSeconds: 60,
      transport: "http",
      downloadExposeLocalPath: false,
      downloadStagedHttpEnabled: true,
      httpHost: "::1",
      httpPort: 3000
    },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: hashes.sha1, size: hashes.sizeBytes, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2") ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "report.xls", type: "file", size: 7, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "report.xls", tempPath: source, ...hashes, contentType: "application/excel", meta: response("/download", {}).meta }) },
    downloads,
    tempStorage
  } as unknown as AppRuntime;
  try {
    registerDownloadTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_download", { workspace: WORKSPACE_SCOPE, file: FILE_10 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const download = result.structuredContent?.download as Record<string, unknown>;
    assert.equal(download.local_path, null);
    assert.match(String(download.fetch_url), /^http:\/\/\[::1\]:3000\/staged\/v1\/dl_[a-f0-9]{32}\//);
    assert.equal(download.media_type, "application/vnd.ms-excel");
    const record = downloads.get(String(download.download_id));
    assert.ok(record);
    assert.equal((await fs.stat(record!.localPath)).size, 7);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("organization contact policy distinguishes omitted included and unavailable fields", async () => {
  const server = new FakeServer();
  let providerHasContact = true;
  const runtime = {
    config: { clientSecret: "secret", configFingerprint: "a".repeat(64), maxPageCapacity: 500, toolsets: ["organization"] },
    configFingerprint: "a".repeat(64),
    gateway: { getEnterprise: async (endpoint: string) => response(endpoint, { users: [{ id: 1, name: "User", ...(providerHasContact ? { email: "user@example.com" } : {}) }], page_id: 0, page_count: 1 }) }
  } as unknown as AppRuntime;
  registerOrganizationTools(server as unknown as McpServer, runtime);
  const omitted = await call(server, "yfy_department_users", { department_id: "1", include_contact: false });
  assert.deepEqual(omitted.structuredContent?.contact_policy, { requested: false, fields: "omitted_by_default" });
  const included = await call(server, "yfy_department_users", { department_id: "1", include_contact: true });
  assert.deepEqual(included.structuredContent?.contact_policy, { requested: true, fields: "included" });
  providerHasContact = false;
  const unavailable = await call(server, "yfy_department_users", { department_id: "1", include_contact: true });
  assert.deepEqual(unavailable.structuredContent?.contact_policy, { requested: true, fields: "none_available" });
});

test("transfer tickets are current-only and claim metadata-only validation", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["transfer"] }, access: { resolveContext: access },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/versions")
      ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 7 }] })
      : response(endpoint, { download_url: "https://download.example/file" }) }
  } as unknown as AppRuntime;
  registerTransferTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_transfer_ticket_get", { file: FILE_10 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).validation_level, "metadata_only");
  assert.equal(result.structuredContent?.usage_policy, "special_integration_only");
  assert.equal(result.structuredContent?.not_for_verified_download, true);
  assert.equal(result.structuredContent?.do_not_echo_url, true);
  assert.deepEqual(result.structuredContent?.preferred_alternatives, { ordinary_read: "yfy_download", workspace_bound: "yfy_download" });
  assert.equal(result.structuredContent?.download_url, "https://download.example/file");
  const text = result.content?.find((entry) => entry.type === "text")?.text ?? "";
  assert.ok(!text.includes("https://download.example/file"));
  assert.match(text, /\*\*\*redacted\*\*\*|do_not_echo_url/);
});

test("mutation and admin grouped tools build official requests", async () => {
  const server = new FakeServer();
  const calls: Array<{ body: JsonValue; endpoint: string }> = [];
  const runtime = {
    config: { toolsets: ["mutation", "admin"] },
    gateway: {
      context: access,
      postUser: async (endpoint: string, _context: string, body: JsonValue) => { calls.push({ endpoint, body }); return response(endpoint, { id: 9, name: "Folder", type: "folder" }); },
      postEnterprise: async (endpoint: string, body: JsonValue) => { calls.push({ endpoint, body }); return response(endpoint, { id: 8, name: "Group" }); }
    }
  } as unknown as AppRuntime;
  registerMutationTools(server as unknown as McpServer, runtime);
  registerAdminTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_folder_create", { name: "Bid", parent: FOLDER_1 });
  assert.notEqual(created.isError, true);
  const group = await call(server, "yfy_admin_group_mutate", { action: "create", name: "Reviewers" });
  assert.notEqual(group.isError, true);
  assert.equal(calls[0]?.endpoint, "/v2/folder/create");
  assert.equal(calls[1]?.endpoint, "/v2/admin/group/create");
});

test("collaboration and upload tools reject conflicting identity selectors", async () => {
  const server = new FakeServer();
  const ownerIdentity = "b".repeat(24);
  const ownerFolder = formatItemRef("folder", "20", "owner", ownerIdentity);
  const runtime = {
    config: { toolsets: ["mutation", "collaboration"] },
    gateway: {
      context: (contextId?: string) => contextId === "owner"
        ? { context: { id: "owner", userId: "531" }, identityRef: ownerIdentity }
        : { context: { id: "reviewer", userId: "530" }, identityRef: IDENTITY_REF },
      getUser: async () => { throw new Error("conflicting collaboration input must not reach Provider"); }
    }
  } as unknown as AppRuntime;
  registerMutationTools(server as unknown as McpServer, runtime);
  const collaboration = await call(server, "yfy_collaboration_read", { action: "get", collaboration_id: "123", folder: ownerFolder, access_context: "reviewer" });
  assert.equal(errorCode(collaboration), "YFY_INPUT_INVALID");
  const upload = await call(server, "yfy_file_upload", { local_path: "C:/unused", parent: ownerFolder, access_context: "reviewer" });
  assert.equal(errorCode(upload), "YFY_REF_CONTEXT_CONFLICT");
});

test("mutation tools propagate the MCP cancellation signal to Provider calls", async () => {
  const server = new FakeServer();
  let receivedSignal: AbortSignal | undefined;
  const runtime = {
    config: { toolsets: ["mutation"] },
    gateway: {
      context: access,
      postUser: async (_endpoint: string, _context: string, _body: JsonValue, _params: Record<string, unknown>, signal?: AbortSignal) => {
        receivedSignal = signal;
        return response("/v2/folder/create", { id: 9, name: "Folder", type: "folder" });
      }
    }
  } as unknown as AppRuntime;
  registerMutationTools(server as unknown as McpServer, runtime);
  const controller = new AbortController();
  await call(server, "yfy_folder_create", { name: "Bid", parent: FOLDER_1 }, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

test("local upload requires a configured root and rejects paths outside it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-upload-root-"));
  const server = new FakeServer();
  const uploadRootDir = path.join(dir, "allowed");
  const outsidePath = path.join(dir, "secret.txt");
  await fs.mkdir(uploadRootDir);
  await fs.writeFile(outsidePath, "secret");
  const runtime = {
    config: { toolsets: ["mutation"], uploadRootDir },
    gateway: { context: access }
  } as unknown as AppRuntime;
  try {
    registerMutationTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_file_upload", { local_path: outsidePath, parent: FOLDER_1, overwrite: false });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_UPLOAD_SOURCE_OUT_OF_SCOPE");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("local upload remains bound to the validated file after its path is replaced", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-upload-binding-"));
  const uploadRootDir = path.join(dir, "allowed");
  const sourcePath = path.join(uploadRootDir, "source.txt");
  const replacementPath = path.join(dir, "replacement.txt");
  const displacedPath = path.join(dir, "displaced.txt");
  await fs.mkdir(uploadRootDir);
  await fs.writeFile(sourcePath, "VALIDATED");
  await fs.writeFile(replacementPath, "OUTSIDE_SECRET");
  const server = new FakeServer();
  let uploaded = "";
  const runtime = {
    config: { maxDownloadBytes: 1024, toolsets: ["mutation"], uploadRootDir },
    gateway: {
      context: access,
      postUser: async (endpoint: string) => {
        await fs.rename(sourcePath, displacedPath);
        await fs.copyFile(replacementPath, sourcePath);
        return response(endpoint, { presign_url: "https://upload.example/file" });
      }
    },
    client: {
      uploadLocalFileToPresignedUrl: async (_url: string, source: Awaited<ReturnType<typeof fs.open>>, fileName: string) => {
        const stat = await source.stat();
        const content = Buffer.alloc(stat.size);
        await source.read(content, 0, content.length, 0);
        uploaded = content.toString("utf8");
        return { deliveryMethod: "PUT_BINARY", fileName, remoteStatusCode: 200, sizeBytes: stat.size };
      }
    }
  } as unknown as AppRuntime;
  try {
    registerMutationTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_file_upload", { local_path: sourcePath, parent: FOLDER_1, overwrite: false });
    assert.notEqual(result.isError, true);
    assert.equal(uploaded, "VALIDATED");
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
