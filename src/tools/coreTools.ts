import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReadiness } from "../capabilities.js";
import { getConfigSummary } from "../config.js";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions } from "../domain/fileVersions.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectItem, projectItemPage, projectPage, projectPath, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ApiJsonResponse, JsonObject, JsonValue } from "../types.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import { registerTool, serializeError } from "./tooling.js";
import { CandidateSchema, DepartmentSchema, DomainErrorSchema, FileVersionSchema, GroupSchema, ItemSchema, PageInputShape, PageSchema, ProvenanceSchema, RootRefSchema, UserSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const AccessContextSchema = z.string().trim().min(1).optional();
const ViewSchema = z.enum(["summary", "evidence", "full"]);
type RootRef = z.infer<typeof RootRefSchema>;

function contextId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pageCapacity(runtime: AppRuntime, value: unknown): number {
  return Math.min(typeof value === "number" ? value : 50, runtime.config.maxPageCapacity);
}

function resolvedRoot(runtime: AppRuntime, root: RootRef, accessContext?: string): { accessContext: string; departmentId?: string; endpoint?: string; folderId?: string; kind: RootRef["kind"] } {
  if (root.kind === "scope") {
    const scope = runtime.access.resolveScope(root.scope_id);
    if (accessContext && accessContext !== scope.context.id) throw new YifangyunError("access_context conflicts with the selected scope.", { code: "YFY_INPUT_INVALID", phase: "root_resolution" });
    return { kind: root.kind, accessContext: scope.context.id, folderId: scope.scope.rootFolderId };
  }
  const access = runtime.gateway.context(contextId(accessContext));
  if (root.kind === "folder") return { kind: root.kind, accessContext: access.context.id, folderId: root.folder_id };
  if (root.kind === "personal") return { kind: root.kind, accessContext: access.context.id, departmentId: "0", endpoint: "/v2/folder/personal_items" };
  if (root.kind === "collaboration") return { kind: root.kind, accessContext: access.context.id, departmentId: "-1", endpoint: "/v2/folder/collab_folders" };
  return { kind: root.kind, accessContext: access.context.id, departmentId: root.department_id, endpoint: "/v2/folder/department_folders" };
}

async function rootPage(runtime: AppRuntime, root: RootRef, accessContext: string | undefined, pageId: number, capacity: number, signal?: AbortSignal): Promise<ApiJsonResponse> {
  const resolved = resolvedRoot(runtime, root, accessContext);
  if (resolved.folderId) return runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/children`, resolved.accessContext, { type: "all", page_id: pageId, page_capacity: capacity }, signal);
  return runtime.gateway.getUser(resolved.endpoint!, resolved.accessContext, { ...(root.kind === "department" ? { department_id: resolved.departmentId } : {}), page_id: pageId, page_capacity: capacity }, signal);
}

async function searchRoot(runtime: AppRuntime, root: RootRef, accessContext: string | undefined, signal?: AbortSignal): Promise<{ accessContext: string; departmentId: string; folderId?: string }> {
  const resolved = resolvedRoot(runtime, root, accessContext);
  if (!resolved.folderId) return { accessContext: resolved.accessContext, departmentId: resolved.departmentId! };
  const info = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/info`, resolved.accessContext, {}, signal);
  const space = objectValue((objectValue(info.data) ?? {}).space) ?? {};
  const type = typeof space.type === "string" ? space.type.toLowerCase() : undefined;
  const departmentId = type === "personal" ? "0" : type?.includes("collab") ? "-1" : typeof space.id === "string" || typeof space.id === "number" ? String(space.id) : undefined;
  if (!departmentId) throw new YifangyunError("Folder storage space could not be resolved for indexed search.", { code: "YFY_ROOT_SPACE_UNKNOWN", phase: "root_resolution" });
  return { accessContext: resolved.accessContext, departmentId, folderId: resolved.folderId };
}

function projectUsers(value: JsonValue | undefined, includeContact: boolean): JsonObject[] {
  const source = objectValue(value) ?? {};
  const candidates = [...arrayValue(source.users), ...arrayValue(source.members), ...arrayValue(source.items)];
  return candidates.map((entry) => projectUser(entry, includeContact)).filter((entry) => Object.keys(entry).length > 0);
}

function projectDepartments(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return [...arrayValue(source.departments), ...arrayValue(source.children), ...arrayValue(source.items)]
    .map(projectDepartment)
    .filter((entry) => Object.keys(entry).length > 0);
}

function projectGroups(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return [...arrayValue(source.groups), ...arrayValue(source.items)]
    .map(projectGroup)
    .filter((entry) => Object.keys(entry).length > 0);
}

async function findAcrossPages(
  fetchPage: (pageId: number) => Promise<ApiJsonResponse>,
  name: string,
  requireFolder: boolean,
  runtime: AppRuntime
): Promise<{ item?: JsonObject; provenance: JsonObject[] }> {
  const observations: JsonObject[] = [];
  let pageId = 0;
  for (let pages = 0; pages < 10000; pages += 1) {
    const response = await fetchPage(pageId);
    observations.push(provenance(response.meta));
    const projected = projectItemPage(response.data, "summary", { pageCapacity: runtime.config.maxPageCapacity, pageId });
    const items = [...(projected.folders as JsonObject[]), ...(projected.files as JsonObject[])];
    const item = items.find((entry) => entry.name === name && (!requireFolder || entry.type === "folder"));
    if (item) return { item, provenance: observations };
    const page = projected.page as JsonObject;
    const hasMore = page.has_more === true
      || (typeof page.page_count === "number" && pageId + 1 < page.page_count)
      || (typeof page.total_count === "number" && (pageId + 1) * runtime.config.maxPageCapacity < page.total_count);
    if (!hasMore) {
      return { provenance: observations };
    }
    pageId += 1;
  }
  throw new YifangyunError("Path resolution exceeded the pagination safety limit.", { code: "YFY_PAGINATION_LIMIT_REACHED", phase: "path_resolution" });
}

export function registerCoreTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_connection_check", {
    title: "Check Yifangyun Connection",
    description: "Validate enterprise and configured user authentication without returning token material.",
    inputSchema: { access_context: AccessContextSchema },
    outputSchema: { authenticated: z.boolean(), access_context: z.string(), user: UserSchema, enterprise_root_department: DepartmentSchema, provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    await runtime.client.getEnterpriseToken(extra.signal);
    await runtime.client.getUserToken(access.context.userId, extra.signal);
    const [department, user] = await Promise.all([
      runtime.gateway.getEnterprise("/v2/admin/department/0/info", {}, extra.signal),
      runtime.gateway.getUser("/v2/user/info", access.context.id, {}, extra.signal)
    ]);
    return {
      authenticated: true,
      access_context: access.context.id,
      user: projectUser(user.data, false),
      enterprise_root_department: projectDepartment(department.data),
      provenance: [provenance(department.meta), provenance(user.meta, access.context.id)]
    };
  });

  registerTool(server, "yfy_context_get", {
    title: "Get Yifangyun Runtime Context",
    description: "List configured access contexts, authority scopes, enabled toolsets and workflow profiles without exposing credentials.",
    inputSchema: {},
    outputSchema: {
      access_contexts: z.array(z.object({ id: z.string(), default: z.boolean() })),
      authority_scopes: z.array(z.object({ id: z.string(), root_folder_id: z.string(), access_context: z.string(), tags: z.array(z.string()) })),
      server: z.object({ name: z.string(), version: z.string(), instance_id: z.string(), started_at: z.string(), config_fingerprint: z.string() }),
      profile_readiness: z.array(z.object({ profile: z.string(), ready: z.boolean(), missing_toolsets: z.array(z.string()), missing_configuration: z.array(z.string()) })),
      runtime: z.record(z.unknown()),
      toolsets: z.array(z.string()),
      workflow_profiles: z.array(z.string())
    }
  }, { readOnly: true, openWorld: false }, async () => ({
    access_contexts: runtime.access.listContexts().map((context) => ({ id: context.id, default: context.id === runtime.config.defaultAccessContext })),
    authority_scopes: runtime.access.listScopes().map((scope) => ({ id: scope.id, root_folder_id: scope.rootFolderId, access_context: scope.accessContext, tags: scope.tags })),
    server: { name: SERVER_NAME, version: SERVER_VERSION, instance_id: runtime.instanceId, started_at: runtime.startedAtIso, config_fingerprint: runtime.configFingerprint },
    profile_readiness: profileReadiness(runtime.config),
    toolsets: runtime.config.toolsets,
    workflow_profiles: runtime.config.workflowProfiles,
    runtime: getConfigSummary(runtime.config)
  }));

  registerTool(server, "yfy_item_get", {
    title: "Get Yifangyun Item",
    description: "Get stable file or folder metadata. Use evidence view for ancestry, sha1 and version fields.",
    inputSchema: {
      item_type: z.enum(["file", "folder"]),
      item_id: IdSchema,
      version_id: IdSchema.optional(),
      view: ViewSchema.default("summary"),
      access_context: AccessContextSchema
    },
    outputSchema: { item: ItemSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ item_type, item_id, version_id, view, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    if (item_type === "folder" && version_id) {
      throw new YifangyunError("version_id is valid only for files.", { code: "YFY_INPUT_INVALID", phase: "item_get" });
    }
    const endpoint = item_type === "file"
      ? version_id ? `/v2/file/${encodeURIComponent(String(item_id))}/version/${encodeURIComponent(String(version_id))}/info` : `/v2/file/${encodeURIComponent(String(item_id))}/info_v2`
      : `/v2/folder/${encodeURIComponent(String(item_id))}/info`;
    const response = await runtime.gateway.getUser(endpoint, access.context.id, item_type === "file" && access.context.externalEnterpriseId
      ? { external_enterprise_id: access.context.externalEnterpriseId }
      : {}, extra.signal);
    return { item: projectItem(response.data, view as "summary" | "evidence" | "full"), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_items_get", {
    title: "Get Multiple Yifangyun Files",
    description: "Fetch stable metadata for up to 100 files with Provider concurrency controls.",
    inputSchema: { file_ids: z.array(IdSchema).min(1).max(100), view: ViewSchema.default("summary"), access_context: AccessContextSchema },
    outputSchema: {
      results: z.array(z.discriminatedUnion("status", [
        z.object({ index: z.number().int().min(0), file_id: z.string(), status: z.literal("success"), file: ItemSchema, provenance: ProvenanceSchema }),
        z.object({ index: z.number().int().min(0), file_id: z.string(), status: z.literal("error"), error: DomainErrorSchema })
      ])),
      summary: z.object({ requested_count: z.number().int().min(0), success_count: z.number().int().min(0), error_count: z.number().int().min(0) })
    }
  }, { readOnly: true }, async ({ file_ids, view, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const results = await Promise.all((file_ids as string[]).map(async (fileId, index) => {
      try {
        const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/info_v2`, access.context.id, access.context.externalEnterpriseId
          ? { external_enterprise_id: access.context.externalEnterpriseId }
          : {}, extra.signal);
        return { index, file_id: fileId, status: "success" as const, file: projectItem(response.data, view as "summary" | "evidence" | "full"), provenance: provenance(response.meta, access.context.id) };
      } catch (error) {
        if (error instanceof YifangyunError && error.code.includes("CANCEL")) throw error;
        return { index, file_id: fileId, status: "error" as const, error: serializeError(error) };
      }
    }));
    const successCount = results.filter((result) => result.status === "success").length;
    return { results, summary: { requested_count: results.length, success_count: successCount, error_count: results.length - successCount } };
  });

  registerTool(server, "yfy_folder_list", {
    title: "List Yifangyun Folder",
    description: "List one page of direct folder children. This tool never recurses.",
    inputSchema: {
      folder_id: IdSchema,
      item_type: z.enum(["file", "folder", "all"]).default("all"),
      view: ViewSchema.default("summary"),
      access_context: AccessContextSchema,
      ...PageInputShape
    },
    outputSchema: { files: z.array(ItemSchema), folders: z.array(ItemSchema), page: PageSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ folder_id, item_type, view, access_context, page_id, page_capacity }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(String(folder_id))}/children`, access.context.id, {
      type: String(item_type),
      page_id: Number(page_id),
      page_capacity: capacity
    }, extra.signal);
    return { ...projectItemPage(response.data, view as "summary" | "evidence" | "full", { pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_root_list", {
    title: "List Yifangyun Root",
    description: "List a personal, collaboration, department, folder or configured scope root without Provider magic ids.",
    inputSchema: { root: RootRefSchema.default({ kind: "personal" }), view: ViewSchema.default("summary"), access_context: AccessContextSchema, ...PageInputShape },
    outputSchema: { files: z.array(ItemSchema), folders: z.array(ItemSchema), page: PageSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ root, view, access_context, page_id, page_capacity }, extra) => {
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await rootPage(runtime, root as RootRef, contextId(access_context), Number(page_id), capacity, extra.signal);
    const resolved = resolvedRoot(runtime, root as RootRef, contextId(access_context));
    return { ...projectItemPage(response.data, view as "summary" | "evidence" | "full", { pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta, resolved.accessContext) };
  });

  registerTool(server, "yfy_item_search", {
    title: "Search Yifangyun Items",
    description: "Search the official Yifangyun index for candidate discovery. Empty results cannot prove absence.",
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      item_type: z.enum(["file", "folder", "all"]).default("all"),
      field: z.enum(["file_name", "content", "creator", "tag", "all"]).default("all"),
      root: RootRefSchema.default({ kind: "personal" }),
      precise: z.boolean().default(false),
      sort: z.enum(["name", "date", "size", "score"]).default("score"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      access_context: AccessContextSchema,
      ...PageInputShape
    },
    outputSchema: { candidates: z.array(CandidateSchema), page: PageSchema, authority: z.object({ level: z.literal("hint_only"), safe_to_claim_absence: z.literal(false) }), provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const root = await searchRoot(runtime, args.root as RootRef, contextId(args.access_context), extra.signal);
    const capacity = pageCapacity(runtime, args.page_capacity);
    const response = await runtime.gateway.getUser("/v2/item/search", root.accessContext, {
      query_words: String(args.query),
      type: String(args.item_type),
      query_filter: String(args.field),
      department_id: root.departmentId,
      search_in_folder: root.folderId,
      precise_search: args.precise === true,
      sort_by: String(args.sort),
      sort_direction: String(args.direction),
      page_id: Number(args.page_id),
      page_capacity: capacity
    }, extra.signal);
    const folderId = root.folderId;
    const exactFileName = args.precise === true && args.field === "file_name" ? String(args.query) : undefined;
    const source = objectValue(response.data) ?? {};
    const rawItems = [...arrayValue(source.files), ...arrayValue(source.folders)];
    let filteredCount = 0;
    let invalidCount = 0;
    const candidates = rawItems.flatMap((entry) => {
      const item = projectItem(entry, "evidence");
      if (folderId) {
        const ancestors = Array.isArray(item.ancestor_folder_ids) ? item.ancestor_folder_ids : [];
        if (item.parent_folder_id !== folderId && !ancestors.includes(folderId)) { filteredCount += 1; return []; }
      }
      if (exactFileName !== undefined && item.name !== exactFileName) { filteredCount += 1; return []; }
      if (typeof item.id !== "string" || typeof item.name !== "string" || (item.type !== "file" && item.type !== "folder")) { invalidCount += 1; return []; }
      const chain = Array.isArray(item.path_chain) ? item.path_chain.flatMap((part) => typeof part === "object" && part !== null && !Array.isArray(part) && typeof part.name === "string" ? [part.name] : []) : [];
      return [{ item: { id: item.id, name: item.name, type: item.type, ...(typeof item.parent_folder_id === "string" ? { parent_folder_id: item.parent_folder_id } : {}), ...(chain.length > 0 ? { path: chain.join("/") } : {}) }, verification: { folder_scope: folderId ? "verified" : "not_requested", exact_name: exactFileName ? "verified" : "not_requested" } }];
    });
    return {
      candidates,
      page: projectPage(response.data, { itemCount: candidates.length, providerCount: rawItems.length, filteredCount, invalidCount, pageCapacity: capacity, requestedPageCapacity: Number(args.page_capacity), pageId: Number(args.page_id) }),
      authority: { level: "hint_only", safe_to_claim_absence: false },
      provenance: provenance(response.meta, root.accessContext)
    };
  });

  registerTool(server, "yfy_path_resolve", {
    title: "Resolve Yifangyun Path",
    description: "Resolve an exact relative path by walking paginated folder listings.",
    inputSchema: {
      path: z.string().trim().min(1),
      root: RootRefSchema.default({ kind: "personal" }),
      access_context: AccessContextSchema
    },
    outputSchema: { resolved: z.boolean(), item: ItemSchema.optional(), missing_segment: z.string().optional(), matched_segments: z.array(ItemSchema), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ path: pathText, root, access_context }, extra) => {
    const selectedRoot = root as RootRef;
    const resolved = resolvedRoot(runtime, selectedRoot, contextId(access_context));
    const segments = String(pathText).split("/").map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      if (resolved.folderId) {
        const response = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.folderId)}/info`, resolved.accessContext, {}, extra.signal);
        return { resolved: true, item: projectItem(response.data, "evidence"), matched_segments: [], provenance: [provenance(response.meta, resolved.accessContext)] };
      }
      return { resolved: true, item: { id: `${selectedRoot.kind}:${resolved.departmentId ?? "root"}`, name: selectedRoot.kind, type: "folder" }, matched_segments: [], provenance: [] };
    }
    let folderId = resolved.folderId;
    const matched: JsonObject[] = [];
    const observations: JsonObject[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const isLast = index === segments.length - 1;
      const result = await findAcrossPages((pageId) => folderId
        ? runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(folderId)}/children`, resolved.accessContext, { type: isLast ? "all" : "folder", page_id: pageId, page_capacity: runtime.config.maxPageCapacity }, extra.signal)
        : rootPage(runtime, selectedRoot, resolved.accessContext, pageId, runtime.config.maxPageCapacity, extra.signal), segments[index]!, !isLast, runtime);
      observations.push(...result.provenance);
      const match = result.item;
      if (!match) {
        return { resolved: false, missing_segment: segments[index], matched_segments: matched, provenance: observations };
      }
      matched.push(match);
      if (!isLast) {
        if (typeof match.id !== "string") {
          throw new YifangyunError("Matched folder has no stable id.", { code: "YFY_INVALID_FOLDER_ID", phase: "path_resolution" });
        }
        folderId = match.id;
      }
    }
    return { resolved: true, item: matched.at(-1) ?? {}, matched_segments: matched, provenance: observations };
  });

  registerTool(server, "yfy_file_versions", {
    title: "List Yifangyun File Versions",
    description: "List known versions for a file using stable version metadata.",
    inputSchema: { file_id: IdSchema, access_context: AccessContextSchema },
    outputSchema: { versions: z.array(FileVersionSchema), fingerprint: z.string(), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ file_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/versions`, access.context.id, {}, extra.signal);
    const normalized = normalizeFileVersions(response.data);
    return { ...normalized, provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_file_comments", {
    title: "List Yifangyun File Comments",
    description: "List comments for a file without returning raw Provider payloads.",
    inputSchema: { file_id: IdSchema, access_context: AccessContextSchema },
    outputSchema: { comments: z.array(z.object({ id: z.string().optional(), content: z.string().optional(), created_at_unix: z.number().optional(), created_at_iso: z.string().optional(), author: UserSchema.optional() })), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ file_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/comments`, access.context.id, {}, extra.signal);
    const source = objectValue(response.data) ?? {};
    const comments = [...arrayValue(source.comments), ...arrayValue(source.items)].flatMap((entry) => {
      const value = objectValue(entry);
      if (!value) return [];
      return [{
        ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}),
        ...(typeof value.content === "string" ? { content: value.content } : {}),
        ...(typeof value.created_at === "number" ? { created_at_unix: value.created_at, created_at_iso: new Date(value.created_at * 1000).toISOString() } : {}),
        ...(Object.keys(projectUser(value.user ?? value.creator, false)).length ? { author: projectUser(value.user ?? value.creator, false) } : {})
      }];
    });
    return { comments, provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_share_list", {
    title: "List Yifangyun Shares",
    description: "List share metadata for a file or folder. Direct URLs and passwords are always redacted.",
    inputSchema: { item_type: z.enum(["file", "folder"]), item_id: IdSchema, access_context: AccessContextSchema, ...PageInputShape },
    outputSchema: { shares: z.array(z.object({ id: z.string().optional(), access: z.string().optional(), password_protected: z.boolean(), url_present: z.boolean() })), page: PageSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ item_type, item_id, page_id, page_capacity, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getUser(`/v2/${String(item_type)}/${encodeURIComponent(String(item_id))}/share_links`, access.context.id, { page_id: Number(page_id), page_capacity: capacity }, extra.signal);
    const source = objectValue(response.data) ?? {};
    const shares = [...arrayValue(source.share_links), ...arrayValue(source.items)].flatMap((entry) => {
      const value = objectValue(entry);
      if (!value) return [];
      return [{
        ...(typeof value.id === "string" || typeof value.id === "number" ? { id: String(value.id) } : {}),
        ...(typeof value.access === "string" ? { access: value.access } : {}),
        password_protected: value.password_protected === true || typeof value.password === "string",
        url_present: typeof value.url === "string" || typeof value.share_link === "string"
      }];
    });
    return { shares, page: projectPage(response.data, { itemCount: shares.length, pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });
}

export function registerOrganizationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_department_read", {
    title: "Read Yifangyun Departments",
    description: "Get one department, list child departments, or list department users.",
    inputSchema: {
      action: z.enum(["get", "children", "users"]),
      department_id: IdSchema.default("0"),
      include_contact: z.boolean().default(false),
      ...PageInputShape
    },
    outputSchema: { department: DepartmentSchema.optional(), departments: z.array(DepartmentSchema).optional(), users: z.array(UserSchema).optional(), page: PageSchema.optional(), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ action, department_id, include_contact, page_id, page_capacity }, extra) => {
    if (action === "get") {
      const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(String(department_id))}/info`, {}, extra.signal);
      return { department: projectDepartment(response.data), provenance: provenance(response.meta) };
    }
    if (action === "children") {
      const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(String(department_id))}/children`, {}, extra.signal);
      return { departments: projectDepartments(response.data), provenance: provenance(response.meta) };
    }
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(String(department_id))}/users`, { page_id: Number(page_id), page_capacity: capacity }, extra.signal);
    const users = projectUsers(response.data, include_contact === true);
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_user_search", {
    title: "Search Yifangyun Users",
    description: "Search enterprise users visible to an access context. Contact fields require an explicit request.",
    inputSchema: { query: z.string().max(200).optional(), include_contact: z.boolean().default(false), access_context: AccessContextSchema, ...PageInputShape },
    outputSchema: { users: z.array(UserSchema), page: PageSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ query, include_contact, page_id, page_capacity, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getUser("/v2/user/search", access.context.id, { query_words: typeof query === "string" ? query : undefined, page_id: Number(page_id), page_capacity: capacity }, extra.signal);
    const users = projectUsers(response.data, include_contact === true);
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_group_read", {
    title: "Read Yifangyun Groups",
    description: "List groups or list members of one group.",
    inputSchema: { action: z.enum(["list", "users"]), group_id: IdSchema.optional(), query: z.string().max(200).optional(), include_contact: z.boolean().default(false), access_context: AccessContextSchema, ...PageInputShape },
    outputSchema: { groups: z.array(GroupSchema).optional(), users: z.array(UserSchema).optional(), page: PageSchema.optional(), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ action, group_id, query, include_contact, page_id, page_capacity, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    if (action === "users" && !group_id) {
      throw new YifangyunError("group_id is required for users action.", { code: "YFY_INPUT_INVALID", phase: "group_read" });
    }
    const endpoint = action === "list" ? "/v2/group/list" : `/v2/group/${encodeURIComponent(String(group_id))}/users`;
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getUser(endpoint, access.context.id, action === "list"
      ? { query_words: typeof query === "string" ? query : undefined }
      : { page_id: Number(page_id), page_capacity: capacity }, extra.signal);
    if (action === "list") return { groups: projectGroups(response.data), provenance: provenance(response.meta, access.context.id) };
    const users = projectUsers(response.data, include_contact === true);
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, requestedPageCapacity: Number(page_capacity), pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });
}
