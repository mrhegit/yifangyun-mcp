import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReadiness } from "../capabilities.js";
import { getConfigSummary } from "../config.js";
import { YifangyunError } from "../client.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { normalizeFileVersions } from "../domain/fileVersions.js";
import { formatItemRef, formatVersionRef, parseItemRef, parsePlaceRef } from "../domain/refs.js";
import { arrayValue, objectValue, projectItem, projectItemPage, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ApiJsonResponse, JsonObject, JsonValue } from "../types.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { registerTool, serializeError } from "./tooling.js";
import { FileRefSchema, FileVersionSchema, ItemRefSchema, ItemSchema, NextActionSchema, PlaceRefSchema, ProvenanceSchema, SimplePageSchema, VersionRefSchema } from "./schemas.js";

type ItemKind = "file" | "folder" | "all";
type Detail = "basic" | "standard" | "full";
type SearchField = "name" | "content" | "creator" | "tag" | "all";

const DriveItemSchema = ItemSchema.extend({ ref: ItemRefSchema });
const PageOutputShape = { page: SimplePageSchema, next_action: NextActionSchema.optional() };

function detailView(detail: Detail): "summary" | "evidence" | "full" {
  return detail === "basic" ? "summary" : detail === "standard" ? "evidence" : "full";
}

function driveItem(value: JsonValue | undefined, detail: Detail = "standard"): JsonObject {
  const item = projectItem(value, detailView(detail));
  if (typeof item.id === "string" && (item.type === "file" || item.type === "folder")) {
    return { ...item, ref: formatItemRef(item.type, item.id) };
  }
  return item;
}

function contextId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredInitialRef(value: unknown, name: string, phase: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new YifangyunError(`${name} is required when cursor is not provided.`, { code: "YFY_INPUT_INVALID", phase });
  }
  return value;
}

function resolvedPlace(runtime: AppRuntime, value: string, accessContext?: string) {
  const place = parsePlaceRef(value);
  if (place.kind === "workspace") {
    const workspace = runtime.access.resolveScope(place.workspaceId);
    if (accessContext && accessContext !== workspace.context.id) {
      throw new YifangyunError("access_context conflicts with the selected workspace.", { code: "YFY_INPUT_INVALID", phase: "place_resolution" });
    }
    return { accessContext: workspace.context.id, folderId: workspace.scope.rootFolderId, place };
  }
  const access = runtime.gateway.context(contextId(accessContext));
  if (place.kind === "folder") return { accessContext: access.context.id, folderId: place.folderId, place };
  if (place.kind === "personal") return { accessContext: access.context.id, departmentId: "0", endpoint: "/v2/folder/personal_items", place };
  if (place.kind === "collaboration") return { accessContext: access.context.id, departmentId: "-1", endpoint: "/v2/folder/collab_folders", place };
  return { accessContext: access.context.id, departmentId: place.departmentId, endpoint: "/v2/folder/department_folders", place };
}

async function placePage(runtime: AppRuntime, at: string, kind: ItemKind, pageId: number, capacity: number, accessContext: string | undefined, signal?: AbortSignal): Promise<ApiJsonResponse> {
  const resolved = resolvedPlace(runtime, at, accessContext);
  if (resolved.folderId) {
    return runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/children`, resolved.accessContext, { type: kind, page_id: pageId, page_capacity: capacity }, signal);
  }
  return runtime.gateway.getUser(resolved.endpoint!, resolved.accessContext, { ...(resolved.place.kind === "department" ? { department_id: resolved.departmentId } : {}), page_id: pageId, page_capacity: capacity }, signal);
}

async function searchPlace(runtime: AppRuntime, at: string, accessContext: string | undefined, signal?: AbortSignal) {
  const resolved = resolvedPlace(runtime, at, accessContext);
  if (!resolved.folderId) return { accessContext: resolved.accessContext, departmentId: resolved.departmentId! };
  const info = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/info`, resolved.accessContext, {}, signal);
  const space = objectValue((objectValue(info.data) ?? {}).space) ?? {};
  const type = typeof space.type === "string" ? space.type.toLowerCase() : undefined;
  const departmentId = type === "personal" ? "0" : type?.includes("collab") ? "-1" : typeof space.id === "string" || typeof space.id === "number" ? String(space.id) : undefined;
  if (!departmentId) throw new YifangyunError("The place storage space could not be resolved for indexed search.", { code: "YFY_ROOT_SPACE_UNKNOWN", phase: "place_resolution" });
  return { accessContext: resolved.accessContext, departmentId, folderId: resolved.folderId };
}

function nextAction(tool: string, cursor?: string): JsonObject | undefined {
  return cursor ? { tool, arguments: { cursor } } : undefined;
}

function pageOutput(returnedCount: number, cursor?: string): JsonObject {
  return { returned_count: returnedCount, has_more: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}) };
}

function pageHasMore(page: JsonObject): boolean {
  return page.has_more === true || typeof page.next_page_id === "number";
}

function searchMatch(source: JsonObject, field: SearchField): JsonObject {
  const score = typeof source.score === "number" ? source.score : typeof source.search_score === "number" ? source.search_score : undefined;
  const snippet = [source.snippet, source.highlight, source.content_highlight].find((value) => typeof value === "string") as string | undefined;
  return {
    basis: "provider_index",
    requested_field: field,
    score_available: score !== undefined,
    snippet_available: snippet !== undefined,
    ...(score !== undefined ? { score } : {}),
    ...(snippet !== undefined ? { snippet } : {})
  };
}

async function findAcrossPages(runtime: AppRuntime, at: string, pathText: string, accessContext: string | undefined, signal?: AbortSignal) {
  const segments = pathText.split("/").map((segment) => segment.trim()).filter(Boolean);
  let currentPlace = at;
  const matched: JsonObject[] = [];
  const observations: JsonObject[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const isLast = segmentIndex === segments.length - 1;
    let found: JsonObject | undefined;
    for (let pageId = 0; pageId < 10000; pageId += 1) {
      const response = await placePage(runtime, currentPlace, isLast ? "all" : "folder", pageId, runtime.config.maxPageCapacity, accessContext, signal);
      const resolved = resolvedPlace(runtime, currentPlace, accessContext);
      observations.push(provenance(response.meta, resolved.accessContext));
      const projected = projectItemPage(response.data, "summary", { pageCapacity: runtime.config.maxPageCapacity, pageId });
      const items = [...(projected.folders as JsonObject[]), ...(projected.files as JsonObject[])];
      found = items.find((entry) => entry.name === segments[segmentIndex] && (isLast || entry.type === "folder"));
      if (found) break;
      if (!pageHasMore(projected.page as JsonObject)) break;
    }
    if (!found) return { resolved: false, missing_segment: segments[segmentIndex], matched_segments: matched, provenance: observations };
    const normalized = { ...found, ref: formatItemRef(found.type as "file" | "folder", String(found.id)) };
    matched.push(normalized);
    if (!isLast) currentPlace = `folder:${String(found.id)}`;
  }
  return { resolved: true, item: matched.at(-1), matched_segments: matched, provenance: observations };
}

export function registerDriveTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_status", {
    title: "Get Yifangyun Drive Status",
    description: "Check the configured drive identity and list copyable places. Ordinary drive tasks can start directly with yfy_browse or yfy_search.",
    inputSchema: {},
    outputSchema: {
      connected: z.literal(true),
      server: z.object({ name: z.string(), version: z.string(), instance_id: z.string(), started_at: z.string() }),
      identity: z.object({ access_context: z.string(), user: z.record(z.unknown()) }),
      places: z.array(z.object({ ref: PlaceRefSchema, kind: z.string(), name: z.string().optional(), tags: z.array(z.string()).optional() })),
      capabilities: z.array(z.string()),
      profiles: z.array(z.record(z.unknown())),
      runtime: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
      provenance: z.array(ProvenanceSchema)
    }
  }, { readOnly: true, openWorld: false }, async (_args, extra) => {
    const access = runtime.gateway.context();
    await runtime.client.getEnterpriseToken(extra.signal);
    await runtime.client.getUserToken(access.context.userId, extra.signal);
    const user = await runtime.gateway.getUser("/v2/user/info", access.context.id, {}, extra.signal);
    return {
      connected: true,
      server: { name: SERVER_NAME, version: SERVER_VERSION, instance_id: runtime.instanceId, started_at: runtime.startedAtIso },
      identity: { access_context: access.context.id, user: projectUser(user.data, false) },
      places: [
        { ref: "personal", kind: "personal", name: "Personal drive" },
        { ref: "collaboration", kind: "collaboration", name: "Collaboration" },
        ...runtime.access.listScopes().map((workspace) => ({ ref: `workspace:${workspace.id}`, kind: "workspace", name: workspace.id, tags: workspace.tags }))
      ],
      capabilities: runtime.config.toolsets,
      profiles: profileReadiness(runtime.config),
      runtime: getConfigSummary(runtime.config),
      provenance: [provenance(user.meta, access.context.id)]
    };
  });

  registerTool(server, "yfy_browse", {
    title: "Browse Yifangyun Drive",
    description: "List one drive place. First call with at/kind/limit; continue by calling this tool with only the returned cursor.",
    inputSchema: {
      at: PlaceRefSchema.default("personal"),
      kind: z.enum(["file", "folder", "all"]).default("all"),
      detail: z.enum(["basic", "standard", "full"]).default("standard"),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().optional(),
      access_context: z.string().trim().min(1).optional()
    },
    outputSchema: { items: z.array(DriveItemSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "drive_browse", args.cursor) : undefined;
    const at = cursor ? String(cursor.at) : String(args.at ?? "personal");
    const kind = (cursor ? String(cursor.kind) : String(args.kind ?? "all")) as ItemKind;
    const detail = (cursor ? String(cursor.detail) : String(args.detail ?? "standard")) as Detail;
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : contextId(args.access_context);
    const capacity = Math.min(runtime.config.maxPageCapacity, Math.max(50, limit));
    const response = await placePage(runtime, at, kind, pageId, capacity, accessContext, extra.signal);
    const projected = projectItemPage(response.data, detailView(detail), { pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
    const allItems = [...(projected.folders as JsonObject[]), ...(projected.files as JsonObject[])].map((item) => ({ ...item, ref: formatItemRef(item.type as "file" | "folder", String(item.id)) }));
    const items = allItems.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const providerPage = projected.page as JsonObject;
    const nextCursor = nextOffset < allItems.length
      ? encodeCursor(runtime.config.clientSecret, "drive_browse", { at, kind, detail, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) })
      : pageHasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "drive_browse", { at, kind, detail, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit, ...(accessContext ? { access_context: accessContext } : {}) })
        : undefined;
    const resolved = resolvedPlace(runtime, at, accessContext);
    return { items, page: pageOutput(items.length, nextCursor), ...(nextAction("yfy_browse", nextCursor) ? { next_action: nextAction("yfy_browse", nextCursor)! } : {}), provenance: provenance(response.meta, resolved.accessContext) };
  });

  registerTool(server, "yfy_search", {
    title: "Search Yifangyun Drive",
    description: "Search the Provider index for candidates. Results are never exhaustive proof. Continue with only the returned cursor.",
    inputSchema: {
      query: z.string().trim().min(1).max(200).optional(),
      in: PlaceRefSchema.default("personal"),
      kind: z.enum(["file", "folder", "all"]).default("all"),
      field: z.enum(["name", "content", "creator", "tag", "all"]).default("all"),
      exact_name: z.boolean().default(false),
      sort: z.enum(["name", "date", "size", "score"]).default("score"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().optional(),
      access_context: z.string().trim().min(1).optional()
    },
    outputSchema: {
      hits: z.array(z.object({ item: DriveItemSchema, match: z.record(z.unknown()), verification: z.record(z.unknown()) })),
      coverage: z.object({ mode: z.literal("provider_index"), exhaustive: z.literal(false) }),
      ...PageOutputShape,
      provenance: ProvenanceSchema
    }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "drive_search", args.cursor) : undefined;
    const query = cursor ? String(cursor.query) : typeof args.query === "string" ? args.query : "";
    if (!query) throw new YifangyunError("query is required when cursor is not provided.", { code: "YFY_INPUT_INVALID", phase: "drive_search" });
    const at = cursor ? String(cursor.at) : String(args.in ?? "personal");
    const kind = (cursor ? String(cursor.kind) : String(args.kind ?? "all")) as ItemKind;
    const field = (cursor ? String(cursor.field) : String(args.field ?? "all")) as SearchField;
    const exactName = cursor ? cursor.exact_name === true : args.exact_name === true;
    const sort = cursor ? String(cursor.sort) : String(args.sort ?? "score");
    const direction = cursor ? String(cursor.direction) : String(args.direction ?? "desc");
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : contextId(args.access_context);
    const root = await searchPlace(runtime, at, accessContext, extra.signal);
    const response = await runtime.gateway.getUser("/v2/item/search", root.accessContext, {
      query_words: query,
      type: kind,
      query_filter: field === "name" ? "file_name" : field,
      department_id: root.departmentId,
      search_in_folder: root.folderId,
      precise_search: exactName,
      sort_by: sort,
      sort_direction: direction,
      page_id: pageId,
      page_capacity: Math.min(runtime.config.maxPageCapacity, Math.max(50, limit))
    }, extra.signal);
    const source = objectValue(response.data) ?? {};
    const rawItems = [...arrayValue(source.files), ...arrayValue(source.folders)];
    const eligible = rawItems.flatMap((entry) => {
      const raw = objectValue(entry) ?? {};
      const item = driveItem(entry, "standard");
      if (typeof item.id !== "string" || typeof item.name !== "string" || (item.type !== "file" && item.type !== "folder")) return [];
      if (root.folderId) {
        const ancestors = Array.isArray(item.ancestor_folder_ids) ? item.ancestor_folder_ids : [];
        if (item.parent_folder_id !== root.folderId && !ancestors.includes(root.folderId)) return [];
      }
      if (exactName && field === "name" && item.name !== query) return [];
      return [{ item, match: searchMatch(raw, field), verification: { place: root.folderId ? "verified" : "not_requested", exact_name: exactName && field === "name" ? "verified" : "not_requested" } }];
    });
    const hits = eligible.slice(offset, offset + limit);
    const nextOffset = offset + hits.length;
    const providerPage = projectPage(response.data, { itemCount: rawItems.length, providerCount: rawItems.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const payload = { query, at, kind, field, exact_name: exactName, sort, direction, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < eligible.length
      ? encodeCursor(runtime.config.clientSecret, "drive_search", payload)
      : pageHasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "drive_search", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 })
        : undefined;
    return { hits, coverage: { mode: "provider_index", exhaustive: false }, page: pageOutput(hits.length, nextCursor), ...(nextAction("yfy_search", nextCursor) ? { next_action: nextAction("yfy_search", nextCursor)! } : {}), provenance: provenance(response.meta, root.accessContext) };
  });

  registerTool(server, "yfy_resolve", {
    title: "Resolve Yifangyun Path",
    description: "Resolve an exact relative path from one drive place. Use search only when the path is unknown.",
    inputSchema: { path: z.string().trim().min(1), from: PlaceRefSchema.default("personal"), access_context: z.string().trim().min(1).optional() },
    outputSchema: { resolved: z.boolean(), item: DriveItemSchema.optional(), missing_segment: z.string().optional(), matched_segments: z.array(DriveItemSchema), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ path, from, access_context }, extra) => findAcrossPages(runtime, String(from ?? "personal"), String(path), contextId(access_context), extra.signal));

  registerTool(server, "yfy_get", {
    title: "Get Yifangyun Item",
    description: "Get current metadata for one file or folder ref. Use yfy_versions for historical metadata.",
    inputSchema: { ref: ItemRefSchema, detail: z.enum(["basic", "standard", "full"]).default("standard"), access_context: z.string().trim().min(1).optional() },
    outputSchema: { item: DriveItemSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ ref, detail, access_context }, extra) => {
    const itemRef = parseItemRef(String(ref));
    const access = runtime.gateway.context(contextId(access_context));
    const endpoint = itemRef.type === "file" ? `/v2/file/${encodeURIComponent(itemRef.id)}/info_v2` : `/v2/folder/${encodeURIComponent(itemRef.id)}/info`;
    const response = await runtime.gateway.getUser(endpoint, access.context.id, {}, extra.signal);
    return { item: driveItem(response.data, detail as Detail), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_get_many", {
    title: "Get Multiple Yifangyun Items",
    description: "Get current metadata for up to 100 item refs while preserving partial successes.",
    inputSchema: { refs: z.array(ItemRefSchema).min(1).max(100), detail: z.enum(["basic", "standard", "full"]).default("standard"), access_context: z.string().trim().min(1).optional() },
    outputSchema: {
      results: z.array(z.discriminatedUnion("status", [
        z.object({ index: z.number().int().nonnegative(), ref: ItemRefSchema, status: z.literal("success"), item: DriveItemSchema, provenance: ProvenanceSchema }),
        z.object({ index: z.number().int().nonnegative(), ref: ItemRefSchema, status: z.literal("error"), error: z.record(z.unknown()) })
      ])),
      summary: z.object({ requested_count: z.number().int().nonnegative(), success_count: z.number().int().nonnegative(), error_count: z.number().int().nonnegative() })
    }
  }, { readOnly: true }, async ({ refs, detail, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const results = await Promise.all((refs as string[]).map(async (ref, index) => {
      try {
        const itemRef = parseItemRef(ref);
        const endpoint = itemRef.type === "file" ? `/v2/file/${encodeURIComponent(itemRef.id)}/info_v2` : `/v2/folder/${encodeURIComponent(itemRef.id)}/info`;
        const response = await runtime.gateway.getUser(endpoint, access.context.id, {}, extra.signal);
        return { index, ref, status: "success" as const, item: driveItem(response.data, detail as Detail), provenance: provenance(response.meta, access.context.id) };
      } catch (error) {
        return { index, ref, status: "error" as const, error: serializeError(error) };
      }
    }));
    const successCount = results.filter((result) => result.status === "success").length;
    return { results, summary: { requested_count: results.length, success_count: successCount, error_count: results.length - successCount } };
  });

  registerTool(server, "yfy_versions", {
    title: "List Yifangyun File Versions",
    description: "List stable version refs for one file. Copy a historical ref into yfy_open or yfy_capture.",
    inputSchema: { file: FileRefSchema.optional(), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { file: FileRefSchema, versions: z.array(FileVersionSchema.extend({ ref: VersionRefSchema.optional(), file: FileRefSchema })), fingerprint: z.string(), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "drive_versions", args.cursor) : undefined;
    const file = cursor ? String(cursor.file) : requiredInitialRef(args.file, "file", "drive_versions");
    const item = parseItemRef(file);
    if (item.type !== "file") throw new YifangyunError("yfy_versions requires a file ref.", { code: "YFY_INPUT_INVALID", phase: "drive_versions" });
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : contextId(args.access_context);
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, access.context.id, {}, extra.signal);
    const normalized = normalizeFileVersions(response.data);
    if (cursor && cursor.fingerprint !== normalized.fingerprint) {
      throw new YifangyunError("File version history changed after this cursor was issued.", { code: "YFY_CURSOR_STALE", phase: "drive_versions", suggestedAction: "Restart yfy_versions without cursor." });
    }
    const versions = normalized.versions.slice(offset, offset + limit).map((version) => ({
      ...version,
      file,
      ...(!version.current ? { ref: formatVersionRef(item.id, version.provider_version_id!) } : {})
    }));
    const nextOffset = offset + versions.length;
    const nextCursor = nextOffset < normalized.versions.length ? encodeCursor(runtime.config.clientSecret, "drive_versions", { file, offset: nextOffset, limit, fingerprint: normalized.fingerprint, ...(accessContext ? { access_context: accessContext } : {}) }) : undefined;
    return { file, versions, fingerprint: normalized.fingerprint, page: pageOutput(versions.length, nextCursor), ...(nextAction("yfy_versions", nextCursor) ? { next_action: nextAction("yfy_versions", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_comments", {
    title: "List Yifangyun File Comments",
    description: "List comments for one file ref with bounded local pagination.",
    inputSchema: { file: FileRefSchema.optional(), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { comments: z.array(z.record(z.unknown())), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "drive_comments", args.cursor) : undefined;
    const file = cursor ? String(cursor.file) : requiredInitialRef(args.file, "file", "drive_comments");
    const item = parseItemRef(file);
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : contextId(args.access_context);
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/comments`, access.context.id, {}, extra.signal);
    const source = objectValue(response.data) ?? {};
    const all = [...arrayValue(source.comments), ...arrayValue(source.items)].flatMap((entry) => {
      const value = objectValue(entry);
      if (!value) return [];
      return [{
        ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}),
        ...(typeof value.content === "string" ? { content: value.content } : {}),
        ...(typeof value.created_at === "number" ? { created_at: new Date(value.created_at * 1000).toISOString() } : {}),
        ...(Object.keys(projectUser(value.user ?? value.creator, false)).length ? { author: projectUser(value.user ?? value.creator, false) } : {})
      }];
    });
    const comments = all.slice(offset, offset + limit);
    const nextOffset = offset + comments.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, "drive_comments", { file, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) }) : undefined;
    return { comments, page: pageOutput(comments.length, nextCursor), ...(nextAction("yfy_comments", nextCursor) ? { next_action: nextAction("yfy_comments", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_shares", {
    title: "List Yifangyun Shares",
    description: "List redacted share metadata for one item ref. URLs and passwords are never returned.",
    inputSchema: { item: ItemRefSchema.optional(), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { shares: z.array(z.record(z.unknown())), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "drive_shares", args.cursor) : undefined;
    const itemValue = cursor ? String(cursor.item) : requiredInitialRef(args.item, "item", "drive_shares");
    const item = parseItemRef(itemValue);
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : contextId(args.access_context);
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser(`/v2/${item.type}/${encodeURIComponent(item.id)}/share_links`, access.context.id, { page_id: pageId, page_capacity: Math.min(runtime.config.maxPageCapacity, Math.max(50, limit)) }, extra.signal);
    const source = objectValue(response.data) ?? {};
    const all = [...arrayValue(source.share_links), ...arrayValue(source.items)].flatMap((entry) => {
      const value = objectValue(entry);
      if (!value) return [];
      return [{
        ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}),
        ...(typeof value.access === "string" ? { access: value.access } : {}),
        password_protected: value.password_protected === true || typeof value.password === "string",
        url_present: typeof value.url === "string" || typeof value.share_link === "string"
      }];
    });
    const shares = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + shares.length;
    const nextCursor = nextOffset < all.length
      ? encodeCursor(runtime.config.clientSecret, "drive_shares", { item: itemValue, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) })
      : pageHasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "drive_shares", { item: itemValue, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit, ...(accessContext ? { access_context: accessContext } : {}) })
        : undefined;
    return { shares, page: pageOutput(shares.length, nextCursor), ...(nextAction("yfy_shares", nextCursor) ? { next_action: nextAction("yfy_shares", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });
}
