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
import { EvidenceArtifactRegistry } from "./runtime/evidence.js";
import { registerAdminTools } from "./tools/adminTools.js";
import { normalizedMediaType, registerWorkspaceContentTools } from "./tools/workspaceContentTools.js";
import { registerDriveTools } from "./tools/driveTools.js";
import { registerMutationTools } from "./tools/mutationTools.js";
import { registerInventoryTools } from "./tools/inventoryTools.js";
import { registerOrganizationTools } from "./tools/organizationTools.js";
import { registerTransferTools } from "./tools/transferTools.js";
import type { ApiJsonResponse, JsonValue } from "./types.js";

type ToolResult = { content?: Array<{ resource?: { mimeType?: string; text?: string; uri?: string }; text?: string; type: string; uri?: string; mimeType?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal; sendNotification: () => Promise<void> }) => Promise<ToolResult>;
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

test("legacy Office media types are normalized for MCP clients", () => {
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

test("context-bound refs reject beta.6 numeric refs and preserve identity", () => {
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
  const first = await call(server, "yfy_search", { request: { mode: "first_request", query: "candidate", in: "personal", limit: 2 } });
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
    disambiguation_groups: 0
  });
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
  const second = await call(server, "yfy_search", { request: { mode: "continuation", cursor } });
  assert.deepEqual((second.structuredContent?.hits as Array<Record<string, unknown>>).map((hit) => (hit.item as Record<string, unknown>).ref), [formatItemRef("file", "3", "default", IDENTITY_REF)]);
  assert.doesNotMatch(JSON.stringify(first.structuredContent), /login|secret/);
  const standard = await call(server, "yfy_search", { request: { mode: "first_request", query: "candidate", in: "personal", detail: "standard" } });
  assert.equal((((standard.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).owned_by as Record<string, unknown>).name, "Owner");
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
  const result = await call(server, "yfy_search", { request: { mode: "first_request", query: "candidate", in: "personal", limit: 10 } });
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

  const included = await call(server, "yfy_search", { request: { mode: "first_request", query: "candidate", in: "personal", include_unverified_index_hits: true, limit: 10 } });
  assert.equal((included.structuredContent?.hits as unknown[]).length, 1);
  const unverified = included.structuredContent?.unverified_hits as Array<Record<string, unknown>>;
  assert.equal(unverified.length, 2);
  assert.equal((unverified[0]?.match as Record<string, unknown>).claim_allowed, false);
  assert.equal((unverified[0]?.match as Record<string, unknown>).trust, "unverified_index_hit");

  const orderedFirst = await call(server, "yfy_search", { request: { mode: "first_request", query: "candidate", in: "personal", include_unverified_index_hits: true, limit: 1 } });
  assert.equal((orderedFirst.structuredContent?.hits as unknown[]).length, 0);
  assert.equal((((orderedFirst.structuredContent?.unverified_hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), FILE_1);
  const orderedSecond = await call(server, "yfy_search", { request: { mode: "continuation", cursor: String((orderedFirst.structuredContent?.page as Record<string, unknown>).next_cursor) } });
  assert.equal((((orderedSecond.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.item as Record<string, unknown>).ref), FILE_2);
  const orderedThird = await call(server, "yfy_search", { request: { mode: "continuation", cursor: String((orderedSecond.structuredContent?.page as Record<string, unknown>).next_cursor) } });
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
  const result = await call(server, "yfy_search", { request: { mode: "first_request", query: "招标公告.pdf", in: "personal", field: "name", exact_name: true, limit: 10 } });
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

  const first = await call(server, "yfy_search", { request: { mode: "first_request", query: "same", in: "personal", field: "all", include_unverified_index_hits: true, limit: 1 } });
  const firstHit = ((first.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>);
  assert.equal(firstHit.disambiguation_required, true);
  assert.equal(firstHit.same_name_hit_count_in_provider_page, 2);
  assert.equal((first.structuredContent?.page as Record<string, unknown>).returned_count, 1);

  const second = await call(server, "yfy_search", { request: { mode: "continuation", cursor: String((first.structuredContent?.page as Record<string, unknown>).next_cursor) } });
  assert.equal((second.structuredContent?.page as Record<string, unknown>).returned_count, 1);
  assert.equal((((second.structuredContent?.hits as Array<Record<string, unknown>>)[0]?.match as Record<string, unknown>).disambiguation_required), true);

  const third = await call(server, "yfy_search", { request: { mode: "continuation", cursor: String((second.structuredContent?.page as Record<string, unknown>).next_cursor) } });
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
  const first = await call(firstServer, "yfy_browse", { request: { mode: "first_request", at: "personal", limit: 1 } });
  const cursor = String((first.structuredContent?.page as Record<string, unknown>).next_cursor);

  const secondServer = new FakeServer();
  const secondRuntime = {
    ...firstRuntime,
    configFingerprint: "b".repeat(64),
    gateway: { context: access, getUser: async () => { throw new Error("stale cursor must fail before Provider I/O"); } }
  } as unknown as AppRuntime;
  registerDriveTools(secondServer as unknown as McpServer, secondRuntime);
  const continued = await call(secondServer, "yfy_browse", { request: { mode: "continuation", cursor } });
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
  const result = await call(server, "yfy_admin_log_query", { action: "list", request: { mode: "first_request", start_date: "2026-07-01", end_date: "2026-07-02", limit: 2 } });
  const page = result.structuredContent?.page as Record<string, unknown>;
  assert.equal(page.returned_count, 2);
  assert.equal(page.has_more, true);
  assert.equal(((result.structuredContent?.next_action as Record<string, unknown>).arguments as Record<string, unknown>).action, "list");
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
  const result = await call(server, "yfy_search", { request: { mode: "first_request", query: "test.docx", in: FOLDER_10, kind: "file", field: "name", exact_name: true, limit: 5 } });
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
        { id: 7, current: false, sha1: "b".repeat(40), size: 8, modified_at: 1 }
      ] })
    }
  } as unknown as AppRuntime;
  registerDriveTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_versions", { request: { mode: "first_request", file: FILE_10 } });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const versions = result.structuredContent?.versions as Array<Record<string, unknown>>;
  assert.equal(versions[0]?.current, true);
  assert.equal(versions[0]?.ref, null);
  assert.ok(Object.prototype.hasOwnProperty.call(versions[0], "ref"));
  assert.deepEqual(versions[0]?.usage, {
    for_open_or_capture: "omit_version_parameter",
    note: "Current version: omit the version parameter on yfy_open/yfy_capture."
  });
  assert.equal(versions[1]?.ref, VERSION_10_7);
  assert.deepEqual(versions[1]?.usage, {
    for_open_or_capture: "pass_version_ref",
    note: "Historical version: pass this ref as the version parameter on yfy_open/yfy_capture."
  });
  assert.deepEqual(result.structuredContent?.version_selection_rules, {
    current: "Omit the version parameter on yfy_open/yfy_capture for the current version. Do not invent a version ref.",
    historical: "Copy the historical version ref from this result and pass it as the version parameter on yfy_open/yfy_capture."
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
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "outside");
  assert.equal(query.structuredContent?.path_basis, "configured_workspace_root");
  assert.deepEqual(query.structuredContent?.relative_ancestor_chain, []);
  assert.equal((query.structuredContent?.file as Record<string, unknown>).path_basis, "provider_supplied");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "different_space_id");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, true);
  assert.equal(interpretation.may_capture, false);
  assert.deepEqual((query.structuredContent?.diagnostics as Record<string, unknown>).observed_file_space, { id: "2", type: "department" });
  assert.deepEqual((query.structuredContent?.diagnostics as Record<string, unknown>).observed_root_space, { id: "1", type: "department" });
  assert.equal(query.isError, undefined);
  const assertion = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "assert" });
  assert.equal(assertion.isError, true);
  assert.equal(errorCode(assertion), "YFY_WORKSPACE_MEMBERSHIP_FAILED");
  assert.equal(errorCategory(assertion), "authorization");
  const diagnostics = JSON.parse(assertion.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(diagnostics.error?.diagnostics?.reason, "different_space_id");
  assert.equal((diagnostics.error?.diagnostics?.agent_interpretation as Record<string, unknown> | undefined)?.may_capture, false);
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
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "outside");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "different_space_type");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_outside, true);
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_capture, false);
});

test("workspace membership reports unavailable when ancestry is incomplete", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => response(endpoint, { id: 10, name: "unknown.pdf", type: "file", parent_folder_id: 2 }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const query = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(query.structuredContent?.membership, "unavailable");
  assert.equal((query.structuredContent?.diagnostics as Record<string, unknown>).reason, "missing_ancestor_chain");
  const interpretation = query.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, false);
  assert.equal(interpretation.may_capture, false);
  const assertion = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "assert" });
  assert.equal(errorCode(assertion), "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE");
  assert.equal(errorCategory(assertion), "provider_contract");
  const diagnostics = JSON.parse(assertion.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(diagnostics.error?.diagnostics?.reason, "missing_ancestor_chain");
  assert.equal((diagnostics.error?.diagnostics?.agent_interpretation as Record<string, unknown> | undefined)?.may_claim_outside, false);
});

test("workspace membership rejects conflicting path and storage-space evidence", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.includes("/folder/501/info")
      ? response(endpoint, { id: 501, name: "Root", type: "folder", space: { id: 1, type: "Department" } })
      : response(endpoint, { id: 10, name: "conflict.pdf", type: "file", parent_folder_id: 501, path: [{ id: 501, name: "Root", type: "folder" }], space: { id: 2, type: "department" } }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_membership_check", { file: FILE_10, workspace: WORKSPACE_TENDER, mode: "query" });
  assert.equal(result.structuredContent?.membership, "unavailable");
  assert.equal((result.structuredContent?.diagnostics as Record<string, unknown>).reason, "conflicting_membership_evidence");
  const interpretation = result.structuredContent?.agent_interpretation as Record<string, unknown>;
  assert.equal(interpretation.may_claim_inside, false);
  assert.equal(interpretation.may_claim_outside, false);
  assert.equal(interpretation.may_capture, false);
});

test("workspace validation keeps missing evidence unavailable instead of invalid", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["workspace"] },
    access: { resolveWorkspaceRef: () => ({ ...access(), scope: { id: "tender", rootFolderId: "501", accessContext: "default", tags: [] } }) },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/info")
      ? response(endpoint, { name: "Root", type: "folder", is_deleted: false, in_trash: false })
      : response(endpoint, { files: [], folders: [], page_count: 1 }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
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
      storageStats: () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_TENDER, root_folder: FOLDER_10, refresh: { mode: "reuse_if_fresh", max_age_seconds: 300 }, limits: { max_item_depth: 20, max_items: 50000 } });
  assert.notEqual(created.isError, true, JSON.stringify(created.content));
  assert.equal((created.structuredContent?.agent_guidance as Record<string, unknown>)?.may_claim_absence, true);
  assert.equal((created.structuredContent?.scan_root as Record<string, unknown>)?.id, "10");
  const inventory = String(created.structuredContent?.inventory);
  const first = await call(server, "yfy_inventory_search", { inventory, request: { mode: "first_request", query: "证书", kind: "all", limit: 1 } });
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
  const second = await call(server, "yfy_inventory_search", { inventory, request: { mode: "continuation", cursor } });
  assert.notEqual(second.isError, true, JSON.stringify(second.content));
  assert.deepEqual(receivedCursor, { itemId: "file:10", sortPath: "Root/A", total: 2, watermark: 1 });
  const invalid = await call(server, "yfy_inventory_search", { inventory, request: { mode: "continuation", cursor: "%%%" } });
  const error = JSON.parse(invalid.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { error?: { diagnostics?: Record<string, unknown> } };
  assert.equal(error.error?.diagnostics?.reason, "not_base64url");
});

test("inventory refs become stale when the configured workspace root changes", async () => {
  const server = new FakeServer();
  let configuredRoot = "501";
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
      storageStats: () => ({ database_bytes: 0, logical_bytes: 0, wal_bytes: 0 })
    }
  } as unknown as AppRuntime;
  registerInventoryTools(server as unknown as McpServer, runtime);
  const created = await call(server, "yfy_inventory_create", { workspace: WORKSPACE_SCOPE, refresh: { mode: "force_refresh" }, limits: { max_item_depth: 20, max_items: 50000 } });
  const inventory = String(created.structuredContent?.inventory);
  const before = await call(server, "yfy_inventory_get", { inventory });
  assert.notEqual(before.isError, true, JSON.stringify(before.content));
  configuredRoot = "999";
  const after = await call(server, "yfy_inventory_get", { inventory });
  assert.equal(errorCode(after), "YFY_INVENTORY_STALE");
  assert.equal(errorCategory(after), "stale_state");
});

test("inventory root_folder rejects conflicting path and storage-space evidence", async () => {
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
  assert.match(JSON.stringify(result.content), /conflicting_membership_evidence/);
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

test("ordinary open does not require workspace ancestry metadata", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "ordinary.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1" })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "ordinary.pdf", tempPath: "C:/temp/ordinary.pdf", sha1: "a".repeat(40), sha256: "b".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"5".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_open", { file: FILE_10 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.equal(((result.structuredContent?.assurance as Record<string, unknown>).checks as Record<string, unknown>).workspace_membership, "not_applicable");
  assert.equal(result.structuredContent?.must_release, true);
  const delivery = result.structuredContent?.content_delivery as Record<string, unknown>;
  assert.equal(delivery.host_auto_fetch_not_guaranteed, true);
  assert.equal(delivery.mode, "binary_no_preview");
  assert.equal(delivery.resource_fetch_required, true);
  assert.equal(delivery.embedded_resource_in_tool_result, false);
  assert.equal((result.structuredContent?.resource as Record<string, unknown>).must_release, true);
  assert.equal((result.structuredContent?.resource as Record<string, unknown>).media_type, "application/pdf");
  assert.equal((result.structuredContent?.resource as Record<string, unknown>).media_type_source, "file_extension");
});

test("open returns inline preview for small text and svg media types", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-open-preview-"));
  const svgPath = path.join(dir, "icon.svg");
  const svgBody = `<svg xmlns="http://www.w3.org/2000/svg"><text>${"x".repeat(16_000)}</text></svg>`;
  await fs.writeFile(svgPath, svgBody);
  const registry = new EvidenceArtifactRegistry(60, 1024 * 1024);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], maxEvidenceResourceBytes: 1024 * 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: svgBody.length, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "icon.svg", type: "file", size: svgBody.length, modified_at: 1, file_version_key: "v1" })
    },
    client: {
      downloadFromUrlToTemp: async () => ({
        fileName: "icon.svg",
        tempPath: svgPath,
        sha1: "a".repeat(40),
        sha256: crypto.createHash("sha256").update(svgBody).digest("hex"),
        sizeBytes: svgBody.length,
        contentType: "application/octet-stream",
        meta: response("/download", {}).meta
      })
    },
    evidence: registry
  } as unknown as AppRuntime;
  try {
    registerWorkspaceContentTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_open", { file: FILE_10 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.structuredContent?.must_release, true);
    const resource = result.structuredContent?.resource as Record<string, unknown>;
    assert.equal(resource.media_type, "image/svg+xml");
    assert.equal(resource.media_type_source, "file_extension");
    assert.equal(resource.preview_text, svgBody);
    assert.equal(resource.preview_complete, true);
    assert.equal(resource.preview_bytes, Buffer.byteLength(svgBody));
    const delivery = result.structuredContent?.content_delivery as Record<string, unknown>;
    assert.equal(delivery.mode, "inline_preview");
    assert.equal(delivery.resource_fetch_required, false);
    assert.equal(delivery.embedded_resource_in_tool_result, true);
    assert.equal(delivery.preview_charset, "utf-8");
    const embedded = result.content?.find((entry) => entry.type === "resource");
    assert.equal(embedded?.resource?.text, svgBody);
    assert.match(String(embedded?.resource?.uri), /^yfy:\/\/evidence\//);
    const textEnvelope = JSON.parse(result.content?.find((entry) => entry.type === "text")?.text ?? "{}") as { text_delivery?: { mode?: string } };
    assert.equal(textEnvelope.text_delivery?.mode, "compact_preview");
    const disabled = await call(server, "yfy_open", { file: FILE_10, include_text_preview: false });
    const disabledDelivery = disabled.structuredContent?.content_delivery as Record<string, unknown>;
    assert.equal(disabledDelivery.mode, "resource_link_only");
    assert.equal(disabledDelivery.reason, "preview_disabled_by_request");
    assert.equal((disabled.structuredContent?.resource as Record<string, unknown>).preview_text, undefined);
    assert.equal(disabled.content?.some((entry) => entry.type === "resource"), false);
  } finally {
    await registry.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("open refuses an inline preview whose bytes no longer match the registered digest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-open-preview-drift-"));
  const tempPath = path.join(dir, "changed.svg");
  const changed = "<svg>changed</svg>";
  await fs.writeFile(tempPath, changed);
  const registry = new EvidenceArtifactRegistry(60, 1024 * 1024);
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["drive"], maxEvidenceResourceBytes: 1024 * 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    gateway: {
      context: access,
      getUser: async (endpoint: string) => endpoint.endsWith("/versions")
        ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: changed.length, modified_at: 1 }] })
        : endpoint.endsWith("/download_v2")
          ? response(endpoint, { download_url: "https://download.example/file" })
          : response(endpoint, { id: 10, name: "changed.svg", type: "file", size: changed.length, modified_at: 1, file_version_key: "v1" })
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "changed.svg", tempPath, sha1: "a".repeat(40), sha256: "b".repeat(64), sizeBytes: changed.length, contentType: "image/svg+xml", meta: response("/download", {}).meta }) },
    evidence: registry
  } as unknown as AppRuntime;
  try {
    registerWorkspaceContentTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_open", { file: FILE_10 });
    assert.equal(result.isError, true);
    assert.equal(errorCode(result), "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED");
    await assert.rejects(() => fs.stat(tempPath), { code: "ENOENT" });
  } finally {
    await registry.close().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence capture rejects a current file version key for historical content", async () => {
  const server = new FakeServer();
  const runtime = { config: { toolsets: ["evidence"] }, access: { resolveWorkspaceRef: scopedAccess } } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7, expected: { file_version_key: "current-key" } });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_INPUT_INVALID");
});

test("evidence capture validates a historical version with the reverse-ordinal strategy", async () => {
  const server = new FakeServer();
  let requestedVersion: unknown;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
          { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
          { id: 7, current: false, sha1: "b".repeat(40), size: 9, modified_at: 1 }
        ] });
        if (endpoint.endsWith("/download_v2")) { requestedVersion = params.version; return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/evidence.pdf", sha1: "b".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"1".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
  assert.notEqual(result.isError, true);
  assert.equal(requestedVersion, 1);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "historical_reverse_ordinal");
  assert.deepEqual((result.structuredContent?.provenance as Array<Record<string, unknown>>).map((entry) => entry.operation), [
    "file_metadata_before", "workspace_root_metadata_before", "version_history_before", "download_ticket", "content_download", "version_history_after", "file_metadata_after", "workspace_root_metadata_after"
  ]);
});

test("evidence capture falls back to a validated historical version-id strategy", async () => {
  const server = new FakeServer();
  const requestedVersions: unknown[] = [];
  let selectedVersion: unknown;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      getUser: async (endpoint: string, _context: string, params: Record<string, unknown>) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }, { id: 7, current: false, sha1: "b".repeat(40), size: 9 }, { id: 8, current: false, sha1: "e".repeat(40), size: 8 }] });
        if (endpoint.endsWith("/download_v2")) { selectedVersion = params.version; requestedVersions.push(params.version); return response(endpoint, { download_url: "https://download.example/file" }); }
        return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => selectedVersion === "7"
      ? ({ fileName: "evidence.pdf", tempPath: "C:/temp/history.pdf", sha1: "b".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta })
      : ({ fileName: "evidence.pdf", tempPath: "C:/temp/current.pdf", sha1: "a".repeat(40), sha256: "d".repeat(64), sizeBytes: 10, meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"2".repeat(48)}` }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.deepEqual(requestedVersions, [2, 1, "7"]);
  assert.equal((result.structuredContent?.selection as Record<string, unknown>).download_strategy, "historical_version_id");
});

test("evidence capture returns provider-contract diagnostics when history is unavailable", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveWorkspaceRef: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [
        { current: true, sha1: "a".repeat(40), size: 10 },
        { id: 7, current: false, sha1: "b".repeat(40), size: 9 }
      ] });
      if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/current.pdf", sha1: "a".repeat(40), sha256: "d".repeat(64), sizeBytes: 10, meta: response("/download", {}).meta }) }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_HISTORICAL_CAPTURE_UNAVAILABLE");
  assert.match(JSON.stringify(result.content), /provider_contract|attempts/);
});

test("historical evidence capture preserves authorization errors", async () => {
  const server = new FakeServer();
  let downloadRequests = 0;
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveWorkspaceRef: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }, { id: 7, current: false, sha1: "b".repeat(40), size: 9 }] });
      if (endpoint.endsWith("/download_v2")) {
        downloadRequests += 1;
        throw new YifangyunError("forbidden", { code: "YFY_PERMISSION_DENIED", statusCode: 403 });
      }
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10, version: VERSION_10_7 });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_PERMISSION_DENIED");
  assert.equal(downloadRequests, 1);
});

test("current evidence capture rejects disagreement with current file metadata", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" }, access: { resolveWorkspaceRef: scopedAccess },
    gateway: { getUser: async (endpoint: string) => {
      if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9 }] });
      if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
      return response(endpoint, { id: "10", name: "evidence.pdf", type: "file", size: 10, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
    } },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/metadata-mismatch.pdf", sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => { throw new Error("mismatched evidence must not be registered"); } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10 });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EVIDENCE_DRIFT");
  assert.match(JSON.stringify(result.content), /current_metadata_size/);
});

test("capture rolls back content when an expectation does not match", async () => {
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1024, tempFileTtlSeconds: 60, transport: "stdio" },
    access: { resolveWorkspaceRef: scopedAccess },
    gateway: {
      getUser: async (endpoint: string) => {
        if (endpoint.endsWith("/versions")) return response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 9, modified_at: 1 }] });
        if (endpoint.endsWith("/download_v2")) return response(endpoint, { download_url: "https://download.example/file" });
        return response(endpoint, { id: 10, name: "evidence.pdf", type: "file", size: 9, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] });
      }
    },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.pdf", tempPath: "C:/temp/evidence.pdf", sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 9, meta: response("/download", {}).meta }) },
    evidence: { register: () => { throw new Error("mismatched content must not be registered"); } }
  } as unknown as AppRuntime;
  registerWorkspaceContentTools(server as unknown as McpServer, runtime);
  const result = await call(server, "yfy_capture", { file: FILE_10, workspace: WORKSPACE_SCOPE, expected: { sha256: "d".repeat(64) } });
  assert.equal(result.isError, true);
  assert.equal(errorCode(result), "YFY_EXPECTATION_MISMATCH");
  assert.match(JSON.stringify(result.content), /actual|expected|sha256/);
});

test("large captured content returns a multipart resource without a local path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-evidence-large-"));
  const tempPath = path.join(dir, "evidence.bin");
  await fs.writeFile(tempPath, "content");
  const server = new FakeServer();
  const runtime = {
    config: { toolsets: ["evidence"], maxEvidenceResourceBytes: 1, tempFileTtlSeconds: 60, transport: "http" }, access: { resolveWorkspaceRef: scopedAccess },
    gateway: { getUser: async (endpoint: string) => endpoint.endsWith("/versions")
      ? response(endpoint, { file_versions: [{ current: true, sha1: "a".repeat(40), size: 7, modified_at: 1 }] })
      : endpoint.endsWith("/download_v2") ? response(endpoint, { download_url: "https://download.example/file" })
        : response(endpoint, { id: 10, name: "evidence.bin", type: "file", size: 7, modified_at: 1, file_version_key: "v1", path: [{ id: 501, name: "Root", type: "folder" }] }) },
    client: { downloadFromUrlToTemp: async () => ({ fileName: "evidence.xls", tempPath, sha1: "a".repeat(40), sha256: "c".repeat(64), sizeBytes: 7, contentType: "application/excel", meta: response("/download", {}).meta }) },
    evidence: { register: () => `yfy://evidence/${"4".repeat(48)}` }
  } as unknown as AppRuntime;
  try {
    registerWorkspaceContentTools(server as unknown as McpServer, runtime);
    const result = await call(server, "yfy_capture", { workspace: WORKSPACE_SCOPE, file: FILE_10 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const resource = result.structuredContent?.resource as Record<string, unknown>;
    assert.equal(resource.delivery, "multipart_resource");
    assert.equal(resource.media_type, "application/vnd.ms-excel");
    assert.equal(resource.media_type_source, "content_type");
    assert.equal(resource.must_release, true);
    assert.equal(resource.preview_text, undefined);
    assert.match(String(resource.resource_uri), /\/manifest$/);
    assert.equal(result.structuredContent?.must_release, true);
    const delivery = result.structuredContent?.content_delivery as Record<string, unknown>;
    assert.equal(delivery.mode, "multipart_manifest_only");
    assert.equal(delivery.resource_fetch_required, true);
    assert.equal(delivery.embedded_resource_in_tool_result, false);
    assert.equal(delivery.host_auto_fetch_not_guaranteed, true);
    const link = result.content?.find((entry) => entry.type === "resource_link") as ({ mimeType?: string } | undefined);
    assert.equal(link?.mimeType, "application/json");
    assert.equal(resource.local_path, undefined);
    assert.equal((await fs.stat(tempPath)).size, 7);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
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
  const omitted = await call(server, "yfy_department_users", { request: { mode: "first_request", department_id: "1", include_contact: false } });
  assert.deepEqual(omitted.structuredContent?.contact_policy, { requested: false, fields: "omitted_by_default" });
  const included = await call(server, "yfy_department_users", { request: { mode: "first_request", department_id: "1", include_contact: true } });
  assert.deepEqual(included.structuredContent?.contact_policy, { requested: true, fields: "included" });
  providerHasContact = false;
  const unavailable = await call(server, "yfy_department_users", { request: { mode: "first_request", department_id: "1", include_contact: true } });
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
