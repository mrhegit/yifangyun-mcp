import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReadiness } from "../capabilities.js";
import { YifangyunError } from "../client.js";
import { getConfigSummary } from "../config.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { normalizeFileVersions } from "../domain/fileVersions.js";
import { formatItemRef, formatVersionRef, parseItemRef, parsePlaceRef } from "../domain/refs.js";
import { arrayValue, objectValue, projectItem, projectItemPage, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { ResolvedAccess } from "../runtime/access.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ApiJsonResponse, JsonObject, JsonValue } from "../types.js";
import { BUILD_COMMIT, BUILD_ID, CONTRACT_VERSION, SERVER_NAME, SERVER_VERSION } from "../version.js";
import { continuationAction, pageOutput, paginatedRequestSchema, parsePaginatedRequest } from "./pagination.js";
import { FileRefSchema, FileVersionSchema, ItemRefSchema, ItemSchema, NextActionSchema, PlaceRefSchema, ProvenanceSchema, SimplePageSchema, VersionRefSchema } from "./schemas.js";
import { registerTool, serializeError } from "./tooling.js";

type ItemKind = "file" | "folder" | "all";
type Detail = "basic" | "standard" | "full";
type SearchField = "name" | "content" | "creator" | "tag" | "all";
const DEFAULT_DRIVE_PAGE_SIZE = 10;
const AccessContextSchema = z.string().trim().min(1).optional();
const DriveItemSchema = ItemSchema.extend({ ref: ItemRefSchema });
const PageOutputShape = { page: SimplePageSchema, next_action: NextActionSchema.optional() };

const BrowseRequestSchema = paginatedRequestSchema({
  at: PlaceRefSchema.default("personal"),
  kind: z.enum(["file", "folder", "all"]).default("all"),
  detail: z.enum(["basic", "standard", "full"]).default("basic"),
  limit: z.number().int().min(1).max(100).default(DEFAULT_DRIVE_PAGE_SIZE),
  access_context: AccessContextSchema
});
const SearchRequestSchema = paginatedRequestSchema({
  query: z.string().trim().min(1).max(200),
  in: PlaceRefSchema.default("personal"),
  kind: z.enum(["file", "folder", "all"]).default("all"),
  field: z.enum(["name", "content", "creator", "tag", "all"]).default("all"),
  detail: z.enum(["basic", "standard", "full"]).default("basic"),
  exact_name: z.boolean().optional(),
  sort: z.enum(["name", "date", "size", "score"]).default("score"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  include_unverified_index_hits: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(DEFAULT_DRIVE_PAGE_SIZE),
  access_context: AccessContextSchema
}).superRefine((request, context) => {
  if (request.mode === "first_request" && request.exact_name !== undefined && request.field !== "name") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["exact_name"], message: "exact_name is only valid when field=name." });
  }
});
const VersionsRequestSchema = paginatedRequestSchema({ file: FileRefSchema, limit: z.number().int().min(1).max(100).default(DEFAULT_DRIVE_PAGE_SIZE) });
const CommentsRequestSchema = paginatedRequestSchema({ file: FileRefSchema, limit: z.number().int().min(1).max(100).default(DEFAULT_DRIVE_PAGE_SIZE) });
const SharesRequestSchema = paginatedRequestSchema({ item: ItemRefSchema, limit: z.number().int().min(1).max(100).default(DEFAULT_DRIVE_PAGE_SIZE) });

const BrowseCursorSchema = z.object({ at: PlaceRefSchema, kind: z.enum(["file", "folder", "all"]), detail: z.enum(["basic", "standard", "full"]), page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), access_context: z.string().optional() }).strict();
const SearchCursorSchema = z.object({ query: z.string().min(1), at: PlaceRefSchema, kind: z.enum(["file", "folder", "all"]), field: z.enum(["name", "content", "creator", "tag", "all"]), detail: z.enum(["basic", "standard", "full"]), exact_name: z.boolean(), sort: z.enum(["name", "date", "size", "score"]), direction: z.enum(["asc", "desc"]), include_unverified_index_hits: z.boolean(), page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), access_context: z.string().optional() }).strict();
const VersionsCursorSchema = z.object({ file: FileRefSchema, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), fingerprint: z.string().min(1) }).strict();
const CommentsCursorSchema = z.object({ file: FileRefSchema, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), fingerprint: z.string().min(1) }).strict();
const SharesCursorSchema = z.object({ item: ItemRefSchema, page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();

const SEARCH_NON_EXHAUSTIVE_WARNING = "Indexed search is non-exhaustive: it cannot prove current existence or absence.";
const SEARCH_CLAIM_WARNING = "match.claim_allowed=true means returned metadata supports the query match; confirm current existence with yfy_get before relying on the item. Provider snippets and unverified index hits must not be asserted as confirmed matches.";
const VERSION_SELECTION_RULES = {
  current: "Omit the version parameter on yfy_open/yfy_capture for the current version. Do not invent a version ref.",
  historical: "Copy the historical version ref from this result and pass it as the version parameter on yfy_open/yfy_capture."
} as const;

const SearchMatchFieldSchema = z.object({
  field: z.enum(["name", "content", "creator", "tag", "all"]),
  basis: z.enum(["local_value_match", "provider_value_match", "provider_snippet", "provider_index_only"]),
  value: z.string().optional(),
  verifiable: z.boolean()
}).strict();
const SearchScopeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("provider_filtered"), basis: z.literal("department_filter") }).strict(),
  z.object({ status: z.literal("verified"), basis: z.enum(["parent_folder_id", "ancestor_folder_ids"]) }).strict(),
  z.object({ status: z.literal("rejected"), basis: z.literal("local_scope_filter") }).strict()
]);
const SearchMatchCommonShape = {
  source: z.literal("provider_index"),
  requested_field: z.enum(["name", "content", "creator", "tag", "all"]),
  provider_filter: z.object({ query_filter: z.string(), precise_search: z.boolean() }).strict(),
  fields: z.array(SearchMatchFieldSchema).min(1),
  scope: SearchScopeSchema,
  exact_name: z.discriminatedUnion("status", [
    z.object({ status: z.literal("verified"), basis: z.literal("case_sensitive_name_equality") }).strict(),
    z.object({ status: z.literal("not_requested") }).strict()
  ]),
  provider_signals: z.array(z.object({ source_field: z.string(), value: z.union([z.string(), z.number()]) }).strict()),
  disambiguation_required: z.boolean(),
  same_name_hit_count_in_provider_page: z.number().int().min(2).optional(),
  uniqueness: z.object({ status: z.enum(["multiple_in_provider_page", "not_proven"]), basis: z.literal("non_exhaustive_provider_search") }).strict().optional()
};
const SearchMatchSchema = z.discriminatedUnion("trust", [
  z.object({ ...SearchMatchCommonShape, trust: z.literal("locally_verified"), claim_allowed: z.literal(true) }).strict(),
  z.object({ ...SearchMatchCommonShape, trust: z.literal("provider_snippet"), claim_allowed: z.literal(false) }).strict(),
  z.object({ ...SearchMatchCommonShape, trust: z.literal("unverified_index_hit"), claim_allowed: z.literal(false) }).strict()
]);

function detailView(detail: Detail): "summary" | "evidence" | "full" {
  return detail === "basic" ? "summary" : detail === "standard" ? "evidence" : "full";
}

function assertRefAccess(runtime: AppRuntime, ref: ReturnType<typeof parseItemRef>): ResolvedAccess {
  const access = runtime.gateway.context(ref.accessContextId);
  if (access.identityRef !== ref.identityRef) {
    throw new YifangyunError("Item reference belongs to a different configured identity.", {
      code: "YFY_REF_IDENTITY_MISMATCH",
      phase: "item_reference",
      suggestedAction: "Discover the item again with the current server configuration."
    });
  }
  return access;
}

function resolveItemRef(runtime: AppRuntime, value: string, expectedType?: "file" | "folder") {
  const item = parseItemRef(value);
  if (expectedType && item.type !== expectedType) throw new YifangyunError(`A ${expectedType} ref is required.`, { code: "YFY_INPUT_INVALID", phase: "item_reference" });
  return { access: assertRefAccess(runtime, item), item, ref: value };
}

function formatBoundItem(item: JsonObject, access: ResolvedAccess): JsonObject {
  return typeof item.id === "string" && (item.type === "file" || item.type === "folder")
    ? { ...item, ref: formatItemRef(item.type, item.id, access.context.id, access.identityRef) }
    : item;
}

function driveItem(value: JsonValue | undefined, access: ResolvedAccess, detail: Detail = "standard"): JsonObject {
  return formatBoundItem(projectItem(value, detailView(detail)), access);
}

function resolvedPlace(runtime: AppRuntime, value: string, accessContext?: string) {
  const place = parsePlaceRef(value);
  if (place.kind === "workspace") {
    const workspace = runtime.access.resolveWorkspaceRef(value);
    if (accessContext && accessContext !== workspace.context.id) throw new YifangyunError("access_context conflicts with the selected workspace.", { code: "YFY_INPUT_INVALID", phase: "place_resolution" });
    return { access: workspace, folderId: workspace.scope.rootFolderId, place };
  }
  if (place.kind === "folder") {
    const access = assertRefAccess(runtime, place.item);
    if (accessContext && accessContext !== access.context.id) throw new YifangyunError("access_context conflicts with the selected folder ref.", { code: "YFY_INPUT_INVALID", phase: "place_resolution" });
    return { access, folderId: place.item.id, place };
  }
  const access = runtime.gateway.context(accessContext);
  if (place.kind === "personal") return { access, departmentId: "0", endpoint: "/v2/folder/personal_items", place };
  if (place.kind === "collaboration") return { access, departmentId: "-1", endpoint: "/v2/folder/collab_folders", place };
  return { access, departmentId: place.departmentId, endpoint: "/v2/folder/department_folders", place };
}

async function placePage(runtime: AppRuntime, at: string, kind: ItemKind, pageId: number, capacity: number, accessContext: string | undefined, signal?: AbortSignal): Promise<ApiJsonResponse> {
  const resolved = resolvedPlace(runtime, at, accessContext);
  if (resolved.folderId) return runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/children`, resolved.access.context.id, { type: kind, page_id: pageId, page_capacity: capacity }, signal);
  return runtime.gateway.getUser(resolved.endpoint!, resolved.access.context.id, { ...(resolved.place.kind === "department" ? { department_id: resolved.departmentId } : {}), page_id: pageId, page_capacity: capacity }, signal);
}

async function searchPlace(runtime: AppRuntime, at: string, accessContext: string | undefined, signal?: AbortSignal) {
  const resolved = resolvedPlace(runtime, at, accessContext);
  if (!resolved.folderId) return { access: resolved.access, departmentId: resolved.departmentId! };
  const info = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/info`, resolved.access.context.id, {}, signal);
  const space = objectValue((objectValue(info.data) ?? {}).space) ?? {};
  const type = typeof space.type === "string" ? space.type.toLowerCase() : undefined;
  const departmentId = type === "personal" ? "0" : type?.includes("collab") ? "-1" : typeof space.id === "string" || typeof space.id === "number" ? String(space.id) : undefined;
  if (!departmentId) throw new YifangyunError("The place storage space could not be resolved for indexed search.", { code: "YFY_ROOT_SPACE_UNKNOWN", phase: "place_resolution" });
  return { access: resolved.access, departmentId, folderId: resolved.folderId };
}

function pageHasMore(page: JsonObject): boolean {
  return page.has_more === true || typeof page.next_page_id === "number";
}

function providerSignals(source: JsonObject): JsonObject[] {
  const signals: JsonObject[] = [];
  for (const field of ["score", "search_score", "snippet", "highlight", "content_highlight"] as const) {
    const value = source[field];
    if (typeof value === "string" || typeof value === "number") signals.push({ source_field: field, value });
  }
  return signals;
}

function searchMatch(source: JsonObject, item: JsonObject, field: SearchField, query: string, exactName: boolean, rootFolderId?: string): JsonObject {
  const fields: JsonObject[] = [];
  const lowerQuery = query.toLocaleLowerCase("zh-CN");
  if ((field === "name" || field === "all") && typeof item.name === "string" && item.name.toLocaleLowerCase("zh-CN").includes(lowerQuery)) fields.push({ field: "name", basis: "local_value_match", value: item.name, verifiable: true });
  const ownerName = objectValue(source.owned_by ?? source.creator)?.name;
  if ((field === "creator" || field === "all") && typeof ownerName === "string" && ownerName.toLocaleLowerCase("zh-CN").includes(lowerQuery)) fields.push({ field: "creator", basis: "provider_value_match", value: ownerName, verifiable: true });
  const snippet = [source.snippet, source.highlight, source.content_highlight].find((value) => typeof value === "string");
  if ((field === "content" || field === "all") && typeof snippet === "string") {
    const snippetText = String(snippet);
    // Snippet without the query string is not usable as match evidence.
    if (snippetText.toLocaleLowerCase("zh-CN").includes(lowerQuery)) fields.push({ field: "content", basis: "provider_snippet", value: snippetText, verifiable: false });
    else fields.push({ field: "content", basis: "provider_index_only", value: snippetText, verifiable: false });
  }
  if (fields.length === 0) fields.push({ field, basis: "provider_index_only", verifiable: false });
  const bases = fields.map((entry) => entry.basis);
  const trust = bases.some((basis) => basis === "local_value_match" || basis === "provider_value_match")
    ? "locally_verified"
    : bases.some((basis) => basis === "provider_snippet")
      ? "provider_snippet"
      : "unverified_index_hit";
  const claimAllowed = trust === "locally_verified";
  const ancestors = Array.isArray(item.ancestor_folder_ids) ? item.ancestor_folder_ids : [];
  const scope = !rootFolderId ? { status: "provider_filtered", basis: "department_filter" }
    : item.parent_folder_id === rootFolderId ? { status: "verified", basis: "parent_folder_id" }
      : ancestors.includes(rootFolderId) ? { status: "verified", basis: "ancestor_folder_ids" }
        : { status: "rejected", basis: "local_scope_filter" };
  return {
    source: "provider_index",
    requested_field: field,
    provider_filter: { query_filter: field === "name" ? "file_name" : field, precise_search: exactName },
    fields,
    scope,
    trust,
    claim_allowed: claimAllowed,
    exact_name: exactName ? { status: "verified", basis: "case_sensitive_name_equality" } : { status: "not_requested" },
    provider_signals: providerSignals(source),
    disambiguation_required: false,
    ...(exactName ? { uniqueness: { status: "not_proven", basis: "non_exhaustive_provider_search" } } : {})
  };
}

function applySearchDisambiguation(hits: Array<{ item: JsonObject; match: JsonObject }>, exactName: boolean): number {
  const nameCounts = new Map<string, number>();
  for (const hit of hits) {
    const name = typeof hit.item.name === "string" ? hit.item.name : "";
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  let disambiguationGroups = 0;
  const counted = new Set<string>();
  for (const hit of hits) {
    const name = typeof hit.item.name === "string" ? hit.item.name : "";
    const sameNameCount = nameCounts.get(name) ?? 1;
    if (sameNameCount >= 2) {
      hit.match.disambiguation_required = true;
      hit.match.same_name_hit_count_in_provider_page = sameNameCount;
      if (exactName) hit.match.uniqueness = { status: "multiple_in_provider_page", basis: "non_exhaustive_provider_search" };
      if (!counted.has(name)) {
        counted.add(name);
        disambiguationGroups += 1;
      }
    }
  }
  return disambiguationGroups;
}

async function findAcrossPages(runtime: AppRuntime, at: string, pathText: string, accessContext: string | undefined, signal?: AbortSignal) {
  const segments = pathText.split("/").map((segment) => segment.trim()).filter(Boolean);
  let currentPlace = at;
  const matched: JsonObject[] = [];
  const observations: JsonObject[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const isLast = segmentIndex === segments.length - 1;
    const candidates: JsonObject[] = [];
    let exhausted = false;
    for (let pageId = 0; pageId < 10_000; pageId += 1) {
      const resolved = resolvedPlace(runtime, currentPlace, accessContext);
      const response = await placePage(runtime, currentPlace, isLast ? "all" : "folder", pageId, runtime.config.maxPageCapacity, accessContext, signal);
      observations.push(provenance(response.meta, undefined, "drive_resolve_page"));
      const projected = projectItemPage(response.data, "summary", { pageCapacity: runtime.config.maxPageCapacity, pageId });
      const items = [...(projected.folders as JsonObject[]), ...(projected.files as JsonObject[])];
      candidates.push(...items.filter((entry) => entry.name === segments[segmentIndex] && (isLast || entry.type === "folder")).map((entry) => formatBoundItem(entry, resolved.access)));
      if (!pageHasMore(projected.page as JsonObject)) { exhausted = true; break; }
    }
    if (!exhausted) throw new YifangyunError("Path resolution exceeded the bounded Provider page limit.", { code: "YFY_RESOLVE_PAGE_LIMIT", phase: "drive_resolve", suggestedAction: "Resolve from a narrower folder ref." });
    if (candidates.length === 0) return { outcome: { status: "not_found", missing_segment: segments[segmentIndex], segment_index: segmentIndex, matched_segments: matched }, provenance: observations };
    if (candidates.length > 1) return { outcome: { status: "ambiguous", ambiguous_segment: segments[segmentIndex], segment_index: segmentIndex, candidates, matched_segments: matched }, provenance: observations };
    const found = candidates[0]!;
    matched.push(found);
    if (!isLast) currentPlace = String(found.ref);
  }
  return { outcome: { status: "resolved", item: matched.at(-1), matched_segments: matched }, provenance: observations };
}

function firstArray(source: JsonObject, ...keys: string[]): JsonValue[] {
  for (const key of keys) {
    const values = arrayValue(source[key]);
    if (values.length > 0) return values;
  }
  return [];
}

export function registerStatusTool(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_status", {
    title: "Get Yifangyun Drive Status",
    description: "Check the effective process configuration, drive identity, enabled capabilities and copyable places.",
    inputSchema: {},
    outputSchema: {
      connected: z.boolean(),
      provider: z.object({ status: z.enum(["connected", "unavailable"]), error: z.record(z.unknown()).optional() }).strict(),
      server: z.object({ name: z.string(), version: z.string(), contract_version: z.number().int().positive(), build_id: z.string(), build_commit: z.string(), instance_id: z.string(), started_at: z.string(), config_fingerprint: z.string() }).strict(),
      identity: z.object({ access_context: z.string(), user: z.record(z.unknown()).optional() }).strict(),
      places: z.array(z.object({ ref: PlaceRefSchema, kind: z.string(), name: z.string().optional(), tags: z.array(z.string()).optional() }).strict()),
      capabilities: z.array(z.string()), profiles: z.array(z.record(z.unknown())), runtime: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])), provenance: z.array(ProvenanceSchema)
    }
  }, { readOnly: true, openWorld: false }, async (_args, extra) => {
    const access = runtime.gateway.context();
    const local = {
      server: { name: SERVER_NAME, version: SERVER_VERSION, contract_version: CONTRACT_VERSION, build_id: BUILD_ID, build_commit: BUILD_COMMIT, instance_id: runtime.instanceId, started_at: runtime.startedAtIso, config_fingerprint: runtime.configFingerprint },
      places: [{ ref: "personal", kind: "personal", name: "Personal drive" }, { ref: "collaboration", kind: "collaboration", name: "Collaboration" }, ...runtime.access.listScopes().map((workspace) => ({ ref: runtime.access.workspaceRef(workspace.id), kind: "workspace", name: workspace.id, tags: workspace.tags }))],
      capabilities: runtime.config.toolsets,
      profiles: profileReadiness(runtime.config),
      runtime: getConfigSummary(runtime.config)
    };
    try {
      await runtime.client.getEnterpriseToken(extra.signal);
      await runtime.client.getUserToken(access.context.userId, extra.signal);
      const user = await runtime.gateway.getUser("/v2/user/info", access.context.id, {}, extra.signal);
      return { connected: true, provider: { status: "connected" }, ...local, identity: { access_context: access.context.id, user: projectUser(user.data, false) }, provenance: [provenance(user.meta, undefined, "user_info")] };
    } catch (error) {
      return { connected: false, provider: { status: "unavailable", error: serializeError(error) }, ...local, identity: { access_context: access.context.id }, provenance: [] };
    }
  });
}

export function registerDriveTools(server: McpServer, runtime: AppRuntime): void {
  registerStatusTool(server, runtime);
  registerTool(server, "yfy_browse", {
    title: "Browse Yifangyun Drive",
    description: "List one drive place. Use request.mode=first_request initially and execute next_action for continuation.",
    inputSchema: z.object({ request: BrowseRequestSchema }).strict(),
    outputSchema: { items: z.array(DriveItemSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(BrowseRequestSchema, args.request, "drive_browse");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_browse", request.cursor, BrowseCursorSchema) : undefined;
    const at = cursor?.at ?? (request.mode === "first_request" ? request.at : "personal");
    const kind = cursor?.kind ?? (request.mode === "first_request" ? request.kind : "all");
    const detail = cursor?.detail ?? (request.mode === "first_request" ? request.detail : "basic");
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_DRIVE_PAGE_SIZE);
    const accessContext = cursor?.access_context ?? (request.mode === "first_request" ? request.access_context : undefined);
    const capacity = Math.min(runtime.config.maxPageCapacity, Math.max(50, limit));
    const resolved = resolvedPlace(runtime, at, accessContext);
    const response = await placePage(runtime, at, kind, pageId, capacity, accessContext, extra.signal);
    const projected = projectItemPage(response.data, detailView(detail), { pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
    const allItems = [...(projected.folders as JsonObject[]), ...(projected.files as JsonObject[])].map((item) => formatBoundItem(item, resolved.access));
    const items = allItems.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const providerPage = projected.page as JsonObject;
    const nextCursor = nextOffset < allItems.length
      ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_browse", { at, kind, detail, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) })
      : pageHasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_browse", { at, kind, detail, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit, ...(accessContext ? { access_context: accessContext } : {}) }) : undefined;
    const next = continuationAction("yfy_browse", nextCursor);
    return { items, page: pageOutput(items.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "drive_browse") };
  });

  registerTool(server, "yfy_search", {
    title: "Search Yifangyun Drive",
    description: "Search the non-exhaustive Provider index for candidates. This never proves absence. match.claim_allowed=true means returned metadata supports the query match, but yfy_get is required to confirm current existence. Provider snippets and unverified index hits must not be asserted. Disambiguate by path/ref before opening or capturing.",
    inputSchema: z.object({ request: SearchRequestSchema }).strict(),
    outputSchema: {
      agent_warnings: z.array(z.string()).min(1),
      coverage: z.object({
        mode: z.literal("provider_index"),
        exhaustive: z.literal(false),
        agent_must_read: z.literal(true),
        does_not_prove_current_existence: z.literal(true),
        does_not_prove_absence: z.literal(true),
        current_existence_confirmation_tool: z.literal("yfy_get"),
        counts: z.object({
          provider_raw: z.number().int().nonnegative(),
          returned: z.number().int().nonnegative(),
          returned_verified: z.number().int().nonnegative(),
          returned_unverified: z.number().int().nonnegative(),
          verified_hits: z.number().int().nonnegative(),
          unverified_index_hits: z.number().int().nonnegative(),
          scope_rejected: z.number().int().nonnegative(),
          disambiguation_groups: z.number().int().nonnegative()
        }).strict(),
        note: z.string()
      }).strict(),
      hits: z.array(z.object({ item: DriveItemSchema, match: SearchMatchSchema }).strict()),
      unverified_hits: z.array(z.object({ item: DriveItemSchema, match: SearchMatchSchema }).strict()),
      ...PageOutputShape,
      provenance: ProvenanceSchema
    }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(SearchRequestSchema, args.request, "drive_search");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_search", request.cursor, SearchCursorSchema) : undefined;
    const query = cursor?.query ?? (request.mode === "first_request" ? request.query : "");
    const at = cursor?.at ?? (request.mode === "first_request" ? request.in : "personal");
    const kind = cursor?.kind ?? (request.mode === "first_request" ? request.kind : "all");
    const field = cursor?.field ?? (request.mode === "first_request" ? request.field : "all");
    const detail = cursor?.detail ?? (request.mode === "first_request" ? request.detail : "basic");
    const exactName = cursor?.exact_name ?? (request.mode === "first_request" && request.exact_name === true);
    const sort = cursor?.sort ?? (request.mode === "first_request" ? request.sort : "score");
    const direction = cursor?.direction ?? (request.mode === "first_request" ? request.direction : "desc");
    const includeUnverified = cursor?.include_unverified_index_hits ?? (request.mode === "first_request" ? request.include_unverified_index_hits === true : false);
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_DRIVE_PAGE_SIZE);
    const accessContext = cursor?.access_context ?? (request.mode === "first_request" ? request.access_context : undefined);
    const root = await searchPlace(runtime, at, accessContext, extra.signal);
    const capacity = Math.min(runtime.config.maxPageCapacity, Math.max(50, limit));
    const response = await runtime.gateway.getUser("/v2/item/search", root.access.context.id, { query_words: query, type: kind, query_filter: field === "name" ? "file_name" : field, department_id: root.departmentId, search_in_folder: root.folderId, precise_search: exactName, sort_by: sort, sort_direction: direction, page_id: pageId, page_capacity: capacity }, extra.signal);
    const source = objectValue(response.data) ?? {};
    const rawItems = [...arrayValue(source.files), ...arrayValue(source.folders)];
    let scopeRejected = 0;
    const verifiedEligible: Array<{ item: JsonObject; match: JsonObject }> = [];
    const unverifiedEligible: Array<{ item: JsonObject; match: JsonObject }> = [];
    const orderedEligible: Array<{ item: JsonObject; match: JsonObject; bucket: "verified" | "unverified" }> = [];
    for (const entry of rawItems) {
      const raw = objectValue(entry) ?? {};
      const item = driveItem(entry, root.access, detail);
      if (typeof item.id !== "string" || typeof item.name !== "string" || (item.type !== "file" && item.type !== "folder")) continue;
      const match = searchMatch(raw, item, field, query, exactName, root.folderId);
      if ((match.scope as JsonObject).status === "rejected") {
        scopeRejected += 1;
        continue;
      }
      if (exactName && item.name !== query) continue;
      const candidate = { item, match };
      if (match.claim_allowed === true) {
        verifiedEligible.push(candidate);
        orderedEligible.push({ ...candidate, bucket: "verified" });
      } else {
        unverifiedEligible.push(candidate);
        orderedEligible.push({ ...candidate, bucket: "unverified" });
      }
    }
    const disambiguationGroups = applySearchDisambiguation(orderedEligible, exactName);
    const visibleCandidates = includeUnverified ? orderedEligible : orderedEligible.filter((candidate) => candidate.bucket === "verified");
    const selected = visibleCandidates.slice(offset, offset + limit);
    const hits = selected.filter((candidate) => candidate.bucket === "verified").map(({ bucket: _bucket, ...candidate }) => candidate);
    const unverifiedHits = selected.filter((candidate) => candidate.bucket === "unverified").map(({ bucket: _bucket, ...candidate }) => candidate);
    const nextOffset = offset + selected.length;
    const providerPage = projectPage(response.data, { itemCount: rawItems.length, providerCount: rawItems.length, pageCapacity: capacity, pageId });
    const payload = { query, at, kind, field, detail, exact_name: exactName, sort, direction, include_unverified_index_hits: includeUnverified, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < visibleCandidates.length
      ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_search", payload)
      : pageHasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_search", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 })
        : undefined;
    const next = continuationAction("yfy_search", nextCursor);
    const agentWarnings = [SEARCH_NON_EXHAUSTIVE_WARNING, SEARCH_CLAIM_WARNING];
    if (unverifiedEligible.length > 0 && !includeUnverified) {
      agentWarnings.push(`${unverifiedEligible.length} unverified Provider index hit(s) were counted but omitted from hits (set include_unverified_index_hits=true to inspect them).`);
    }
    if (disambiguationGroups > 0) {
      agentWarnings.push("Some Provider-page candidates share the same name; disambiguate by path/ref and confirm with yfy_get before opening or capturing.");
    }
    return {
      agent_warnings: agentWarnings,
      coverage: {
          mode: "provider_index",
          exhaustive: false,
          agent_must_read: true,
          does_not_prove_current_existence: true,
          does_not_prove_absence: true,
          current_existence_confirmation_tool: "yfy_get",
          counts: {
            provider_raw: rawItems.length,
            returned: selected.length,
            returned_verified: hits.length,
            returned_unverified: unverifiedHits.length,
          verified_hits: verifiedEligible.length,
          unverified_index_hits: unverifiedEligible.length,
          scope_rejected: scopeRejected,
          disambiguation_groups: disambiguationGroups
        },
        note: "Provider index search is non-exhaustive. claim_allowed=true supports the query match from returned metadata, but yfy_get is required to confirm current existence; this result never proves absence."
      },
      hits,
      unverified_hits: unverifiedHits,
      page: pageOutput(selected.length, nextCursor),
      ...(next ? { next_action: next } : {}),
      provenance: provenance(response.meta, undefined, "drive_search")
    };
  });

  const ResolveOutcomeSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), item: DriveItemSchema, matched_segments: z.array(DriveItemSchema) }).strict(),
    z.object({ status: z.literal("not_found"), missing_segment: z.string(), segment_index: z.number().int().nonnegative(), matched_segments: z.array(DriveItemSchema) }).strict(),
    z.object({ status: z.literal("ambiguous"), ambiguous_segment: z.string(), segment_index: z.number().int().nonnegative(), candidates: z.array(DriveItemSchema).min(2), matched_segments: z.array(DriveItemSchema) }).strict()
  ]);
  registerTool(server, "yfy_resolve", {
    title: "Resolve Yifangyun Path", description: "Resolve an exact relative path. Ambiguous names return candidates and are never guessed.",
    inputSchema: { path: z.string().trim().min(1), from: PlaceRefSchema.default("personal"), access_context: AccessContextSchema },
    outputSchema: { outcome: ResolveOutcomeSchema, provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ path, from, access_context }, extra) => findAcrossPages(runtime, String(from ?? "personal"), String(path), typeof access_context === "string" ? access_context : undefined, extra.signal));

  registerTool(server, "yfy_get", {
    title: "Get Yifangyun Item", description: "Get current metadata for one context-bound item ref.",
    inputSchema: { ref: ItemRefSchema, detail: z.enum(["basic", "standard", "full"]).default("standard") }, outputSchema: { item: DriveItemSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ ref, detail }, extra) => {
    const resolved = resolveItemRef(runtime, String(ref));
    const endpoint = resolved.item.type === "file" ? `/v2/file/${encodeURIComponent(resolved.item.id)}/info_v2` : `/v2/folder/${encodeURIComponent(resolved.item.id)}/info`;
    const response = await runtime.gateway.getUser(endpoint, resolved.access.context.id, {}, extra.signal);
    return { item: driveItem(response.data, resolved.access, detail as Detail), provenance: provenance(response.meta, undefined, "item_metadata") };
  });

  registerTool(server, "yfy_get_many", {
    title: "Get Multiple Yifangyun Items", description: "Get current metadata for up to 100 context-bound item refs while preserving partial successes.",
    inputSchema: { refs: z.array(ItemRefSchema).min(1).max(100), detail: z.enum(["basic", "standard", "full"]).default("standard") },
    outputSchema: { results: z.array(z.discriminatedUnion("status", [z.object({ index: z.number().int().nonnegative(), ref: ItemRefSchema, status: z.literal("success"), item: DriveItemSchema, provenance: ProvenanceSchema }).strict(), z.object({ index: z.number().int().nonnegative(), ref: ItemRefSchema, status: z.literal("error"), error: z.record(z.unknown()) }).strict()])), summary: z.object({ requested_count: z.number().int().nonnegative(), success_count: z.number().int().nonnegative(), error_count: z.number().int().nonnegative() }).strict() }
  }, { readOnly: true }, async ({ refs, detail }, extra) => {
    const results = await Promise.all((refs as string[]).map(async (ref, index) => {
      try {
        const resolved = resolveItemRef(runtime, ref);
        const endpoint = resolved.item.type === "file" ? `/v2/file/${encodeURIComponent(resolved.item.id)}/info_v2` : `/v2/folder/${encodeURIComponent(resolved.item.id)}/info`;
        const response = await runtime.gateway.getUser(endpoint, resolved.access.context.id, {}, extra.signal);
        return { index, ref, status: "success" as const, item: driveItem(response.data, resolved.access, detail as Detail), provenance: provenance(response.meta, undefined, "item_metadata") };
      } catch (error) { return { index, ref, status: "error" as const, error: serializeError(error) }; }
    }));
    const successCount = results.filter((result) => result.status === "success").length;
    return { results, summary: { requested_count: results.length, success_count: successCount, error_count: results.length - successCount } };
  });

  registerTool(server, "yfy_versions", {
    title: "List Yifangyun File Versions",
    description: "List file versions for one context-bound file ref. Current versions use ref=null (omit version on open/capture); historical versions return a copyable version ref.",
    inputSchema: z.object({ request: VersionsRequestSchema }).strict(),
    outputSchema: {
      file: FileRefSchema,
      versions: z.array(FileVersionSchema.extend({
        ref: VersionRefSchema.nullable(),
        file: FileRefSchema,
        usage: z.object({
          for_open_or_capture: z.enum(["omit_version_parameter", "pass_version_ref"]),
          note: z.string()
        }).strict()
      })),
      version_selection_rules: z.object({ current: z.string(), historical: z.string() }).strict(),
      fingerprint: z.string(),
      ...PageOutputShape,
      provenance: ProvenanceSchema
    }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(VersionsRequestSchema, args.request, "drive_versions");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_versions", request.cursor, VersionsCursorSchema) : undefined;
    const file = cursor?.file ?? (request.mode === "first_request" ? request.file : "");
    const resolved = resolveItemRef(runtime, file, "file");
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_DRIVE_PAGE_SIZE);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(resolved.item.id)}/versions`, resolved.access.context.id, {}, extra.signal);
    const normalized = normalizeFileVersions(response.data);
    if (cursor && cursor.fingerprint !== normalized.fingerprint) throw new YifangyunError("File version history changed after this cursor was issued.", { code: "YFY_CURSOR_STALE", phase: "drive_versions", suggestedAction: "Restart yfy_versions with request.mode=first_request." });
    const versions = normalized.versions.slice(offset, offset + limit).map((version) => {
      if (version.current) {
        return {
          ...version,
          file,
          ref: null,
          usage: {
            for_open_or_capture: "omit_version_parameter" as const,
            note: "Current version: omit the version parameter on yfy_open/yfy_capture."
          }
        };
      }
      return {
        ...version,
        file,
        ref: formatVersionRef(file, version.provider_version_id!),
        usage: {
          for_open_or_capture: "pass_version_ref" as const,
          note: "Historical version: pass this ref as the version parameter on yfy_open/yfy_capture."
        }
      };
    });
    const nextOffset = offset + versions.length;
    const nextCursor = nextOffset < normalized.versions.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_versions", { file, offset: nextOffset, limit, fingerprint: normalized.fingerprint }) : undefined;
    const next = continuationAction("yfy_versions", nextCursor);
    return {
      file,
      versions,
      version_selection_rules: { ...VERSION_SELECTION_RULES },
      fingerprint: normalized.fingerprint,
      page: pageOutput(versions.length, nextCursor),
      ...(next ? { next_action: next } : {}),
      provenance: provenance(response.meta, undefined, "file_versions")
    };
  });

  registerTool(server, "yfy_comments", {
    title: "List Yifangyun File Comments", description: "List comments for one context-bound file ref with stable local pagination.",
    inputSchema: z.object({ request: CommentsRequestSchema }).strict(),
    outputSchema: { file: FileRefSchema, comments: z.array(z.object({ id: z.string().optional(), content: z.string().optional(), created_at: z.string().optional(), author: z.record(z.unknown()).optional() }).strict()), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(CommentsRequestSchema, args.request, "drive_comments");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_comments", request.cursor, CommentsCursorSchema) : undefined;
    const file = cursor?.file ?? (request.mode === "first_request" ? request.file : "");
    const resolved = resolveItemRef(runtime, file, "file");
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_DRIVE_PAGE_SIZE);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(resolved.item.id)}/comments`, resolved.access.context.id, {}, extra.signal);
    const source = objectValue(response.data) ?? {};
    const all = firstArray(source, "comments", "items").flatMap((entry) => {
      const value = objectValue(entry); if (!value) return [];
      return [{ ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}), ...(typeof value.content === "string" ? { content: value.content } : {}), ...(typeof value.created_at === "number" ? { created_at: new Date(value.created_at * 1000).toISOString() } : {}), ...(Object.keys(projectUser(value.user ?? value.creator, false)).length ? { author: projectUser(value.user ?? value.creator, false) } : {}) }];
    });
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(all)).digest("hex");
    if (cursor && cursor.fingerprint !== fingerprint) throw new YifangyunError("File comments changed after this cursor was issued.", { code: "YFY_CURSOR_STALE", phase: "drive_comments", suggestedAction: "Restart yfy_comments with request.mode=first_request." });
    const comments = all.slice(offset, offset + limit);
    const nextOffset = offset + comments.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_comments", { file, offset: nextOffset, limit, fingerprint }) : undefined;
    const next = continuationAction("yfy_comments", nextCursor);
    return { file, comments, page: pageOutput(comments.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "file_comments") };
  });

  registerTool(server, "yfy_shares", {
    title: "List Yifangyun Shares", description: "List redacted share metadata for one context-bound item ref.",
    inputSchema: z.object({ request: SharesRequestSchema }).strict(),
    outputSchema: { item: ItemRefSchema, shares: z.array(z.object({ id: z.string().optional(), access: z.string().optional(), password_protected: z.boolean(), url_present: z.boolean() }).strict()), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(SharesRequestSchema, args.request, "drive_shares");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_shares", request.cursor, SharesCursorSchema) : undefined;
    const itemValue = cursor?.item ?? (request.mode === "first_request" ? request.item : "");
    const resolved = resolveItemRef(runtime, itemValue);
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : DEFAULT_DRIVE_PAGE_SIZE);
    const capacity = Math.min(runtime.config.maxPageCapacity, Math.max(50, limit));
    const response = await runtime.gateway.getUser(`/v2/${resolved.item.type}/${encodeURIComponent(resolved.item.id)}/share_links`, resolved.access.context.id, { page_id: pageId, page_capacity: capacity }, extra.signal);
    const source = objectValue(response.data) ?? {};
    const all = firstArray(source, "share_links", "items").flatMap((entry) => {
      const value = objectValue(entry); if (!value) return [];
      return [{ ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}), ...(typeof value.access === "string" ? { access: value.access } : {}), password_protected: value.password_protected === true || typeof value.password === "string", url_present: typeof value.url === "string" || typeof value.share_link === "string" }];
    });
    const shares = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: capacity, pageId });
    const nextOffset = offset + shares.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_shares", { item: itemValue, page_id: pageId, offset: nextOffset, limit })
      : pageHasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "drive_shares", { item: itemValue, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit }) : undefined;
    const next = continuationAction("yfy_shares", nextCursor);
    return { item: itemValue, shares, page: pageOutput(shares.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "item_shares") };
  });
}
