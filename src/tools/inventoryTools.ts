import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { decodeCanonicalBase64Url } from "../domain/base64url.js";
import { formatItemRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { projectInventoryReceipt } from "../scan/projectors.js";
import type { ScopeItemCursor, ScopeScanState } from "../scan/types.js";
import type { JsonObject } from "../types.js";
import { continuationAction, pageOutput, paginatedRequestSchema, parsePaginatedRequest } from "./pagination.js";
import { FolderRefSchema, NextActionSchema, SimplePageSchema, WorkspaceRefSchema } from "./schemas.js";
import { registerTool } from "./tooling.js";

const InventoryStatusSchema = z.enum(["running", "retry_wait", "complete", "partial", "cancelled", "failed"]);
const InventoryRefSchema = z.string().regex(/^inventory:[A-Za-z0-9_-]+$/);
const DEFAULT_INVENTORY_PAGE_SIZE = 25;
const CompletenessSchema = z.object({ pagination_complete: z.boolean(), safe_to_claim_absence: z.boolean(), scope: z.enum(["entire_observed_accessible_scope", "observed_subset_only"]), consistency_level: z.enum(["best_effort_complete_observation", "partial_observation"]), incomplete_reasons: z.array(z.string()) }).strict();
const WorkspaceIdentitySchema = z.object({ ref: WorkspaceRefSchema, root: FolderRefSchema, access_context: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const InventorySummaryShape = {
  inventory: InventoryRefSchema,
  workspace: WorkspaceIdentitySchema,
  status: InventoryStatusSchema,
  terminal: z.boolean(),
  counts: z.object({ files: z.number().int().nonnegative(), folders: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }).strict(),
  completeness: CompletenessSchema,
  freshness: z.object({ age_seconds: z.number().int().nonnegative(), observed_at: z.string() }).strict(),
  limits: z.object({ max_item_depth: z.number().int().min(1), max_items: z.number().int().positive() }).strict(),
  checkpoint: z.object({ commit_watermark: z.number().int().nonnegative(), control_revision: z.number().int().nonnegative(), remaining_frontier_count: z.number().int().nonnegative() }).strict(),
  diagnostics: z.object({ retry_count: z.number().int().nonnegative(), next_retry_at: z.string().optional(), last_error: z.record(z.unknown()).optional(), incomplete_reasons: z.array(z.string()) }).strict(),
  retention: z.object({ expires_at: z.string(), storage: z.object({ database_bytes: z.number().int().nonnegative(), logical_bytes: z.number().int().nonnegative(), wal_bytes: z.number().int().nonnegative() }).strict() }).strict(),
  observation_window: z.object({ started_at: z.string(), updated_at: z.string() }).strict(),
  created_at: z.string(), updated_at: z.string(), manifest_uri: z.string(), receipts_uri_template: z.string(), next_action: NextActionSchema.optional()
};

const RefreshSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("reuse_if_fresh"), max_age_seconds: z.number().int().min(0).max(604800).default(300) }).strict(),
  z.object({ mode: z.literal("force_refresh") }).strict()
]);
const InventorySearchRequestSchema = paginatedRequestSchema({
  query: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(["file", "folder", "all"]).default("all"),
  match_fields: z.array(z.enum(["name", "path"])).min(1).max(2).default(["name", "path"]),
  case_sensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(DEFAULT_INVENTORY_PAGE_SIZE)
});

const CursorSchema = z.object({
  item_id: z.string().min(1), item_type: z.enum(["file", "folder", "all"]), mode: z.enum(["search", "list"]), page_limit: z.number().int().min(1).max(100), query: z.string().optional(), match_fields: z.array(z.enum(["name", "path"])).min(1).max(2), case_sensitive: z.boolean(), query_spec_hash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/), inventory_id: z.string().uuid(), workspace_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), sort_path: z.string(), total: z.number().int().nonnegative(), watermark: z.number().int().nonnegative(), version: z.literal(2)
}).strict();

function signature(secret: string, value: unknown): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

function workspaceFingerprint(state: { contextId: string; identityRef: string; rootFolderId: string; workspaceId: string }, secret: string): string {
  return signature(secret, { access_context: state.contextId, identity_ref: state.identityRef, root_folder_id: state.rootFolderId, workspace_id: state.workspaceId, version: 2 });
}

function inventoryRef(secret: string, state: ScopeScanState): string {
  const payload = { access_context: state.accessContextId, inventory_id: state.scanId, version: 2, workspace_fingerprint: state.workspaceFingerprint };
  return `inventory:${Buffer.from(JSON.stringify({ ...payload, signature: signature(secret, payload) }), "utf8").toString("base64url")}`;
}

function parseInventoryRef(secret: string, value: unknown): { accessContext: string; inventoryId: string; workspaceFingerprint: string } {
  try {
    const encoded = String(value).slice("inventory:".length);
    const schema = z.object({ access_context: z.string(), inventory_id: z.string().uuid(), signature: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal(2), workspace_fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
    const parsed = schema.parse(JSON.parse(decodeCanonicalBase64Url(encoded).toString("utf8")));
    const payload = { access_context: parsed.access_context, inventory_id: parsed.inventory_id, version: parsed.version, workspace_fingerprint: parsed.workspace_fingerprint };
    const expected = Buffer.from(signature(secret, payload), "utf8");
    const actual = Buffer.from(parsed.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("signature mismatch");
    return { accessContext: parsed.access_context, inventoryId: parsed.inventory_id, workspaceFingerprint: parsed.workspace_fingerprint };
  } catch {
    throw new YifangyunError("Inventory reference is invalid.", { code: "YFY_INPUT_INVALID", phase: "inventory_reference", suggestedAction: "Copy the beta.7 inventory ref returned by yfy_inventory_create." });
  }
}

function querySpec(value: { caseSensitive: boolean; itemType: string; limit: number; matchFields: string[]; mode: string; query?: string }) {
  return { case_sensitive: value.caseSensitive, item_type: value.itemType, limit: value.limit, match_fields: [...value.matchFields].sort(), mode: value.mode, query: value.query ?? null };
}

function decodeCursor(value: unknown, ref: { inventoryId: string; workspaceFingerprint: string }, secret: string) {
  try {
    const parsed = CursorSchema.parse(JSON.parse(decodeCanonicalBase64Url(String(value)).toString("utf8")));
    const unsigned = { ...parsed } as Record<string, unknown>;
    delete unsigned.signature;
    if (parsed.inventory_id !== ref.inventoryId || parsed.workspace_fingerprint !== ref.workspaceFingerprint || parsed.query_spec_hash !== signature(secret, querySpec({ caseSensitive: parsed.case_sensitive, itemType: parsed.item_type, limit: parsed.page_limit, matchFields: parsed.match_fields, mode: parsed.mode, query: parsed.query }))) throw new Error("cursor context mismatch");
    const expected = Buffer.from(signature(secret, unsigned), "utf8");
    const actual = Buffer.from(parsed.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("cursor signature mismatch");
    return { cursor: { itemId: parsed.item_id, sortPath: parsed.sort_path, total: parsed.total, watermark: parsed.watermark } satisfies ScopeItemCursor, itemType: parsed.item_type, limit: parsed.page_limit, mode: parsed.mode, query: parsed.query, matchFields: parsed.match_fields, caseSensitive: parsed.case_sensitive };
  } catch {
    throw new YifangyunError("Inventory cursor is invalid.", { code: "YFY_INVENTORY_CURSOR_INVALID", phase: "inventory_search", suggestedAction: "Restart yfy_inventory_search with request.mode=first_request." });
  }
}

function encodeInventoryCursor(input: { caseSensitive: boolean; cursor: ScopeItemCursor; inventoryId: string; itemType: "file" | "folder" | "all"; limit: number; matchFields: Array<"name" | "path">; mode: "search" | "list"; query?: string; workspaceFingerprint: string }, secret: string): string {
  const spec = querySpec(input);
  const payload = { item_id: input.cursor.itemId, item_type: input.itemType, mode: input.mode, page_limit: input.limit, ...(input.query ? { query: input.query } : {}), match_fields: input.matchFields, case_sensitive: input.caseSensitive, query_spec_hash: signature(secret, spec), inventory_id: input.inventoryId, workspace_fingerprint: input.workspaceFingerprint, sort_path: input.cursor.sortPath, total: input.cursor.total, watermark: input.cursor.watermark, version: 2 as const };
  return Buffer.from(JSON.stringify({ ...payload, signature: signature(secret, payload) }), "utf8").toString("base64url");
}

async function stateForRef(runtime: AppRuntime, ref: ReturnType<typeof parseInventoryRef>) {
  const state = await runtime.snapshots.get(ref.inventoryId, ref.accessContext);
  if (state.workspaceFingerprint !== ref.workspaceFingerprint) throw new YifangyunError("Inventory reference belongs to a different workspace identity.", { code: "YFY_INVENTORY_ACCESS_DENIED", phase: "inventory_access", scanId: state.scanId });
  return state;
}

function summary(runtime: AppRuntime, state: ScopeScanState): JsonObject {
  const internal = runtime.snapshots.summary(state);
  const observedAt = state.observationUpdatedAt;
  const ref = inventoryRef(runtime.config.clientSecret, state);
  const next = ["running", "retry_wait"].includes(state.status) ? { tool: "yfy_inventory_get", arguments: { inventory: ref } } : undefined;
  return {
    inventory: ref,
    workspace: { ref: state.workspaceRef, root: formatItemRef("folder", state.rootFolderId, state.accessContextId, state.accessIdentityRef), access_context: state.accessContextId, fingerprint: state.workspaceFingerprint },
    status: state.status,
    terminal: internal.terminal === true,
    counts: { files: state.fileCount, folders: state.folderCount, pages: state.pageReceiptCount },
    completeness: internal.completeness as JsonObject,
    freshness: { age_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1000)), observed_at: observedAt },
    limits: { max_item_depth: state.policy.maxItemDepth, max_items: state.policy.maxItems },
    checkpoint: { commit_watermark: state.commitWatermark, control_revision: state.revision, remaining_frontier_count: state.frontierCount },
    diagnostics: { retry_count: state.retryCount, ...(state.nextRetryAt ? { next_retry_at: state.nextRetryAt } : {}), ...(state.lastError ? { last_error: state.lastError } : {}), incomplete_reasons: state.incompleteReasons },
    retention: { expires_at: state.expiresAt, storage: runtime.snapshots.storageStats() },
    observation_window: { started_at: state.observationStartedAt, updated_at: state.observationUpdatedAt },
    created_at: state.createdAt, updated_at: state.updatedAt,
    manifest_uri: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/manifest`,
    receipts_uri_template: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/receipts/{page}`,
    ...(next ? { next_action: next } : {})
  };
}

export function registerInventoryTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("inventory")) return;

  registerTool(server, "yfy_inventory_create", {
    title: "Create Yifangyun Workspace Inventory",
    description: "Create, join, or reuse a recursive workspace inventory. Explicit limits are required because they determine whether absence can be proven.",
    inputSchema: { workspace: WorkspaceRefSchema, refresh: RefreshSchema, limits: z.object({ max_item_depth: z.number().int().min(1).max(100), max_items: z.number().int().min(1).max(1_000_000) }).strict() },
    outputSchema: { ...InventorySummaryShape, reuse: z.object({ reused: z.boolean(), reason: z.enum(["fresh_complete", "running_join", "new"]), mode: z.enum(["reuse_if_fresh", "force_refresh"]), max_age_seconds: z.number().int().nonnegative().optional() }).strict() }
  }, { readOnly: false, idempotent: false }, async (args, extra) => {
    const workspace = runtime.access.resolveWorkspaceRef(String(args.workspace));
    const refresh = RefreshSchema.parse(args.refresh);
    const limits = args.limits as { max_item_depth: number; max_items: number };
    const fingerprint = workspaceFingerprint({ contextId: workspace.context.id, identityRef: workspace.identityRef, rootFolderId: workspace.scope.rootFolderId, workspaceId: workspace.scope.id }, runtime.config.clientSecret);
    const started = await runtime.snapshots.create({ accessContextId: workspace.context.id, forceRefresh: refresh.mode === "force_refresh", includeFiles: true, includeFolders: true, maxAgeSeconds: refresh.mode === "reuse_if_fresh" ? refresh.max_age_seconds : 0, maxItemDepth: limits.max_item_depth, maxItems: limits.max_items, pageCapacity: runtime.config.maxPageCapacity, rootFolderId: workspace.scope.rootFolderId, signal: extra.signal, workspaceFingerprint: fingerprint, workspaceId: workspace.scope.id, workspaceRef: String(args.workspace) });
    return { ...summary(runtime, started.state), reuse: { reused: started.reused, reason: started.reuseReason, mode: refresh.mode, ...(refresh.mode === "reuse_if_fresh" ? { max_age_seconds: refresh.max_age_seconds } : {}) } };
  });

  registerTool(server, "yfy_inventory_get", {
    title: "Get Yifangyun Workspace Inventory", description: "Read inventory identity, progress, diagnostics, retention and completeness.", inputSchema: { inventory: InventoryRefSchema }, outputSchema: InventorySummaryShape
  }, { readOnly: true, openWorld: false }, async ({ inventory }) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, inventory);
    return summary(runtime, await stateForRef(runtime, ref));
  });

  registerTool(server, "yfy_inventory_search", {
    title: "Search Yifangyun Workspace Inventory", description: "Search or list a fixed observation watermark. Existing cursors remain stable while the inventory continues scanning.",
    inputSchema: z.object({ inventory: InventoryRefSchema, request: InventorySearchRequestSchema }).strict(),
    outputSchema: { inventory: InventoryRefSchema, workspace: WorkspaceIdentitySchema, status: InventoryStatusSchema, view: z.object({ commit_watermark: z.number().int().nonnegative(), current_commit_watermark: z.number().int().nonnegative(), stable: z.literal(true) }).strict(), items: z.array(z.record(z.unknown())), page: SimplePageSchema, next_action: NextActionSchema.optional(), completeness: CompletenessSchema }
  }, { readOnly: true, openWorld: false }, async (args) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, args.inventory);
    await stateForRef(runtime, ref);
    const request = parsePaginatedRequest(InventorySearchRequestSchema, args.request, "inventory_search");
    const continued = request.mode === "continuation" ? decodeCursor(request.cursor, ref, runtime.config.clientSecret) : undefined;
    const query = continued?.query ?? (request.mode === "first_request" ? request.query : undefined);
    const mode = continued?.mode ?? (query ? "search" as const : "list" as const);
    const itemType = continued?.itemType ?? (request.mode === "first_request" ? request.kind : "all");
    const limit = continued?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_INVENTORY_PAGE_SIZE);
    const matchFields = continued?.matchFields ?? (request.mode === "first_request" ? request.match_fields : ["name", "path"]);
    const caseSensitive = continued?.caseSensitive ?? (request.mode === "first_request" && request.case_sensitive);
    const result = await runtime.snapshots.query({ accessContextId: ref.accessContext, cursor: continued?.cursor, limit, mode, queries: query ? [query] : undefined, matchFields, caseSensitive, scanId: ref.inventoryId, type: itemType });
    const nextCursor = result.nextCursor ? encodeInventoryCursor({ caseSensitive, cursor: result.nextCursor, inventoryId: ref.inventoryId, itemType, limit, matchFields, mode, query, workspaceFingerprint: ref.workspaceFingerprint }, runtime.config.clientSecret) : undefined;
    const items = result.items.map((item) => typeof item.id === "string" && (item.type === "file" || item.type === "folder") ? { ...item, ref: formatItemRef(item.type, item.id, result.state.accessContextId, result.state.accessIdentityRef) } : item);
    const next = continuationAction("yfy_inventory_search", nextCursor, { inventory: String(args.inventory) });
    return { inventory: String(args.inventory), workspace: { ref: result.state.workspaceRef, root: formatItemRef("folder", result.state.rootFolderId, result.state.accessContextId, result.state.accessIdentityRef), access_context: result.state.accessContextId, fingerprint: result.state.workspaceFingerprint }, status: result.state.status, view: { commit_watermark: continued?.cursor.watermark ?? result.state.commitWatermark, current_commit_watermark: result.state.commitWatermark, stable: true }, items, page: pageOutput(items.length, nextCursor), ...(next ? { next_action: next } : {}), completeness: runtime.snapshots.summary(result.state).completeness as JsonObject };
  });

  registerTool(server, "yfy_inventory_cancel", {
    title: "Cancel Yifangyun Workspace Inventory", description: "Cancel an active inventory. Cancelling a terminal inventory is a no-op.", inputSchema: { inventory: InventoryRefSchema }, outputSchema: { ...InventorySummaryShape, cancellation: z.object({ outcome: z.enum(["cancelled", "already_terminal"]) }).strict() }
  }, { readOnly: false, idempotent: true, openWorld: false }, async ({ inventory }) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, inventory);
    const before = await stateForRef(runtime, ref);
    const terminal = ["complete", "partial", "cancelled", "failed"].includes(before.status);
    const state = terminal ? before : await runtime.snapshots.cancel(ref.inventoryId, ref.accessContext);
    return { ...summary(runtime, state), cancellation: { outcome: !terminal && state.status === "cancelled" ? "cancelled" : "already_terminal" } };
  });

  registerTool(server, "yfy_inventory_release", {
    title: "Release Yifangyun Workspace Inventory", description: "Delete one local inventory and invalidate its ref, cursors, manifest and receipt resources.", inputSchema: { inventory: InventoryRefSchema }, outputSchema: { inventory: InventoryRefSchema, status: z.enum(["released", "already_unavailable"]) }
  }, { readOnly: false, destructive: true, idempotent: true, openWorld: false }, async ({ inventory }) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, inventory);
    const released = await runtime.snapshots.release(ref.inventoryId, ref.accessContext);
    return { inventory: String(inventory), status: released ? "released" : "already_unavailable" };
  });

  server.registerResource("yfy_inventory_manifest", new ResourceTemplate("yfy://inventory/{inventory_id}/{artifact_token}/{access_context}/manifest", { list: undefined }), { title: "Yifangyun Inventory Manifest", description: "Inventory observation digest without inline page receipts.", mimeType: "application/json" }, async (uri, variables) => {
    const state = await runtime.snapshots.get(String(variables.inventory_id), String(variables.access_context));
    if (state.artifactToken !== String(variables.artifact_token)) throw new YifangyunError("Inventory manifest token is invalid.", { code: "YFY_INVENTORY_ARTIFACT_FORBIDDEN", phase: "inventory_resource", scanId: state.scanId });
    const manifest = await runtime.snapshots.manifest(state.scanId, state.accessContextId);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(manifest) }] };
  });

  server.registerResource("yfy_inventory_receipts", new ResourceTemplate("yfy://inventory/{inventory_id}/{artifact_token}/{access_context}/receipts/{page}", { list: undefined }), { title: "Yifangyun Inventory Receipts", description: "One bounded page of inventory Provider receipts.", mimeType: "application/json" }, async (uri, variables) => {
    const state = await runtime.snapshots.get(String(variables.inventory_id), String(variables.access_context));
    if (state.artifactToken !== String(variables.artifact_token)) throw new YifangyunError("Inventory receipt token is invalid.", { code: "YFY_INVENTORY_ARTIFACT_FORBIDDEN", phase: "inventory_resource", scanId: state.scanId });
    const page = Number(variables.page);
    if (!Number.isSafeInteger(page) || page < 0) throw new YifangyunError("Receipt page is invalid.", { code: "YFY_INPUT_INVALID", phase: "inventory_resource" });
    const result = await runtime.snapshots.receipts(state.scanId, state.accessContextId, page);
    const pageCount = Math.ceil(result.total / 25);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ inventory_id: state.scanId, page, page_count: pageCount, total_count: result.total, receipts: result.receipts.map(projectInventoryReceipt), ...(page + 1 < pageCount ? { next_uri: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/receipts/${page + 1}` } : {}) }) }] };
  });
}
