import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunClient, YifangyunError } from "../client.js";
import { ScopeScanEngine } from "../scan/engine.js";
import { ScopeScanStore } from "../scan/store.js";
import type { ScopeScanPage, ScopeScanPolicy, ScopeScanState } from "../scan/types.js";
import type { ApiJsonResponse, AppConfig, IdLike, JsonArray, JsonObject, JsonValue } from "../types.js";
import { SERVER_VERSION } from "../version.js";
import { metrics } from "../observability.js";
import { TtlCache } from "../cache.js";

const IdSchema = z.union([z.string().trim().regex(/^\d+$/), z.number().int().nonnegative()]);
const OptionalIdSchema = z.union([IdSchema, z.literal("")]).optional();
const ScanEnvelopeSchema = z.object({
  ok: z.boolean(),
  request_succeeded: z.boolean(),
  outcome: z.string(),
  server_version: z.string(),
  data: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional()
});

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

function idText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeOptionalId(value: IdLike | "" | undefined): IdLike | undefined {
  return value === "" ? undefined : value;
}

function compactItem(value: JsonValue | undefined): JsonObject {
  const source = objectValue(value);
  if (!source) {
    return {};
  }
  const output: JsonObject = {};
  for (const key of ["id", "name", "type", "size", "description", "extension", "extension_category", "folder_type", "file_version_key", "sha1", "parent_folder_id", "modified_at", "created_at", "is_deleted", "in_trash"] as const) {
    const field = source[key];
    if (key.endsWith("_id") || key === "id") {
      if (typeof field === "string" || typeof field === "number") {
        output[key] = String(field);
      }
    } else if (field === null || typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      output[key] = field;
    }
  }
  if (numberValue(source.modified_at) !== undefined) {
    output.modified_at_unix = source.modified_at as number;
    output.modified_at_iso = new Date((source.modified_at as number) * 1000).toISOString();
  }
  const parent = objectValue(source.parent);
  if (parent) {
    output.parent_folder_id = idText(parent.id) ?? output.parent_folder_id ?? "";
  }
  const space = objectValue(source.space);
  if (space) {
    output.space = { id: idText(space.id) ?? "", name: typeof space.name === "string" ? space.name : "", type: typeof space.type === "string" ? space.type : "" };
  }
  const path: JsonObject[] = [];
  for (const entry of arrayValue(source.path)) {
    const item = objectValue(entry);
    if (item) {
      path.push({ id: idText(item.id) ?? "", name: typeof item.name === "string" ? item.name : "", type: typeof item.type === "string" ? item.type : "" });
    }
  }
  if (path.length) {
    output.path_chain = path;
  }
  return output;
}

function compactPage(response: ApiJsonResponse, requestedPageId: number, requestedCapacity: number): ScopeScanPage {
  const source = objectValue(response.data) ?? {};
  const folders = arrayValue(source.folders).map(compactItem).filter((item) => Object.keys(item).length > 0);
  const files = arrayValue(source.files).map(compactItem).filter((item) => Object.keys(item).length > 0);
  const pageId = numberValue(source.page_id) ?? requestedPageId;
  const pageCapacity = numberValue(source.page_capacity) ?? requestedCapacity;
  const pageCount = numberValue(source.page_count);
  const totalCount = numberValue(source.total_count);
  const explicitHasMore = booleanValue(source.has_more);
  const hasMore = explicitHasMore ?? (pageCount !== undefined ? pageId + 1 < pageCount : totalCount !== undefined ? (pageId + 1) * pageCapacity < totalCount : false);
  return {
    files,
    folders,
    hasMore,
    meta: response.meta,
    ...(hasMore ? { nextPageId: numberValue(source.next_page_id) ?? pageId + 1 } : {}),
    pageCapacity,
    ...(pageCount !== undefined ? { pageCount } : {}),
    pageId,
    paginationReliable: explicitHasMore !== undefined || pageCount !== undefined || totalCount !== undefined,
    ...(totalCount !== undefined ? { totalCount } : {})
  };
}

function success(data: JsonObject, outcome = "success", summary?: string) {
  const output = { ok: true, request_succeeded: true, outcome, server_version: SERVER_VERSION, data };
  return {
    content: [{ type: "text" as const, text: summary ?? `${outcome}: ${JSON.stringify(data).slice(0, 500)}` }],
    structuredContent: output
  };
}

function failure(error: unknown) {
  const yfy = error instanceof YifangyunError ? error : new YifangyunError(error instanceof Error ? error.message : String(error));
  const output = {
    ok: false,
    request_succeeded: false,
    outcome: "error",
    server_version: SERVER_VERSION,
    error: {
      code: yfy.code,
      message: yfy.message,
      phase: yfy.phase ?? "workflow",
      retryable: yfy.retryable,
      ...(yfy.scanId ? { scan_id: yfy.scanId } : {}),
      ...(yfy.suggestedAction ? { suggested_action: yfy.suggestedAction } : {}),
      ...(yfy.details ? { details: yfy.details } : {})
    }
  };
  return { content: [{ type: "text" as const, text: `${yfy.code}: ${yfy.message}` }], structuredContent: output, isError: true };
}

function scanOutcome(state: ScopeScanState): string {
  return state.status === "complete" ? "complete" : state.status === "running" ? "running" : state.status;
}

export function registerWorkflowTools(server: McpServer, client: YifangyunClient, config: AppConfig): void {
  const departmentCache = new TtlCache<ApiJsonResponse>("department", 300000);
  const store = new ScopeScanStore(config.scanDir ?? `${config.tempDir}/scans`, config.scanTtlSeconds ?? 604800, config.maxScanBytes ?? 2147483648);
  const provider = {
    getRoot: async (folderId: IdLike, userId?: IdLike) => {
      const response = await client.getAsUser(`/v2/folder/${encodeURIComponent(String(folderId))}/info`, userId);
      return { folder: compactItem(response.data), meta: response.meta };
    },
    listChildren: async (folderId: IdLike, userId: IdLike | undefined, pageId: number, pageCapacity: number, signal?: AbortSignal) => {
      const response = await client.getAsUser(`/v2/folder/${encodeURIComponent(String(folderId))}/children`, userId, {
        type: "all",
        page_id: pageId,
        page_capacity: Math.min(pageCapacity, config.maxPageCapacity)
      }, signal);
      return compactPage(response, pageId, pageCapacity);
    }
  };
  const engine = new ScopeScanEngine(store, provider);

  const register = (name: string, definition: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: Record<string, unknown>, extra: { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (notification: unknown) => Promise<void> }) => Promise<ReturnType<typeof success>>) => {
    server.registerTool(name, {
      ...definition,
      outputSchema: ScanEnvelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async (args, extra) => {
      try {
        return await handler(args as Record<string, unknown>, extra as never);
      } catch (error) {
        return failure(error);
      }
    });
  };

  const identityFor = (userId: IdLike | undefined, externalEnterpriseId: IdLike | undefined) => client.resolveAccessIdentityRef(userId, externalEnterpriseId);
  const assertScanIdentity = async (scanId: string, userId: IdLike | undefined, externalEnterpriseId: IdLike | undefined) => {
    const state = await engine.get(scanId);
    if (state.accessIdentityRef !== identityFor(userId, externalEnterpriseId)) {
      throw new YifangyunError("Scope scan belongs to a different access identity.", { code: "YFY_SCAN_IDENTITY_MISMATCH", phase: "scan_access", scanId });
    }
    return state;
  };

  register("yfy_start_scope_scan", {
    title: "Start Durable Yifangyun Scope Scan",
    description: "Create or reuse a durable, identity-scoped scan for a root folder. Returns immediately without traversing the whole tree.",
    inputSchema: {
      root_folder_id: IdSchema,
      queries: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
      match_fields: z.array(z.enum(["name", "path"])).min(1).default(["name", "path"]),
      max_depth: z.number().int().min(0).max(100).default(20),
      max_items: z.number().int().min(1).max(1000000).default(50000),
      page_capacity: z.number().int().min(1).max(500).default(200),
      include_files: z.boolean().default(true),
      include_folders: z.boolean().default(true),
      case_sensitive: z.boolean().default(false),
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const policy: ScopeScanPolicy = {
      caseSensitive: args.case_sensitive as boolean,
      includeFiles: args.include_files as boolean,
      includeFolders: args.include_folders as boolean,
      matchFields: args.match_fields as Array<"name" | "path">,
      maxDepth: args.max_depth as number,
      maxItems: args.max_items as number,
      pageCapacity: Math.min(args.page_capacity as number, config.maxPageCapacity),
      queries: args.queries as string[]
    };
    const started = await engine.start({
      accessIdentityRef: identityFor(userId, externalEnterpriseId),
      externalEnterpriseId,
      policy,
      rootFolderId: args.root_folder_id as IdLike,
      userId
    });
    return success(engine.summary(started.state), started.reused ? "reused" : "started", `scan ${started.state.scanId} ${started.reused ? "reused" : "started"} at revision ${started.state.revision}`);
  });

  register("yfy_advance_scope_scan", {
    title: "Advance Durable Yifangyun Scope Scan",
    description: "Process a bounded number of folder pages and commit a new revision. Safe to resume after timeout or process restart.",
    inputSchema: {
      scan_id: z.string().uuid(),
      expected_revision: z.number().int().nonnegative(),
      max_pages: z.number().int().min(1).max(10).default(5),
      max_wall_ms: z.number().int().min(500).max(30000).default(10000),
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args, extra) => {
    const scanId = args.scan_id as string;
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const before = await assertScanIdentity(scanId, userId, externalEnterpriseId);
    const state = await engine.advance({
      expectedRevision: args.expected_revision as number,
      maxPages: args.max_pages as number,
      maxWallMs: args.max_wall_ms as number,
      scanId,
      signal: extra.signal,
      userId
    });
    if (extra._meta?.progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken: extra._meta.progressToken, progress: state.pageReceiptCount, message: `${state.status}, revision ${state.revision}` } });
    }
    const summary = engine.summary(state);
    if (state.policy.queries.length) {
      const partialMatches = await engine.search(state.scanId, state.policy.queries, 0, 20);
      summary.partial_match_count = partialMatches.total;
      summary.partial_matches = partialMatches.items;
      summary.partial_matches_truncated = partialMatches.total > partialMatches.items.length;
    }
    const pageDelta = state.pageReceiptCount - before.pageReceiptCount;
    if (state.status === "running") {
      summary.step_boundary_reason = pageDelta >= (args.max_pages as number) ? "max_pages" : "max_wall_ms";
      summary.step_code = "YFY_SCAN_STEP_BUDGET_REACHED";
    }
    return success(summary, state.status === "running" ? "paused_budget" : scanOutcome(state), `scan ${scanId}: ${state.status}, revision ${state.revision}, pages ${state.pageReceiptCount}`);
  });

  register("yfy_get_scope_scan", {
    title: "Get Durable Yifangyun Scope Scan",
    description: "Return durable scan status, progress, completeness, observation window and recovery revision.",
    inputSchema: { scan_id: z.string().uuid(), external_enterprise_id: OptionalIdSchema, user_id: OptionalIdSchema }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const state = await assertScanIdentity(args.scan_id as string, userId, externalEnterpriseId);
    return success(engine.summary(state), scanOutcome(state), `scan ${state.scanId}: ${state.status}, revision ${state.revision}`);
  });

  register("yfy_cancel_scope_scan", {
    title: "Cancel Durable Yifangyun Scope Scan",
    description: "Explicitly cancel a durable scan. Transport disconnects do not automatically cancel durable scan state.",
    inputSchema: { scan_id: z.string().uuid(), expected_revision: z.number().int().nonnegative().optional(), external_enterprise_id: OptionalIdSchema, user_id: OptionalIdSchema }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    await assertScanIdentity(args.scan_id as string, userId, externalEnterpriseId);
    const state = await engine.cancel(args.scan_id as string, args.expected_revision as number | undefined);
    return success(engine.summary(state), "cancelled", `scan ${state.scanId} cancelled at revision ${state.revision}`);
  });

  register("yfy_search_scope_snapshot", {
    title: "Search Durable Yifangyun Scope Snapshot",
    description: "Search page artifacts from an existing scan without re-reading the Provider tree. Supports multiple normalized queries.",
    inputSchema: {
      scan_id: z.string().uuid(),
      queries: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const state = await assertScanIdentity(args.scan_id as string, userId, externalEnterpriseId);
    const result = await engine.search(state.scanId, args.queries as string[], args.offset as number, args.limit as number);
    const scanSummary = engine.summary(state);
    return success({
      authority: scanSummary.pagination_complete === true ? "complete_observation" : "partial_observation",
      items: result.items,
      limit: args.limit as number,
      offset: args.offset as number,
      pagination_complete: scanSummary.pagination_complete === true,
      safe_to_claim_absence: scanSummary.safe_to_claim_absence === true,
      scan_id: state.scanId,
      total_matches: result.total
    }, "success", `scan ${state.scanId}: ${result.total} matches, returning ${result.items.length}`);
  });

  register("yfy_list_scope_scan_matches", {
    title: "List Durable Yifangyun Scope Scan Matches",
    description: "List matches using the query set stored in the scan policy, without issuing Provider directory requests.",
    inputSchema: {
      scan_id: z.string().uuid(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const state = await assertScanIdentity(args.scan_id as string, userId, externalEnterpriseId);
    if (!state.policy.queries.length) {
      throw new YifangyunError("The scan policy does not contain queries.", { code: "YFY_SCAN_QUERY_SET_EMPTY", phase: "scan_search", scanId: state.scanId });
    }
    const result = await engine.search(state.scanId, state.policy.queries, args.offset as number, args.limit as number);
    return success({ items: result.items, limit: args.limit as number, offset: args.offset as number, scan_id: state.scanId, total_matches: result.total }, "success", `scan ${state.scanId}: ${result.total} stored-query matches`);
  });

  register("yfy_list_scope_snapshot_items", {
    title: "List Durable Yifangyun Scope Snapshot Items",
    description: "Page through items stored in durable scan artifacts without loading the complete snapshot into one MCP response.",
    inputSchema: {
      scan_id: z.string().uuid(),
      type: z.enum(["file", "folder", "all"]).default("all"),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const state = await assertScanIdentity(args.scan_id as string, userId, externalEnterpriseId);
    const result = await engine.listItems(state.scanId, args.type as "file" | "folder" | "all", args.offset as number, args.limit as number);
    const hasMore = (args.offset as number) + result.items.length < result.total;
    return success({
      has_more: hasMore,
      items: result.items,
      limit: args.limit as number,
      ...(hasMore ? { next_offset: (args.offset as number) + result.items.length } : {}),
      offset: args.offset as number,
      scan_id: state.scanId,
      total_count: result.total
    }, "success", `scan ${state.scanId}: returning ${result.items.length} of ${result.total} items`);
  });

  register("yfy_batch_assert_files_in_scope", {
    title: "Batch Assert Yifangyun Files In Scope",
    description: "Assert that every requested file belongs to one root folder. Returns a business failure when any file is outside scope.",
    inputSchema: {
      file_ids: z.array(IdSchema).min(1).max(100),
      root_folder_id: IdSchema,
      external_enterprise_id: OptionalIdSchema,
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const externalEnterpriseId = normalizeOptionalId(args.external_enterprise_id as IdLike | "" | undefined);
    const rootId = String(args.root_folder_id as IdLike);
    const results: JsonObject[] = [];
    for (const fileId of args.file_ids as IdLike[]) {
      const response = await client.getAsUser(`/v2/file/${encodeURIComponent(String(fileId))}/info_v2`, userId, {
        external_enterprise_id: externalEnterpriseId === undefined ? undefined : String(externalEnterpriseId)
      });
      const file = compactItem(response.data);
      const ancestorIds = arrayValue(file.path_chain).map((entry) => idText(objectValue(entry)?.id)).filter((value): value is string => Boolean(value));
      const inScope = ancestorIds.includes(rootId) || String(file.parent_folder_id ?? "") === rootId;
      results.push({ file_id: String(fileId), in_scope: inScope });
    }
    const assertionPassed = results.every((result) => result.in_scope === true);
    metrics.increment("scope_assertion_total", { outcome: assertionPassed ? "inside_scope" : "outside_scope" });
    if (!assertionPassed) {
      throw new YifangyunError("One or more files are outside the requested root scope.", {
        code: "YFY_SCOPE_ASSERTION_FAILED",
        details: { results, root_folder_id: rootId },
        phase: "batch_scope_assertion"
      });
    }
    return success({ assertion_passed: true, results, root_folder_id: rootId }, "inside_scope", `${results.length} files are inside scope`);
  });

  register("yfy_get_server_metrics", {
    title: "Get Yifangyun MCP Metrics",
    description: "Return in-process counters and latency aggregates without credentials, URLs or file content.",
    inputSchema: {}
  }, async () => success(metrics.snapshot(), "success", "server metrics returned"));

  register("yfy_validate_authority_root", {
    title: "Validate Yifangyun Authority Root",
    description: "Compose folder metadata, department ancestry and bounded reachability checks without claiming unsupported remote write permissions.",
    inputSchema: {
      root_folder_id: IdSchema,
      expected_path: z.array(z.string().trim().min(1)).max(50).optional(),
      user_id: OptionalIdSchema
    }
  }, async (args) => {
    const userId = normalizeOptionalId(args.user_id as IdLike | "" | undefined);
    const folderResponse = await client.getAsUser(`/v2/folder/${encodeURIComponent(String(args.root_folder_id))}/info`, userId);
    const folder = compactItem(folderResponse.data);
    const space = objectValue(folder.space);
    const departmentChain: JsonObject[] = [];
    let departmentId = idText(space?.id);
    const seen = new Set<string>();
    while (departmentId && departmentId !== "0" && departmentChain.length < 50 && !seen.has(departmentId)) {
      seen.add(departmentId);
      const response = await departmentCache.getOrLoad(departmentId, () => client.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId!)}/info`));
      const source = objectValue(response.data) ?? {};
      const department: JsonObject = { id: idText(source.id) ?? departmentId, name: typeof source.name === "string" ? source.name : "", parent_id: idText(source.parent_id) ?? "" };
      departmentChain.unshift(department);
      departmentId = idText(source.parent_id);
    }
    const firstPageResponse = await client.getAsUser(`/v2/folder/${encodeURIComponent(String(args.root_folder_id))}/children`, userId, { type: "all", page_id: 0, page_capacity: 1 });
    const firstPage = compactPage(firstPageResponse, 0, 1);
    let lastPageReachable = true;
    if (firstPage.pageCount !== undefined && firstPage.pageCount > 1) {
      await client.getAsUser(`/v2/folder/${encodeURIComponent(String(args.root_folder_id))}/children`, userId, { type: "all", page_id: firstPage.pageCount - 1, page_capacity: 1 });
    }
    const businessPath = [...departmentChain.map((item) => String(item.name ?? "")), String(folder.name ?? "")].filter(Boolean);
    const expectedPath = args.expected_path as string[] | undefined;
    const expectedPathMatches = expectedPath === undefined || JSON.stringify(businessPath.slice(-expectedPath.length)) === JSON.stringify(expectedPath);
    const checks: JsonObject = {
      accessible: true,
      configured_root_matches: config.authorityRootFolderId === undefined || String(config.authorityRootFolderId) === String(args.root_folder_id),
      exists: Boolean(folder.id),
      expected_path_matches: expectedPathMatches,
      first_page_reachable: true,
      last_page_reachable: lastPageReachable,
      not_deleted: folder.is_deleted !== true && folder.in_trash !== true,
      server_mutation_disabled: !config.enableMutationTools
    };
    const validationPassed = checks.accessible === true
      && checks.configured_root_matches === true
      && checks.exists === true
      && checks.expected_path_matches === true
      && checks.first_page_reachable === true
      && checks.last_page_reachable === true
      && checks.not_deleted === true;
    const observation = {
      access_identity_ref: identityFor(userId, undefined),
      business_path: businessPath,
      checks,
      configured_root: config.authorityRootFolderId === undefined ? null : String(config.authorityRootFolderId),
      department_chain: departmentChain,
      folder_path: arrayValue(folder.path_chain),
      observation_digest: crypto.createHash("sha256").update(JSON.stringify({ folder, departmentChain, checks })).digest("hex"),
      observed_at: new Date().toISOString(),
      observed_root: folder,
      provider_effective_write_permission: "unknown",
      validation_passed: validationPassed
    } as unknown as JsonObject;
    return success(observation, validationPassed ? "validated" : "validation_failed", validationPassed ? "authority root validated" : "authority root validation failed");
  });

  server.registerResource(
    "yfy_scope_scan_manifest",
    new ResourceTemplate("yfy://scan/{scan_id}/{artifact_token}/manifest", { list: undefined }),
    { title: "Yifangyun Scope Scan Manifest", description: "Durable scan receipts and observation digest.", mimeType: "application/json" },
    async (uri, variables) => {
      const state = await engine.get(String(variables.scan_id));
      if (state.artifactToken !== String(variables.artifact_token)) {
        throw new YifangyunError("Scope scan artifact token is invalid.", { code: "YFY_SCAN_ARTIFACT_FORBIDDEN", phase: "scan_resource", scanId: state.scanId });
      }
      const manifest = await engine.manifest(state.scanId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }] };
    }
  );
}
