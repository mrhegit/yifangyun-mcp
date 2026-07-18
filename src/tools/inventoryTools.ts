import crypto from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { decodeCanonicalBase64Url } from "../domain/base64url.js";
import type { CursorInvalidReason } from "../domain/cursors.js";
import { projectItem } from "../domain/projectors.js";
import { formatItemRef, parseItemRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ResolvedScope } from "../runtime/access.js";
import { projectInventoryReceipt } from "../scan/projectors.js";
import type { ScopeItemCursor, ScopeScanState } from "../scan/types.js";
import type { JsonObject } from "../types.js";
import { INVENTORY_CURSOR_VERSION, INVENTORY_REF_VERSION, WORKSPACE_FINGERPRINT_VERSION } from "../version.js";
import { continuationAction, pageOutput, paginatedInputSchemaWithFixed, resolvePaginationArgs } from "./pagination.js";
import { FolderRefSchema, NextActionSchema, SimplePageSchema, WorkspaceRefSchema } from "./schemas.js";
import { registerTool } from "./tooling.js";
import { workspaceMembershipProof } from "./workspaceContentTools.js";

const InventoryStatusSchema = z.enum(["running", "retry_wait", "complete", "partial", "cancelled", "failed"]);
/** Stable MAC-bound inventory reference: inventory:<uuid>@<access_context>.<mac24>. */
const InventoryRefSchema = z.string()
  .regex(/^inventory:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[A-Za-z0-9_-]+\.[a-f0-9]{24}$/i)
  .describe("Copy the inventory ref returned by this server (stable across create/get/search). Bare inventory_id is not accepted.");
const InventoryHandleSchema = InventoryRefSchema;
const INVENTORY_REF_MAC_PATTERN = /^inventory:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@([A-Za-z0-9_-]+)\.([a-f0-9]{24})$/i;
const DEFAULT_INVENTORY_PAGE_SIZE = 25;
const CompletenessSchema = z.object({
  pagination_complete: z.boolean(),
  safe_to_claim_absence: z.boolean(),
  scope: z.enum(["entire_observed_accessible_scope", "observed_subset_only", "observed_subtree"]),
  consistency_level: z.enum(["best_effort_complete_observation", "partial_observation"]),
  incomplete_reasons: z.array(z.string())
}).strict();
const WorkspaceIdentitySchema = z.object({ ref: WorkspaceRefSchema, root: FolderRefSchema, access_context: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const AgentGuidanceSchema = z.object({
  may_claim_absence: z.boolean(),
  absence_forbidden_reason: z.string().optional(),
  recommended_actions: z.array(z.string()),
  empty_result_meaning: z.string().optional(),
  empty_result_code: z.enum([
    "absence_forbidden_partial_or_incomplete",
    "absence_supported",
    "list_empty",
    "page_exhausted_no_match"
  ]).optional(),
  observation_scope_note: z.string().optional()
}).strict();
const PlanningSchema = z.object({
  strategy: z.literal("prefer_subtree_split"),
  risk_level: z.enum(["high", "medium", "low"]),
  hints: z.array(z.string())
}).strict();
const ScanRootSchema = z.object({ id: z.string(), ref: FolderRefSchema.optional() }).strict();
const InventorySummaryShape = {
  inventory: InventoryRefSchema,
  inventory_id: z.string().uuid(),
  workspace: WorkspaceIdentitySchema,
  status: InventoryStatusSchema,
  terminal: z.boolean(),
  counts: z.object({ files: z.number().int().nonnegative(), folders: z.number().int().nonnegative(), pages: z.number().int().nonnegative() }).strict(),
  completeness: CompletenessSchema,
  scan_root: ScanRootSchema,
  agent_guidance: AgentGuidanceSchema,
  planning: PlanningSchema.optional(),
  empty_result_meaning: z.string().optional(),
  suggested_wait_ms: z.number().int().nonnegative().optional(),
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
const InventorySearchInputSchema = paginatedInputSchemaWithFixed(
  { inventory: InventoryHandleSchema },
  {
    query: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(["file", "folder", "all"]).default("all"),
    match_fields: z.array(z.enum(["name", "path"])).min(1).max(2).default(["name", "path"]),
    case_sensitive: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(DEFAULT_INVENTORY_PAGE_SIZE)
  }
);

const CursorSchema = z.object({
  item_id: z.string().min(1), item_type: z.enum(["file", "folder", "all"]), mode: z.enum(["search", "list"]), page_limit: z.number().int().min(1).max(100), query: z.string().optional(), match_fields: z.array(z.enum(["name", "path"])).min(1).max(2), case_sensitive: z.boolean(), query_spec_hash: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/), inventory_id: z.string().uuid(), workspace_fingerprint: z.string().regex(/^[a-f0-9]{64}$/), sort_path: z.string(), total: z.number().int().nonnegative(), watermark: z.number().int().nonnegative(), version: z.literal(INVENTORY_CURSOR_VERSION)
}).strict();
const CursorEnvelopeSchema = z.object({ signature: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal(INVENTORY_CURSOR_VERSION) }).passthrough();

function signature(secret: string, value: unknown): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

function workspaceFingerprint(state: { contextId: string; identityRef: string; scanRootFolderId: string; workspaceId: string; workspaceRootFolderId: string }, secret: string): string {
  return signature(secret, { access_context: state.contextId, identity_ref: state.identityRef, scan_root_folder_id: state.scanRootFolderId, workspace_id: state.workspaceId, workspace_root_folder_id: state.workspaceRootFolderId, version: WORKSPACE_FINGERPRINT_VERSION });
}

interface InventoryRefPayload {
  accessContext: string;
  handle: string;
  inventoryId: string;
}

function inventoryRefMac(secret: string, inventoryId: string, accessContext: string): string {
  return crypto.createHmac("sha256", secret)
    .update(`inventory-ref-v${INVENTORY_REF_VERSION}\n${inventoryId}\n${accessContext}`)
    .digest("hex")
    .slice(0, 24);
}

function inventoryRef(_runtime: AppRuntime, state: ScopeScanState): string {
  const mac = inventoryRefMac(_runtime.config.clientSecret, state.scanId, state.accessContextId);
  return `inventory:${state.scanId}@${state.accessContextId}.${mac}`;
}

function parseInventoryRefParts(raw: string): { accessContext: string; inventoryId: string; mac: string } {
  const match = INVENTORY_REF_MAC_PATTERN.exec(raw.trim());
  if (!match) throw new Error("inventory ref format is invalid");
  return {
    inventoryId: match[1]!.toLowerCase(),
    accessContext: match[2]!,
    mac: match[3]!.toLowerCase()
  };
}

function resolveInventoryHandle(runtime: AppRuntime, value: unknown): InventoryRefPayload {
  const raw = String(value).trim();
  let parts: { accessContext: string; inventoryId: string; mac: string };
  try {
    parts = parseInventoryRefParts(raw);
  } catch {
    throw new YifangyunError("Inventory reference is invalid.", {
      code: "YFY_INPUT_INVALID",
      phase: "inventory_reference",
      suggestedAction: "Copy the inventory ref returned by yfy_inventory_create/get/search exactly. Bare inventory_id is not accepted."
    });
  }
  return {
    accessContext: parts.accessContext,
    handle: raw,
    inventoryId: parts.inventoryId
  };
}

function querySpec(value: { caseSensitive: boolean; itemType: string; limit: number; matchFields: string[]; mode: string; query?: string }) {
  return { case_sensitive: value.caseSensitive, item_type: value.itemType, limit: value.limit, match_fields: [...value.matchFields].sort(), mode: value.mode, query: value.query ?? null };
}

function decodeCursor(value: unknown, ref: { inventoryId: string; workspaceFingerprint: string }, secret: string) {
  let reason: CursorInvalidReason = "envelope_invalid";
  try {
    let raw: Buffer;
    try {
      raw = decodeCanonicalBase64Url(String(value));
    } catch {
      reason = "not_base64url";
      throw new Error(reason);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString("utf8"));
    } catch {
      reason = "envelope_invalid";
      throw new Error(reason);
    }
    const envelopeResult = CursorEnvelopeSchema.safeParse(decoded);
    if (!envelopeResult.success) {
      reason = "envelope_invalid";
      throw new Error(reason);
    }
    const decodedRecord = decoded as Record<string, unknown>;
    const unsigned = { ...decodedRecord };
    delete unsigned.signature;
    const expected = Buffer.from(signature(secret, unsigned), "utf8");
    const actual = Buffer.from(String(decodedRecord.signature), "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      reason = "signature_invalid";
      throw new Error(reason);
    }
    const parsedResult = CursorSchema.safeParse(decoded);
    if (!parsedResult.success) {
      reason = "payload_invalid";
      throw new Error(reason);
    }
    const parsed = parsedResult.data;
    if (parsed.inventory_id !== ref.inventoryId || parsed.workspace_fingerprint !== ref.workspaceFingerprint || parsed.query_spec_hash !== signature(secret, querySpec({ caseSensitive: parsed.case_sensitive, itemType: parsed.item_type, limit: parsed.page_limit, matchFields: parsed.match_fields, mode: parsed.mode, query: parsed.query }))) {
      reason = "payload_invalid";
      throw new Error(reason);
    }
    return { cursor: { itemId: parsed.item_id, sortPath: parsed.sort_path, total: parsed.total, watermark: parsed.watermark } satisfies ScopeItemCursor, itemType: parsed.item_type, limit: parsed.page_limit, mode: parsed.mode, query: parsed.query, matchFields: parsed.match_fields, caseSensitive: parsed.case_sensitive };
  } catch {
    throw new YifangyunError("Inventory cursor is invalid or expired.", { code: "YFY_INVENTORY_CURSOR_INVALID", phase: "inventory_search", suggestedAction: "Restart yfy_inventory_search with inventory and first-page search fields.", agentDetails: { reason } });
  }
}

function encodeInventoryCursor(input: { caseSensitive: boolean; cursor: ScopeItemCursor; inventoryId: string; itemType: "file" | "folder" | "all"; limit: number; matchFields: Array<"name" | "path">; mode: "search" | "list"; query?: string; workspaceFingerprint: string }, secret: string): string {
  const spec = querySpec(input);
  const payload = { item_id: input.cursor.itemId, item_type: input.itemType, mode: input.mode, page_limit: input.limit, ...(input.query ? { query: input.query } : {}), match_fields: input.matchFields, case_sensitive: input.caseSensitive, query_spec_hash: signature(secret, spec), inventory_id: input.inventoryId, workspace_fingerprint: input.workspaceFingerprint, sort_path: input.cursor.sortPath, total: input.cursor.total, watermark: input.cursor.watermark, version: INVENTORY_CURSOR_VERSION };
  return Buffer.from(JSON.stringify({ ...payload, signature: signature(secret, payload) }), "utf8").toString("base64url");
}

async function stateForRef(runtime: AppRuntime, ref: { accessContext: string; handle: string; inventoryId: string }) {
  const parts = parseInventoryRefParts(ref.handle);
  const expectedMac = inventoryRefMac(runtime.config.clientSecret, parts.inventoryId, parts.accessContext);
  const presented = Buffer.from(parts.mac, "utf8");
  const expected = Buffer.from(expectedMac, "utf8");
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    throw new YifangyunError("Inventory reference is invalid.", {
      code: "YFY_INPUT_INVALID",
      phase: "inventory_reference",
      suggestedAction: "Copy the inventory ref returned by yfy_inventory_create/get/search exactly. Refs are bound to the server secret, Inventory ID and Access Context."
    });
  }
  const state = await runtime.snapshots.get(ref.inventoryId, ref.accessContext);
  if (state.accessContextId !== parts.accessContext || state.scanId !== parts.inventoryId) {
    throw new YifangyunError("Inventory reference belongs to a different workspace identity.", { code: "YFY_INVENTORY_ACCESS_DENIED", phase: "inventory_access", scanId: state.scanId });
  }
  assertCurrentWorkspaceState(runtime, state);
  return state;
}

function assertCurrentWorkspaceState(runtime: AppRuntime, state: ScopeScanState): void {
  let current: ResolvedScope;
  try {
    current = runtime.access.resolveWorkspaceRef(state.workspaceRef);
  } catch {
    throw new YifangyunError("Inventory workspace configuration is no longer available.", {
      code: "YFY_INVENTORY_STALE",
      phase: "inventory_access",
      scanId: state.scanId,
      suggestedAction: "Create a new inventory from a workspace ref returned by the current yfy_status."
    });
  }
  const expectedFingerprint = workspaceFingerprint({
    contextId: current.context.id,
    identityRef: current.identityRef,
    scanRootFolderId: state.rootFolderId,
    workspaceId: current.scope.id,
    workspaceRootFolderId: current.scope.rootFolderId
  }, runtime.config.clientSecret);
  if (state.workspaceId !== current.scope.id || state.workspaceRootFolderId !== current.scope.rootFolderId || state.workspaceFingerprint !== expectedFingerprint) {
    throw new YifangyunError("Inventory workspace boundary changed after this inventory was created.", {
      code: "YFY_INVENTORY_STALE",
      phase: "inventory_access",
      scanId: state.scanId,
      suggestedAction: "Create a new inventory for the current workspace configuration. Do not use this inventory for scope or absence claims."
    });
  }
}

function agentGuidance(
  state: ScopeScanState,
  safeToClaimAbsence: boolean,
  opts?: { emptyItems?: boolean; mode?: "search" | "list"; hasMore?: boolean }
): {
  may_claim_absence: boolean;
  absence_forbidden_reason?: string;
  recommended_actions: string[];
  empty_result_meaning?: string;
  empty_result_code?: "absence_forbidden_partial_or_incomplete" | "absence_supported" | "list_empty" | "page_exhausted_no_match";
  observation_scope_note?: string;
} {
  const observation_scope_note = `scan_root=${state.rootFolderId}; status=${state.status}; incomplete_reasons=${state.incompleteReasons.join(",") || "none"}`;

  if (safeToClaimAbsence) {
    const base = {
      may_claim_absence: true as const,
      recommended_actions: ["Search this inventory with yfy_inventory_search; absence claims are limited to the observed scan root and observation window."],
      observation_scope_note
    };
    if (opts?.emptyItems) {
      if (opts.mode === "list") {
        return { ...base, empty_result_meaning: "list_empty_page", empty_result_code: "list_empty" };
      }
      return {
        ...base,
        empty_result_meaning: "not_found_within_complete_observation; absence_supported",
        empty_result_code: "absence_supported",
        recommended_actions: [
          ...base.recommended_actions,
          "Empty result under may_claim_absence=true supports absence only within this scan root and observation window."
        ]
      };
    }
    return base;
  }

  const reasons = state.incompleteReasons;
  const recommended_actions: string[] = [];

  if (state.status === "running") {
    recommended_actions.push("Follow next_action / poll yfy_inventory_get until terminal.");
    recommended_actions.push("Honor suggested_wait_ms before the next poll.");
  } else if (state.status === "retry_wait") {
    recommended_actions.push("Wait for suggested_wait_ms, then poll yfy_inventory_get.");
  }

  if (reasons.includes("MAX_ITEMS_REACHED")) {
    recommended_actions.push("Split the workspace into smaller subtrees via root_folder.");
    recommended_actions.push("Raise limits.max_items if capacity allows.");
    recommended_actions.push("Use yfy_inventory_search only against the current commit watermark.");
  }
  if (reasons.includes("MAX_DEPTH_REACHED")) {
    recommended_actions.push("Split the workspace into smaller subtrees via root_folder.");
    recommended_actions.push("Raise limits.max_item_depth only when the wider traversal is intended.");
  }
  if (reasons.includes("PERMISSION_CHANGED_OR_DENIED")) recommended_actions.push("Verify the access context and Provider permissions before creating a fresh inventory.");
  if (reasons.some((reason) => ["PAGINATION_METADATA_INCONSISTENT", "EMPTY_PAGE_WITH_MORE", "PROVIDER_REVISION_DRIFT"].includes(reason))) {
    recommended_actions.push("Create a fresh inventory after the Provider observation stabilizes; increasing limits will not repair this Provider contract issue.");
  }

  if (state.status === "failed" || state.status === "cancelled") {
    recommended_actions.push("Create a new inventory after resolving the failure or cancellation.");
  }

  recommended_actions.push("Do not claim absence of materials from this inventory.");

  const absence_forbidden_reason = reasons[0]
    ?? (state.status === "running" || state.status === "retry_wait" ? `inventory_${state.status}` : `inventory_status_${state.status}`);

  const result: ReturnType<typeof agentGuidance> = {
    may_claim_absence: false,
    absence_forbidden_reason,
    recommended_actions: [...new Set(recommended_actions)],
    observation_scope_note
  };

  if (opts?.emptyItems) {
    if (opts.hasMore) {
      result.empty_result_meaning = "matches_exist_on_later_pages";
      result.empty_result_code = "page_exhausted_no_match";
    } else {
      result.empty_result_meaning = "not_found_in_observed_prefix_only; absence_forbidden";
      result.empty_result_code = "absence_forbidden_partial_or_incomplete";
      result.recommended_actions = [
        "Do not claim materials are missing from this inventory.",
        "Split root_folder / raise limits.max_items and create a new inventory if completeness is partial.",
        "Absence claims require agent_guidance.may_claim_absence=true only.",
        ...result.recommended_actions
      ];
      result.recommended_actions = [...new Set(result.recommended_actions)];
    }
  }
  return result;
}

function inventoryPlanning(hasRootFolder: boolean, maxItems: number, maxDepth: number): {
  strategy: "prefer_subtree_split";
  risk_level: "high" | "medium" | "low";
  hints: string[];
} {
  const hints: string[] = [];
  let risk: "high" | "medium" | "low" = "low";
  if (!hasRootFolder) {
    hints.push("Large workspaces: prefer root_folder on a first-level category instead of scanning the entire workspace root.");
    risk = "high";
  }
  if (maxItems < 5000 && !hasRootFolder) {
    hints.push("max_items is low for a whole-workspace scan; expect partial and absence_forbidden.");
    risk = "high";
  } else if (maxItems < 1000) {
    hints.push("max_items is modest; deep trees may hit MAX_ITEMS_REACHED.");
    if (risk === "low") risk = "medium";
  }
  if (maxDepth < 4) {
    hints.push("max_item_depth is shallow; deep material paths may be incomplete.");
    if (risk === "low") risk = "medium";
  }
  if (hints.length === 0) {
    hints.push("Subtree + explicit limits look reasonable; still wait for terminal completeness before absence claims.");
  }
  return { strategy: "prefer_subtree_split", risk_level: risk, hints };
}

function suggestedWaitMs(state: ScopeScanState): number | undefined {
  if (state.status === "running") return 750;
  if (state.status === "retry_wait") {
    if (!state.nextRetryAt) return 750;
    const delta = Date.parse(state.nextRetryAt) - Date.now();
    if (!Number.isFinite(delta)) return 750;
    return Math.min(30_000, Math.max(250, Math.trunc(delta)));
  }
  return undefined;
}

function summary(runtime: AppRuntime, state: ScopeScanState, extra?: { planning?: JsonObject }): JsonObject {
  const internal = runtime.snapshots.summary(state);
  const observedAt = state.observationUpdatedAt;
  const ref = inventoryRef(runtime, state);
  const completeness = { ...((internal.completeness as JsonObject) ?? {}) };
  const safeToClaimAbsence = completeness.safe_to_claim_absence === true;
  const next = ["running", "retry_wait"].includes(state.status) ? { tool: "yfy_inventory_get", arguments: { inventory: ref } } : undefined;
  const wait = suggestedWaitMs(state);
  const scope = inventoryScopeProjection(state);
  return {
    inventory: ref,
    inventory_id: state.scanId,
    workspace: scope.workspace,
    status: state.status,
    terminal: internal.terminal === true,
    counts: { files: state.fileCount, folders: state.folderCount, pages: state.pageReceiptCount },
    completeness,
    scan_root: scope.scan_root,
    agent_guidance: agentGuidance(state, safeToClaimAbsence),
    ...(extra?.planning ? { planning: extra.planning } : {}),
    ...(wait !== undefined ? { suggested_wait_ms: wait } : {}),
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

function inventoryScopeProjection(state: ScopeScanState): { scan_root: JsonObject; workspace: JsonObject } {
  return {
    workspace: {
      ref: state.workspaceRef,
      root: formatItemRef("folder", state.workspaceRootFolderId, state.accessContextId, state.accessIdentityRef),
      access_context: state.accessContextId,
      fingerprint: state.workspaceFingerprint
    },
    scan_root: {
      id: state.rootFolderId,
      ref: formatItemRef("folder", state.rootFolderId, state.accessContextId, state.accessIdentityRef)
    }
  };
}

async function resolveScanRootFolderId(runtime: AppRuntime, workspace: ResolvedScope, rootFolderArg: unknown, signal?: AbortSignal): Promise<string> {
  if (rootFolderArg === undefined || rootFolderArg === null) return workspace.scope.rootFolderId;
  const folder = parseItemRef(String(rootFolderArg));
  if (folder.type !== "folder") {
    throw new YifangyunError("root_folder must be a context-bound folder ref.", { code: "YFY_INPUT_INVALID", phase: "inventory_root_folder" });
  }
  if (folder.accessContextId !== workspace.context.id || folder.identityRef !== workspace.identityRef) {
    throw new YifangyunError("root_folder and workspace belong to different access identities.", {
      code: "YFY_REF_CONTEXT_CONFLICT",
      phase: "inventory_root_folder",
      suggestedAction: "Discover the folder under the same workspace identity before creating an inventory."
    });
  }
  if (folder.id === workspace.scope.rootFolderId) return folder.id;

  const [folderResponse, rootResponse] = await Promise.all([
    runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(folder.id)}/info`, workspace.context.id, {}, signal),
    runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(workspace.scope.rootFolderId)}/info`, workspace.context.id, {}, signal)
  ]);
  const folderItem = projectItem(folderResponse.data, "evidence");
  const rootItem = projectItem(rootResponse.data, "evidence");
  const membership = workspaceMembershipProof(folderItem, rootItem, workspace.scope.rootFolderId);
  if (membership.status === "outside") {
    throw new YifangyunError("root_folder is outside the configured workspace.", {
      code: "YFY_WORKSPACE_MEMBERSHIP_FAILED",
      phase: "inventory_root_folder",
      agentDetails: { folder_ref: String(rootFolderArg), workspace: workspace.scope.id, root_folder_id: workspace.scope.rootFolderId, membership: membership.status, reason: membership.reason, agent_interpretation: membership.agent_interpretation }
    });
  }
  if (membership.status === "unavailable") {
    throw new YifangyunError("root_folder membership in the configured workspace could not be proven.", {
      code: "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE",
      phase: "inventory_root_folder",
      suggestedAction: "Retry after the Provider exposes a complete ancestry chain for the folder.",
      agentDetails: { folder_ref: String(rootFolderArg), workspace: workspace.scope.id, root_folder_id: workspace.scope.rootFolderId, membership: membership.status, reason: membership.reason, agent_interpretation: membership.agent_interpretation }
    });
  }
  return folder.id;
}

export function registerInventoryTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("inventory")) return;

  registerTool(server, "yfy_inventory_create", {
    title: "Create Yifangyun Workspace Inventory",
    description: "WHEN: completeness/absence audit. DO NOT: claim absence unless may_claim_absence=true; prefer root_folder for large libraries. EXAMPLE: {\"workspace\":\"workspace:tender_public\",\"refresh\":{\"mode\":\"reuse_if_fresh\"},\"limits\":{\"max_item_depth\":8,\"max_items\":10000},\"root_folder\":\"folder:...\"}",
    inputSchema: {
      workspace: WorkspaceRefSchema,
      refresh: RefreshSchema,
      limits: z.object({ max_item_depth: z.number().int().min(1).max(100), max_items: z.number().int().min(1).max(1_000_000) }).strict(),
      root_folder: FolderRefSchema.optional()
    },
    outputSchema: { ...InventorySummaryShape, reuse: z.object({ reused: z.boolean(), reason: z.enum(["fresh_complete", "running_join", "new"]), mode: z.enum(["reuse_if_fresh", "force_refresh"]), max_age_seconds: z.number().int().nonnegative().optional() }).strict() }
  }, { readOnly: false, idempotent: false }, async (args, extra) => {
    const workspace = runtime.access.resolveWorkspaceRef(String(args.workspace));
    const refresh = RefreshSchema.parse(args.refresh);
    const limits = args.limits as { max_item_depth: number; max_items: number };
    const rootFolderId = await resolveScanRootFolderId(runtime, workspace, args.root_folder, extra.signal);
    const fingerprint = workspaceFingerprint({
      contextId: workspace.context.id,
      identityRef: workspace.identityRef,
      scanRootFolderId: rootFolderId,
      workspaceId: workspace.scope.id,
      workspaceRootFolderId: workspace.scope.rootFolderId
    }, runtime.config.clientSecret);
    const started = await runtime.snapshots.create({
      accessContextId: workspace.context.id,
      forceRefresh: refresh.mode === "force_refresh",
      includeFiles: true,
      includeFolders: true,
      maxAgeSeconds: refresh.mode === "reuse_if_fresh" ? refresh.max_age_seconds : 0,
      maxItemDepth: limits.max_item_depth,
      maxItems: limits.max_items,
      pageCapacity: runtime.config.maxPageCapacity,
      rootFolderId,
      signal: extra.signal,
      workspaceFingerprint: fingerprint,
      workspaceId: workspace.scope.id,
      workspaceRef: String(args.workspace),
      workspaceRootFolderId: workspace.scope.rootFolderId
    });
    const planning = inventoryPlanning(args.root_folder !== undefined && args.root_folder !== null, limits.max_items, limits.max_item_depth);
    return {
      ...summary(runtime, started.state, { planning }),
      reuse: { reused: started.reused, reason: started.reuseReason, mode: refresh.mode, ...(refresh.mode === "reuse_if_fresh" ? { max_age_seconds: refresh.max_age_seconds } : {}) }
    };
  });

  registerTool(server, "yfy_inventory_get", {
    title: "Get Yifangyun Workspace Inventory",
    description: "Read inventory identity, progress, diagnostics, retention and completeness. Copy the inventory ref returned by this server (stable for the same inventory).",
    inputSchema: { inventory: InventoryHandleSchema },
    outputSchema: InventorySummaryShape
  }, { readOnly: true, openWorld: false }, async ({ inventory }) => {
    const ref = resolveInventoryHandle(runtime, inventory);
    return summary(runtime, await stateForRef(runtime, ref));
  });

  registerTool(server, "yfy_inventory_search", {
    title: "Search Yifangyun Workspace Inventory",
    description: "WHEN: search fixed inventory watermark. DO NOT: treat empty items as absence unless empty_result_meaning supports it and may_claim_absence=true. EXAMPLE: {\"inventory\":\"inventory:<uuid>@default.<mac>\",\"query\":\"投标函\",\"kind\":\"file\"}",
    continuationFixedKeys: ["inventory"],
    inputSchema: InventorySearchInputSchema.inputSchema,
    inputValidator: InventorySearchInputSchema.validator,
    outputSchema: {
      inventory: InventoryRefSchema,
      empty_result_meaning: z.string().optional(),
      workspace: WorkspaceIdentitySchema,
      scan_root: ScanRootSchema,
      agent_guidance: AgentGuidanceSchema,
      status: InventoryStatusSchema,
      view: z.object({ commit_watermark: z.number().int().nonnegative(), current_commit_watermark: z.number().int().nonnegative(), stable: z.literal(true) }).strict(),
      items: z.array(z.record(z.unknown())),
      page: SimplePageSchema,
      next_action: NextActionSchema.optional(),
      completeness: CompletenessSchema
    }
  }, { readOnly: true, openWorld: false }, async (args) => {
    const pageArgs = resolvePaginationArgs(args, "inventory_search", { fixedKeys: ["inventory"] });
    const inventoryValue = String(pageArgs.kind === "continuation" ? pageArgs.fixed.inventory : (pageArgs.data as { inventory: string }).inventory);
    const ref = resolveInventoryHandle(runtime, inventoryValue);
    const loaded = await stateForRef(runtime, ref);
    const first = pageArgs.kind === "first" ? pageArgs.data as {
      inventory: string; query?: string; kind: "file" | "folder" | "all"; match_fields: Array<"name" | "path">; case_sensitive: boolean; limit: number;
    } : undefined;
    const continued = pageArgs.kind === "continuation"
      ? decodeCursor(pageArgs.cursor, { inventoryId: ref.inventoryId, workspaceFingerprint: loaded.workspaceFingerprint }, runtime.config.clientSecret)
      : undefined;
    const query = continued?.query ?? first?.query;
    const mode = continued?.mode ?? (query ? "search" as const : "list" as const);
    const itemType = continued?.itemType ?? first?.kind ?? "all";
    const limit = continued?.limit ?? first?.limit ?? DEFAULT_INVENTORY_PAGE_SIZE;
    const matchFields = continued?.matchFields ?? first?.match_fields ?? ["name", "path"];
    const caseSensitive = continued?.caseSensitive ?? first?.case_sensitive === true;
    const result = await runtime.snapshots.query({ accessContextId: ref.accessContext, cursor: continued?.cursor, limit, mode, queries: query ? [query] : undefined, matchFields, caseSensitive, scanId: ref.inventoryId, type: itemType });
    const nextCursor = result.nextCursor ? encodeInventoryCursor({ caseSensitive, cursor: result.nextCursor, inventoryId: ref.inventoryId, itemType, limit, matchFields, mode, query, workspaceFingerprint: result.state.workspaceFingerprint }, runtime.config.clientSecret) : undefined;
    const items = result.items.map((item) => typeof item.id === "string" && (item.type === "file" || item.type === "folder") ? { ...item, ref: formatItemRef(item.type, item.id, result.state.accessContextId, result.state.accessIdentityRef) } : item);
    const refValue = inventoryRef(runtime, result.state);
    const next = continuationAction("yfy_inventory_search", nextCursor, { inventory: refValue });
    const completeness = { ...(runtime.snapshots.summary(result.state).completeness as JsonObject) };
    const scope = inventoryScopeProjection(result.state);
    const page = pageOutput(items.length, nextCursor);
    const guidance = agentGuidance(result.state, completeness.safe_to_claim_absence === true, {
      emptyItems: items.length === 0,
      mode,
      hasMore: page.has_more === true
    });
    return {
      agent_guidance: guidance,
      ...(guidance.empty_result_meaning ? { empty_result_meaning: guidance.empty_result_meaning } : {}),
      status: result.state.status,
      completeness,
      scan_root: scope.scan_root,
      workspace: scope.workspace,
      inventory: refValue,
      view: { commit_watermark: continued?.cursor.watermark ?? result.state.commitWatermark, current_commit_watermark: result.state.commitWatermark, stable: true },
      items,
      page,
      ...(next ? { next_action: next } : {})
    };
  });

  registerTool(server, "yfy_inventory_cancel", {
    title: "Cancel Yifangyun Workspace Inventory", description: "Cancel an active inventory. Cancelling a terminal inventory is a no-op.", inputSchema: { inventory: InventoryHandleSchema }, outputSchema: { ...InventorySummaryShape, cancellation: z.object({ outcome: z.enum(["cancelled", "already_terminal"]) }).strict() }
  }, { readOnly: false, idempotent: true, openWorld: false }, async ({ inventory }) => {
    const ref = resolveInventoryHandle(runtime, inventory);
    const before = await stateForRef(runtime, ref);
    const terminal = ["complete", "partial", "cancelled", "failed"].includes(before.status);
    const state = terminal ? before : await runtime.snapshots.cancel(ref.inventoryId, ref.accessContext);
    return { ...summary(runtime, state), cancellation: { outcome: !terminal && state.status === "cancelled" ? "cancelled" : "already_terminal" } };
  });

  registerTool(server, "yfy_inventory_release", {
    title: "Release Yifangyun Workspace Inventory", description: "Delete one local inventory and invalidate its ref, cursors, manifest and receipt resources.", inputSchema: { inventory: InventoryHandleSchema }, outputSchema: { inventory: InventoryRefSchema, status: z.enum(["released", "already_unavailable"]) }
  }, { readOnly: false, destructive: true, idempotent: true, openWorld: false }, async ({ inventory }) => {
    const ref = resolveInventoryHandle(runtime, inventory);
    try {
      await stateForRef(runtime, ref);
    } catch (error) {
      if (error instanceof YifangyunError && error.code === "YFY_INVENTORY_NOT_FOUND") {
        return { inventory: ref.handle, status: "already_unavailable" };
      }
      throw error;
    }
    const released = await runtime.snapshots.release(ref.inventoryId, ref.accessContext);
    return { inventory: ref.handle, status: released ? "released" : "already_unavailable" };
  });

  server.registerResource("yfy_inventory_manifest", new ResourceTemplate("yfy://inventory/{inventory_id}/{artifact_token}/{access_context}/manifest", { list: undefined }), { title: "Yifangyun Inventory Manifest", description: "Inventory observation digest without inline page receipts.", mimeType: "application/json" }, async (uri, variables) => {
    const state = await runtime.snapshots.get(String(variables.inventory_id), String(variables.access_context));
    assertCurrentWorkspaceState(runtime, state);
    if (state.artifactToken !== String(variables.artifact_token)) throw new YifangyunError("Inventory manifest token is invalid.", { code: "YFY_INVENTORY_ARTIFACT_FORBIDDEN", phase: "inventory_resource", scanId: state.scanId });
    const manifest = await runtime.snapshots.manifest(state.scanId, state.accessContextId);
    const completeness = (manifest.completeness as JsonObject) ?? {};
    const scope = inventoryScopeProjection(state);
    const projected = { ...manifest, workspace: scope.workspace, scan_root: scope.scan_root, agent_guidance: agentGuidance(state, completeness.safe_to_claim_absence === true) };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(projected) }] };
  });

  server.registerResource("yfy_inventory_receipts", new ResourceTemplate("yfy://inventory/{inventory_id}/{artifact_token}/{access_context}/receipts/{page}", { list: undefined }), { title: "Yifangyun Inventory Receipts", description: "One bounded page of inventory Provider receipts.", mimeType: "application/json" }, async (uri, variables) => {
    const state = await runtime.snapshots.get(String(variables.inventory_id), String(variables.access_context));
    assertCurrentWorkspaceState(runtime, state);
    if (state.artifactToken !== String(variables.artifact_token)) throw new YifangyunError("Inventory receipt token is invalid.", { code: "YFY_INVENTORY_ARTIFACT_FORBIDDEN", phase: "inventory_resource", scanId: state.scanId });
    const page = Number(variables.page);
    if (!Number.isSafeInteger(page) || page < 0) throw new YifangyunError("Receipt page is invalid.", { code: "YFY_INPUT_INVALID", phase: "inventory_resource" });
    const result = await runtime.snapshots.receipts(state.scanId, state.accessContextId, page);
    const pageCount = Math.ceil(result.total / 25);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ inventory_id: state.scanId, page, page_count: pageCount, total_count: result.total, receipts: result.receipts.map(projectInventoryReceipt), ...(page + 1 < pageCount ? { next_uri: `yfy://inventory/${state.scanId}/${state.artifactToken}/${state.accessContextId}/receipts/${page + 1}` } : {}) }) }] };
  });
}
