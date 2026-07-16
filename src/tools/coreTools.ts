import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfigSummary } from "../config.js";
import { YifangyunError } from "../client.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectItem, projectItemPage, projectPage, projectPath, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { ApiJsonResponse, JsonObject, JsonValue } from "../types.js";
import { registerTool } from "./tooling.js";
import { DepartmentSchema, GroupSchema, ItemSchema, PageInputShape, PageSchema, ProvenanceSchema, UserSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const AccessContextSchema = z.string().trim().min(1).optional();
const ViewSchema = z.enum(["summary", "evidence", "full"]);

function contextId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pageCapacity(runtime: AppRuntime, value: unknown): number {
  return Math.min(typeof value === "number" ? value : 50, runtime.config.maxPageCapacity);
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
      runtime: z.record(z.unknown()),
      toolsets: z.array(z.string()),
      workflow_profiles: z.array(z.string())
    }
  }, { readOnly: true, openWorld: false }, async () => ({
    access_contexts: runtime.access.listContexts().map((context) => ({ id: context.id, default: context.id === runtime.config.defaultAccessContext })),
    authority_scopes: runtime.access.listScopes().map((scope) => ({ id: scope.id, root_folder_id: scope.rootFolderId, access_context: scope.accessContext, tags: scope.tags })),
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
    outputSchema: { files: z.array(ItemSchema), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ file_ids, view, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const results = await Promise.all((file_ids as string[]).map(async (fileId) => {
      const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/info_v2`, access.context.id, access.context.externalEnterpriseId
        ? { external_enterprise_id: access.context.externalEnterpriseId }
        : {}, extra.signal);
      return { file: projectItem(response.data, view as "summary" | "evidence" | "full"), provenance: provenance(response.meta, access.context.id) };
    }));
    return { files: results.map((result) => result.file), provenance: results.map((result) => result.provenance) };
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
    return { ...projectItemPage(response.data, view as "summary" | "evidence" | "full", { pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_item_search", {
    title: "Search Yifangyun Items",
    description: "Search the official Yifangyun index for candidate discovery. Empty results cannot prove absence.",
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      item_type: z.enum(["file", "folder", "all"]).default("all"),
      field: z.enum(["file_name", "content", "creator", "tag", "all"]).default("all"),
      space: z.union([z.literal("personal"), z.literal("collaboration"), IdSchema]).default("personal"),
      folder_id: IdSchema.optional(),
      precise: z.boolean().default(false),
      sort: z.enum(["name", "date", "size", "score"]).default("score"),
      direction: z.enum(["asc", "desc"]).default("desc"),
      view: ViewSchema.default("summary"),
      access_context: AccessContextSchema,
      ...PageInputShape
    },
    outputSchema: { files: z.array(ItemSchema), folders: z.array(ItemSchema), page: PageSchema, authority: z.object({ level: z.literal("hint_only"), safe_to_claim_absence: z.literal(false) }), provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const access = runtime.gateway.context(contextId(args.access_context));
    const departmentId = args.space === "personal" ? "0" : args.space === "collaboration" ? "-1" : String(args.space);
    const capacity = pageCapacity(runtime, args.page_capacity);
    const response = await runtime.gateway.getUser("/v2/item/search", access.context.id, {
      query_words: String(args.query),
      type: String(args.item_type),
      query_filter: String(args.field),
      department_id: departmentId,
      search_in_folder: args.folder_id ? String(args.folder_id) : undefined,
      precise_search: args.precise === true,
      sort_by: String(args.sort),
      sort_direction: String(args.direction),
      page_id: Number(args.page_id),
      page_capacity: capacity
    }, extra.signal);
    return {
      ...projectItemPage(response.data, args.view as "summary" | "evidence" | "full", { pageCapacity: capacity, pageId: Number(args.page_id) }),
      authority: { level: "hint_only", safe_to_claim_absence: false },
      provenance: provenance(response.meta, access.context.id)
    };
  });

  registerTool(server, "yfy_path_resolve", {
    title: "Resolve Yifangyun Path",
    description: "Resolve an exact relative path by walking paginated folder listings.",
    inputSchema: {
      path: z.string().trim().min(1),
      start_folder_id: IdSchema.optional(),
      department_id: IdSchema.optional(),
      access_context: AccessContextSchema
    },
    outputSchema: { resolved: z.boolean(), item: ItemSchema.optional(), missing_segment: z.string().optional(), matched_segments: z.array(ItemSchema), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ path: pathText, start_folder_id, department_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const segments = String(pathText).split("/").map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
      throw new YifangyunError("Path must contain at least one segment.", { code: "YFY_PATH_INVALID", phase: "path_resolution" });
    }
    let folderId = start_folder_id ? String(start_folder_id) : undefined;
    const matched: JsonObject[] = [];
    const observations: JsonObject[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const isLast = index === segments.length - 1;
      const result = await findAcrossPages((pageId) => folderId
        ? runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(folderId)}/children`, access.context.id, { type: isLast ? "all" : "folder", page_id: pageId, page_capacity: runtime.config.maxPageCapacity }, extra.signal)
        : department_id
          ? runtime.gateway.getUser("/v2/folder/department_folders", access.context.id, { department_id: String(department_id), page_id: pageId, page_capacity: runtime.config.maxPageCapacity }, extra.signal)
          : runtime.gateway.getUser("/v2/folder/personal_items", access.context.id, { page_id: pageId, page_capacity: runtime.config.maxPageCapacity }, extra.signal), segments[index]!, !isLast, runtime);
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
    outputSchema: { versions: z.array(ItemSchema), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ file_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/versions`, access.context.id, {}, extra.signal);
    const source = objectValue(response.data) ?? {};
    const versions = [...arrayValue(source.file_versions), ...arrayValue(source.versions)].map((entry) => projectItem(entry, "evidence"));
    return { versions, provenance: provenance(response.meta, access.context.id) };
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
    return { shares, page: projectPage(response.data, { itemCount: shares.length, pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });
}

export function registerOrganizationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_space_list", {
    title: "List Yifangyun Space",
    description: "List one page from personal, collaboration or department cloud-drive space.",
    inputSchema: {
      space: z.enum(["personal", "collaboration", "department"]),
      department_id: IdSchema.optional(),
      access_context: AccessContextSchema,
      ...PageInputShape
    },
    outputSchema: { files: z.array(ItemSchema), folders: z.array(ItemSchema), page: PageSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ space, department_id, access_context, page_id, page_capacity }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    if (space === "department" && !department_id) {
      throw new YifangyunError("department_id is required for department space.", { code: "YFY_INPUT_INVALID", phase: "space_list" });
    }
    const endpoint = space === "personal" ? "/v2/folder/personal_items" : space === "collaboration" ? "/v2/folder/collab_folders" : "/v2/folder/department_folders";
    const capacity = pageCapacity(runtime, page_capacity);
    const response = await runtime.gateway.getUser(endpoint, access.context.id, {
      ...(department_id ? { department_id: String(department_id) } : {}),
      page_id: Number(page_id),
      page_capacity: capacity
    }, extra.signal);
    return { ...projectItemPage(response.data, "summary", { pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });

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
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta) };
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
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
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
    return { users, page: projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, pageId: Number(page_id) }), provenance: provenance(response.meta, access.context.id) };
  });
}
