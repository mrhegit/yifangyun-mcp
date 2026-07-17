import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ScopeItemCursor } from "../scan/types.js";
import { registerTool } from "./tooling.js";

const SnapshotStatusSchema = z.enum(["running", "paused_retryable", "complete", "partial", "cancelled", "failed", "expired"]);
const SnapshotCompletenessSchema = z.object({
  pagination_complete: z.boolean(),
  safe_to_claim_absence: z.boolean(),
  scope: z.enum(["entire_observed_accessible_scope", "observed_subset_only"]),
  consistency_level: z.enum(["best_effort_complete_observation", "partial_observation"]),
  incomplete_reasons: z.array(z.string())
}).strict();
const ObservationWindowSchema = z.object({ started_at: z.string(), updated_at: z.string() }).strict();
const SnapshotSummaryShape = {
  snapshot_id: z.string().uuid(),
  status: SnapshotStatusSchema,
  access_context: z.string(),
  root_folder_id: z.string(),
  scanned_file_count: z.number().int().nonnegative(),
  scanned_folder_count: z.number().int().nonnegative(),
  page_receipt_count: z.number().int().nonnegative(),
  completeness: SnapshotCompletenessSchema,
  terminal: z.boolean(),
  limits: z.object({ max_item_depth: z.number().int().min(1), max_items: z.number().int().positive() }),
  observation_window: ObservationWindowSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  artifact_uri: z.string(),
  next_action: z.object({ tool: z.literal("yfy_snapshot_get"), arguments: z.object({ snapshot_id: z.string().uuid(), access_context: z.string() }).strict(), stop_when_terminal: z.literal(true) }).strict().optional()
};
const CursorSchema = z.object({
  item_id: z.string().min(1),
  item_type: z.enum(["file", "folder", "all"]),
  mode: z.enum(["search", "list"]),
  query_key: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot_id: z.string().uuid(),
  sort_path: z.string(),
  total: z.number().int().nonnegative(),
  version: z.literal(1)
});

function cursorSignature(secret: string, value: { item_id: string; item_type: string; mode: string; query_key: string; revision: number; snapshot_id: string; sort_path: string; total: number; version: number }): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify([value.version, value.snapshot_id, value.mode, value.item_type, value.query_key, value.revision, value.item_id, value.sort_path, value.total])).digest("hex");
}

function decodeCursor(value: unknown, snapshotId: string, mode: "search" | "list", itemType: "file" | "folder" | "all", queryKey: string, secret: string): ScopeItemCursor | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.snapshot_id !== snapshotId || parsed.mode !== mode || parsed.item_type !== itemType || parsed.query_key !== queryKey) {
      throw new Error("cursor context does not match this query");
    }
    const expected = Buffer.from(cursorSignature(secret, parsed), "utf8");
    const actual = Buffer.from(parsed.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new Error("cursor signature is invalid");
    }
    return { itemId: parsed.item_id, revision: parsed.revision, sortPath: parsed.sort_path, total: parsed.total };
  } catch (error) {
    throw new YifangyunError(`Invalid snapshot cursor: ${error instanceof Error ? error.message : String(error)}`, { code: "YFY_SNAPSHOT_CURSOR_INVALID", phase: "snapshot_query" });
  }
}

function encodeCursor(snapshotId: string, mode: "search" | "list", itemType: "file" | "folder" | "all", queryKey: string, cursor: ScopeItemCursor, secret: string): string {
  const payload = { item_id: cursor.itemId, item_type: itemType, mode, query_key: queryKey, revision: cursor.revision, snapshot_id: snapshotId, sort_path: cursor.sortPath, total: cursor.total, version: 1 as const };
  return Buffer.from(JSON.stringify({ ...payload, signature: cursorSignature(secret, payload) }), "utf8").toString("base64url");
}

export function registerSnapshotTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("snapshot")) {
    return;
  }

  registerTool(server, "yfy_snapshot_create", {
    title: "Create Yifangyun Snapshot",
    description: "Create or reuse a durable recursive observation of one configured scope. Use this before claiming that material is absent; queries are supplied later to yfy_snapshot_query so one snapshot can be reused.",
    inputSchema: {
      scope_id: z.string().trim().min(1).describe("Configured Authority Scope ID."),
      match_fields: z.array(z.enum(["name", "path"])).min(1).default(["name", "path"]).describe("Fields indexed for later search."),
      max_item_depth: z.number().int().min(1).max(100).default(20).describe("Maximum returned item depth relative to the scope root; direct children are depth 1."),
      max_items: z.number().int().min(1).max(1000000).default(50000).describe("Hard item budget. Reaching it makes the snapshot partial."),
      page_capacity: z.number().int().min(1).max(500).default(500).describe("Requested Provider page capacity; the Provider may override it."),
      include_files: z.boolean().default(true),
      include_folders: z.boolean().default(true),
      case_sensitive: z.boolean().default(false)
    },
    outputSchema: { ...SnapshotSummaryShape, reused: z.boolean() }
  }, { readOnly: false, idempotent: true }, async (args, extra) => {
    const resolved = runtime.access.resolveScope(String(args.scope_id));
    const started = await runtime.snapshots.create({
      accessContextId: resolved.context.id,
      caseSensitive: args.case_sensitive === true,
      includeFiles: args.include_files !== false,
      includeFolders: args.include_folders !== false,
      matchFields: Array.isArray(args.match_fields) ? args.match_fields as Array<"name" | "path"> : ["name", "path"],
      maxItemDepth: Number(args.max_item_depth ?? 20),
      maxItems: Number(args.max_items ?? 50000),
      pageCapacity: Math.min(Number(args.page_capacity ?? 500), runtime.config.maxPageCapacity),
      rootFolderId: resolved.scope.rootFolderId,
      signal: extra.signal
    });
    return { ...runtime.snapshots.summary(started.state), reused: started.reused };
  });

  registerTool(server, "yfy_snapshot_get", {
    title: "Get Yifangyun Snapshot",
    description: "Read snapshot progress and completeness. Continue polling next_action until terminal=true, then inspect completeness before making absence claims.",
    inputSchema: { snapshot_id: z.string().uuid(), access_context: z.string().trim().min(1).optional() },
    outputSchema: SnapshotSummaryShape
  }, { readOnly: true, openWorld: false }, async ({ snapshot_id, access_context }) => {
    const state = await runtime.snapshots.get(String(snapshot_id), typeof access_context === "string" ? access_context : undefined);
    return runtime.snapshots.summary(state);
  });

  registerTool(server, "yfy_snapshot_query", {
    title: "Query Yifangyun Snapshot",
    description: "Search or list one stable page from a snapshot without calling the Provider again. For search mode, provide queries. If a cursor becomes stale while scanning, restart without cursor.",
    inputSchema: {
      snapshot_id: z.string().uuid(),
      mode: z.enum(["search", "list"]).default("search"),
      queries: z.array(z.string().trim().min(1).max(200)).min(1).max(50).optional().describe("Required in search mode; ignored in list mode."),
      item_type: z.enum(["file", "folder", "all"]).default("all"),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
      access_context: z.string().trim().min(1).optional()
    },
    outputSchema: {
      snapshot_id: z.string().uuid(),
      status: SnapshotStatusSchema,
      items: z.array(z.record(z.unknown())),
      total_count: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      has_more: z.boolean(),
      next_cursor: z.string().optional(),
      completeness: SnapshotCompletenessSchema
    }
  }, { readOnly: true, openWorld: false }, async (args) => {
    if (args.mode === "search" && Array.isArray(args.queries) && args.queries.length === 0) {
      throw new YifangyunError("queries must not be empty in search mode.", { code: "YFY_INPUT_INVALID", phase: "snapshot_query" });
    }
    const mode = args.mode as "search" | "list";
    const itemType = args.item_type as "file" | "folder" | "all";
    const snapshotId = String(args.snapshot_id);
    const queries = mode === "search" && Array.isArray(args.queries) ? args.queries as string[] : undefined;
    const queryKey = crypto.createHash("sha256").update(JSON.stringify(queries ?? null)).digest("hex");
    const result = await runtime.snapshots.query({
      accessContextId: typeof args.access_context === "string" ? args.access_context : undefined,
      cursor: decodeCursor(args.cursor, snapshotId, mode, itemType, queryKey, runtime.config.clientSecret),
      limit: Number(args.limit),
      mode,
      queries,
      scanId: snapshotId,
      type: itemType
    });
    const nextCursor = result.nextCursor ? encodeCursor(snapshotId, mode, itemType, queryKey, result.nextCursor, runtime.config.clientSecret) : undefined;
    return {
      snapshot_id: result.state.scanId,
      status: result.state.status,
      items: result.items,
      total_count: result.total,
      limit: Number(args.limit),
      has_more: Boolean(nextCursor),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      completeness: runtime.snapshots.summary(result.state).completeness ?? {}
    };
  });

  registerTool(server, "yfy_snapshot_cancel", {
    title: "Cancel Yifangyun Snapshot",
    description: "Cancel one durable background snapshot.",
    inputSchema: { snapshot_id: z.string().uuid(), access_context: z.string().trim().min(1).optional() },
    outputSchema: SnapshotSummaryShape
  }, { readOnly: false, idempotent: true, openWorld: false }, async ({ snapshot_id, access_context }) => {
    const state = await runtime.snapshots.cancel(String(snapshot_id), typeof access_context === "string" ? access_context : undefined);
    return runtime.snapshots.summary(state);
  });

  server.registerResource(
    "yfy_snapshot_manifest",
    new ResourceTemplate("yfy://snapshot/{snapshot_id}/{artifact_token}/{access_context}/manifest", { list: undefined }),
    { title: "Yifangyun Snapshot Manifest", description: "Durable snapshot receipts and observation digest.", mimeType: "application/json" },
    async (uri, variables) => {
      const state = await runtime.snapshots.get(String(variables.snapshot_id), String(variables.access_context));
      if (state.artifactToken !== String(variables.artifact_token)) {
        throw new YifangyunError("Snapshot artifact token is invalid.", { code: "YFY_SNAPSHOT_ARTIFACT_FORBIDDEN", phase: "snapshot_resource", scanId: state.scanId });
      }
      const manifest = await runtime.snapshots.manifest(state.scanId, state.accessContextId);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }] };
    }
  );
}
