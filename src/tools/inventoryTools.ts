import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { formatItemRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ScopeItemCursor, ScopeScanState } from "../scan/types.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { NextActionSchema, SimplePageSchema } from "./schemas.js";

const InventoryStatusSchema = z.enum(["running", "paused_retryable", "complete", "partial", "cancelled", "failed", "expired"]);
const InventoryRefSchema = z.string().regex(/^inventory:[A-Za-z0-9_-]+$/);
const CompletenessSchema = z.object({
  pagination_complete: z.boolean(),
  safe_to_claim_absence: z.boolean(),
  scope: z.enum(["entire_observed_accessible_scope", "observed_subset_only"]),
  consistency_level: z.enum(["best_effort_complete_observation", "partial_observation"]),
  incomplete_reasons: z.array(z.string())
}).strict();
const InventorySummaryShape = {
  inventory: InventoryRefSchema,
  status: InventoryStatusSchema,
  terminal: z.boolean(),
  counts: z.object({ files: z.number().int().nonnegative(), folders: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }).strict(),
  completeness: CompletenessSchema,
  freshness: z.object({ age_seconds: z.number().int().nonnegative(), observed_at: z.string() }).strict(),
  limits: z.object({ max_item_depth: z.number().int().min(1), max_items: z.number().int().positive() }).strict(),
  observation_window: z.object({ started_at: z.string(), updated_at: z.string() }).strict(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  manifest_uri: z.string(),
  next_action: NextActionSchema.optional()
};
const CursorSchema = z.object({
  item_id: z.string().min(1),
  item_type: z.enum(["file", "folder", "all"]),
  mode: z.enum(["search", "list"]),
  page_limit: z.number().int().min(1).max(500),
  query: z.string().optional(),
  query_key: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_id: z.string().uuid(),
  sort_path: z.string(),
  total: z.number().int().nonnegative(),
  version: z.literal(1)
});

function signature(secret: string, values: unknown[]): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(values)).digest("hex");
}

function inventoryRef(secret: string, state: ScopeScanState): string {
  const payload = { access_context: state.accessContextId, inventory_id: state.scanId, version: 1 };
  return `inventory:${Buffer.from(JSON.stringify({ ...payload, signature: signature(secret, [payload.version, payload.inventory_id, payload.access_context]) }), "utf8").toString("base64url")}`;
}

function parseInventoryRef(secret: string, value: unknown): { accessContext: string; inventoryId: string } {
  try {
    const encoded = String(value).slice("inventory:".length);
    const parsed = z.object({ access_context: z.string(), inventory_id: z.string().uuid(), signature: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal(1) }).parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const expected = Buffer.from(signature(secret, [parsed.version, parsed.inventory_id, parsed.access_context]), "utf8");
    const actual = Buffer.from(parsed.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("signature mismatch");
    return { accessContext: parsed.access_context, inventoryId: parsed.inventory_id };
  } catch {
    throw new YifangyunError("Inventory reference is invalid.", { code: "YFY_INPUT_INVALID", phase: "inventory_reference", suggestedAction: "Copy the inventory reference returned by yfy_inventory_create." });
  }
}

function cursorSignature(secret: string, value: { item_id: string; item_type: string; mode: string; page_limit: number; query?: string; query_key: string; revision: number; snapshot_id: string; sort_path: string; total: number; version: number }): string {
  return signature(secret, [value.version, value.snapshot_id, value.mode, value.item_type, value.query ?? null, value.query_key, value.page_limit, value.revision, value.item_id, value.sort_path, value.total]);
}

function decodeCursor(value: unknown, inventoryId: string, secret: string): { cursor: ScopeItemCursor; itemType: "file" | "folder" | "all"; limit: number; mode: "search" | "list"; query?: string } | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.snapshot_id !== inventoryId || parsed.query_key !== crypto.createHash("sha256").update(JSON.stringify(parsed.query ?? null)).digest("hex")) throw new Error("cursor context mismatch");
    const expected = Buffer.from(cursorSignature(secret, parsed), "utf8");
    const actual = Buffer.from(parsed.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("cursor signature mismatch");
    return { cursor: { itemId: parsed.item_id, revision: parsed.revision, sortPath: parsed.sort_path, total: parsed.total }, itemType: parsed.item_type, limit: parsed.page_limit, mode: parsed.mode, ...(parsed.query ? { query: parsed.query } : {}) };
  } catch {
    throw new YifangyunError("Inventory cursor is invalid.", { code: "YFY_INVENTORY_CURSOR_INVALID", phase: "inventory_search", suggestedAction: "Restart yfy_inventory_search without cursor." });
  }
}

function encodeCursor(inventoryId: string, mode: "search" | "list", itemType: "file" | "folder" | "all", query: string | undefined, limit: number, cursor: ScopeItemCursor, secret: string): string {
  const payload = { item_id: cursor.itemId, item_type: itemType, mode, page_limit: limit, ...(query ? { query } : {}), query_key: crypto.createHash("sha256").update(JSON.stringify(query ?? null)).digest("hex"), revision: cursor.revision, snapshot_id: inventoryId, sort_path: cursor.sortPath, total: cursor.total, version: 1 as const };
  return Buffer.from(JSON.stringify({ ...payload, signature: cursorSignature(secret, payload) }), "utf8").toString("base64url");
}

function summary(runtime: AppRuntime, state: ScopeScanState): JsonObject {
  const internal = runtime.snapshots.summary(state);
  const observedAt = state.observationUpdatedAt;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(observedAt)) / 1000));
  const ref = inventoryRef(runtime.config.clientSecret, state);
  return {
    inventory: ref,
    status: state.status,
    terminal: internal.terminal === true,
    counts: { files: state.fileCount, folders: state.folderCount, pages: state.pageReceiptCount },
    completeness: internal.completeness as JsonObject,
    freshness: { age_seconds: ageSeconds, observed_at: observedAt },
    limits: { max_item_depth: state.policy.maxItemDepth, max_items: state.policy.maxItems },
    observation_window: { started_at: state.observationStartedAt, updated_at: state.observationUpdatedAt },
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    expires_at: state.expiresAt,
    manifest_uri: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/manifest`,
    ...(["running", "paused_retryable"].includes(state.status) ? { next_action: { tool: "yfy_inventory_get", arguments: { inventory: ref } } } : {})
  };
}

export function registerInventoryTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("inventory")) return;

  registerTool(server, "yfy_inventory_create", {
    title: "Create Yifangyun Workspace Inventory",
    description: "Create, join, or reuse a recursive workspace inventory. Only fresh complete inventories and active matching inventories are reused automatically.",
    inputSchema: {
      workspace: z.string().trim().min(1),
      freshness: z.object({ max_age_seconds: z.number().int().min(0).max(604800).default(300), mode: z.enum(["reuse_if_fresh", "force_refresh"]).default("reuse_if_fresh") }).default({ max_age_seconds: 300, mode: "reuse_if_fresh" }),
      max_item_depth: z.number().int().min(1).max(100).default(20),
      max_items: z.number().int().min(1).max(1000000).default(50000)
    },
    outputSchema: { ...InventorySummaryShape, reuse: z.object({ reused: z.boolean(), reason: z.enum(["fresh_complete", "running_join", "new"]), max_age_seconds: z.number().int().nonnegative(), mode: z.enum(["reuse_if_fresh", "force_refresh"]) }).strict() }
  }, { readOnly: false, idempotent: true }, async (args, extra) => {
    const workspace = runtime.access.resolveScope(String(args.workspace));
    const freshness = args.freshness as { max_age_seconds?: number; mode?: string } | undefined;
    const maxAgeSeconds = Number(freshness?.max_age_seconds ?? 300);
    const mode = freshness?.mode === "force_refresh" ? "force_refresh" : "reuse_if_fresh";
    const started = await runtime.snapshots.create({
      accessContextId: workspace.context.id,
      caseSensitive: false,
      forceRefresh: mode === "force_refresh",
      includeFiles: true,
      includeFolders: true,
      matchFields: ["name", "path"],
      maxAgeSeconds,
      maxItemDepth: Number(args.max_item_depth ?? 20),
      maxItems: Number(args.max_items ?? 50000),
      pageCapacity: runtime.config.maxPageCapacity,
      rootFolderId: workspace.scope.rootFolderId,
      signal: extra.signal
    });
    return { ...summary(runtime, started.state), reuse: { reused: started.reused, reason: started.reuseReason, max_age_seconds: maxAgeSeconds, mode } };
  });

  registerTool(server, "yfy_inventory_get", {
    title: "Get Yifangyun Workspace Inventory",
    description: "Read inventory progress, freshness, and completeness. Follow next_action until terminal before making absence claims.",
    inputSchema: { inventory: InventoryRefSchema },
    outputSchema: InventorySummaryShape
  }, { readOnly: true, openWorld: false }, async ({ inventory }) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, inventory);
    return summary(runtime, await runtime.snapshots.get(ref.inventoryId, ref.accessContext));
  });

  registerTool(server, "yfy_inventory_search", {
    title: "Search Yifangyun Workspace Inventory",
    description: "Search a stable inventory page, or omit query to list it. Continue with only the returned cursor and inventory ref.",
    inputSchema: { inventory: InventoryRefSchema, query: z.string().trim().min(1).max(200).optional(), kind: z.enum(["file", "folder", "all"]).default("all"), cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).default(100) },
    outputSchema: { inventory: InventoryRefSchema, status: InventoryStatusSchema, items: z.array(z.record(z.unknown())), page: SimplePageSchema, next_action: NextActionSchema.optional(), completeness: CompletenessSchema }
  }, { readOnly: true, openWorld: false }, async (args) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, args.inventory);
    const continued = decodeCursor(args.cursor, ref.inventoryId, runtime.config.clientSecret);
    const query = continued?.query ?? (typeof args.query === "string" ? args.query : undefined);
    const mode = continued?.mode ?? (query ? "search" as const : "list" as const);
    const itemType = continued?.itemType ?? args.kind as "file" | "folder" | "all";
    const limit = continued?.limit ?? Number(args.limit ?? 100);
    const result = await runtime.snapshots.query({
      accessContextId: ref.accessContext,
      cursor: continued?.cursor,
      limit,
      mode,
      queries: query ? [query] : undefined,
      scanId: ref.inventoryId,
      type: itemType
    });
    const nextCursor = result.nextCursor ? encodeCursor(ref.inventoryId, mode, itemType, query, limit, result.nextCursor, runtime.config.clientSecret) : undefined;
    const items = result.items.map((item) => typeof item.id === "string" && (item.type === "file" || item.type === "folder") ? { ...item, ref: formatItemRef(item.type, item.id) } : item);
    return {
      inventory: String(args.inventory),
      status: result.state.status,
      items,
      page: { returned_count: items.length, has_more: Boolean(nextCursor), ...(nextCursor ? { next_cursor: nextCursor } : {}) },
      ...(nextCursor ? { next_action: { tool: "yfy_inventory_search", arguments: { inventory: String(args.inventory), cursor: nextCursor } } } : {}),
      completeness: runtime.snapshots.summary(result.state).completeness as JsonObject
    };
  });

  registerTool(server, "yfy_inventory_cancel", {
    title: "Cancel Yifangyun Workspace Inventory",
    description: "Cancel an active inventory. Cancelling a terminal inventory is a no-op.",
    inputSchema: { inventory: InventoryRefSchema },
    outputSchema: { ...InventorySummaryShape, cancellation: z.object({ outcome: z.enum(["cancelled", "already_terminal"]) }).strict() }
  }, { readOnly: false, idempotent: true, openWorld: false }, async ({ inventory }) => {
    const ref = parseInventoryRef(runtime.config.clientSecret, inventory);
    const before = await runtime.snapshots.get(ref.inventoryId, ref.accessContext);
    const terminal = ["complete", "partial", "cancelled", "failed", "expired"].includes(before.status);
    const state = terminal ? before : await runtime.snapshots.cancel(ref.inventoryId, ref.accessContext);
    return { ...summary(runtime, state), cancellation: { outcome: !terminal && state.status === "cancelled" ? "cancelled" : "already_terminal" } };
  });

  server.registerResource(
    "yfy_inventory_manifest",
    new ResourceTemplate("yfy://inventory/{inventory_id}/{artifact_token}/{access_context}/manifest", { list: undefined }),
    { title: "Yifangyun Inventory Manifest", description: "Durable inventory receipts and observation digest.", mimeType: "application/json" },
    async (uri, variables) => {
      const state = await runtime.snapshots.get(String(variables.inventory_id), String(variables.access_context));
      if (state.artifactToken !== String(variables.artifact_token)) throw new YifangyunError("Inventory manifest token is invalid.", { code: "YFY_INVENTORY_ARTIFACT_FORBIDDEN", phase: "inventory_resource", scanId: state.scanId });
      const manifest = await runtime.snapshots.manifest(state.scanId, state.accessContextId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }] };
    }
  );
}
