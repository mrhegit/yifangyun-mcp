import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject, JsonValue } from "../types.js";
import { registerTool } from "./tooling.js";
import { DepartmentSchema, GroupSchema, NextActionSchema, ProvenanceSchema, SimplePageSchema, UserSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const PageOutputShape = { page: SimplePageSchema, next_action: NextActionSchema.optional() };

function users(value: JsonValue | undefined, includeContact: boolean): JsonObject[] {
  const source = objectValue(value) ?? {};
  return [...arrayValue(source.users), ...arrayValue(source.members), ...arrayValue(source.items)]
    .map((entry) => projectUser(entry, includeContact))
    .filter((entry) => Object.keys(entry).length > 0);
}

function departments(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return [...arrayValue(source.departments), ...arrayValue(source.children), ...arrayValue(source.items)]
    .map(projectDepartment)
    .filter((entry) => Object.keys(entry).length > 0);
}

function groups(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return [...arrayValue(source.groups), ...arrayValue(source.items)]
    .map(projectGroup)
    .filter((entry) => Object.keys(entry).length > 0);
}

function page(returnedCount: number, cursor?: string): JsonObject {
  return { returned_count: returnedCount, has_more: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}) };
}

function nextAction(tool: string, cursor?: string): JsonObject | undefined {
  return cursor ? { tool, arguments: { cursor } } : undefined;
}

function hasMore(value: JsonObject): boolean {
  return value.has_more === true || typeof value.next_page_id === "number";
}

function requiredInitialId(value: unknown, name: string, phase: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new YifangyunError(`${name} is required when cursor is not provided.`, { code: "YFY_INPUT_INVALID", phase });
  }
  return value;
}

export function registerOrganizationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_department_get", {
    title: "Get Yifangyun Department",
    description: "Get one department by numeric ID.",
    inputSchema: { department_id: IdSchema },
    outputSchema: { department: DepartmentSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ department_id }, extra) => {
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(String(department_id))}/info`, {}, extra.signal);
    return { department: projectDepartment(response.data), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_department_children", {
    title: "List Yifangyun Child Departments",
    description: "List direct child departments with one server-side cursor, even when the Provider endpoint is not paginated.",
    inputSchema: { department_id: IdSchema.optional(), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional() },
    outputSchema: { departments: z.array(DepartmentSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "department_children", args.cursor) : undefined;
    const departmentId = cursor ? String(cursor.department_id) : String(args.department_id ?? "0");
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/children`, {}, extra.signal);
    const all = departments(response.data);
    const selected = all.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, "department_children", { department_id: departmentId, offset: nextOffset, limit }) : undefined;
    return { departments: selected, page: page(selected.length, nextCursor), ...(nextAction("yfy_department_children", nextCursor) ? { next_action: nextAction("yfy_department_children", nextCursor)! } : {}), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_department_users", {
    title: "List Yifangyun Department Users",
    description: "List users in one department. Contact fields require include_contact=true.",
    inputSchema: { department_id: IdSchema.optional(), include_contact: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional() },
    outputSchema: { users: z.array(UserSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "department_users", args.cursor) : undefined;
    const departmentId = cursor ? String(cursor.department_id) : requiredInitialId(args.department_id, "department_id", "department_users");
    const includeContact = cursor ? cursor.include_contact === true : args.include_contact === true;
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/users`, { page_id: pageId }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { department_id: departmentId, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit };
    const nextCursor = nextOffset < all.length
      ? encodeCursor(runtime.config.clientSecret, "department_users", payload)
      : hasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "department_users", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 })
        : undefined;
    return { users: selected, page: page(selected.length, nextCursor), ...(nextAction("yfy_department_users", nextCursor) ? { next_action: nextAction("yfy_department_users", nextCursor)! } : {}), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_user_search", {
    title: "Search Yifangyun Users",
    description: "Search visible enterprise users. A non-empty query is required to keep Agent context bounded.",
    inputSchema: { query: z.string().trim().min(1).max(200).optional(), include_contact: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { users: z.array(UserSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "user_search", args.cursor) : undefined;
    const query = cursor ? String(cursor.query) : typeof args.query === "string" ? args.query : "";
    if (!query) throw new YifangyunError("query is required when cursor is not provided.", { code: "YFY_INPUT_INVALID", phase: "user_search" });
    const includeContact = cursor ? cursor.include_contact === true : args.include_contact === true;
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : typeof args.access_context === "string" ? args.access_context : undefined;
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser("/v2/user/search", access.context.id, { query_words: query, page_id: pageId, page_capacity: Math.min(runtime.config.maxPageCapacity, Math.max(50, limit)) }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { query, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < all.length
      ? encodeCursor(runtime.config.clientSecret, "user_search", payload)
      : hasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "user_search", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 })
        : undefined;
    return { users: selected, page: page(selected.length, nextCursor), ...(nextAction("yfy_user_search", nextCursor) ? { next_action: nextAction("yfy_user_search", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_group_list", {
    title: "List Yifangyun Groups",
    description: "List or filter visible groups with bounded local pagination.",
    inputSchema: { query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { groups: z.array(GroupSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "group_list", args.cursor) : undefined;
    const query = cursor && typeof cursor.query === "string" ? cursor.query : typeof args.query === "string" ? args.query : undefined;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : typeof args.access_context === "string" ? args.access_context : undefined;
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser("/v2/group/list", access.context.id, { query_words: query }, extra.signal);
    const all = groups(response.data);
    const selected = all.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, "group_list", { ...(query ? { query } : {}), offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) }) : undefined;
    return { groups: selected, page: page(selected.length, nextCursor), ...(nextAction("yfy_group_list", nextCursor) ? { next_action: nextAction("yfy_group_list", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_group_users", {
    title: "List Yifangyun Group Users",
    description: "List members of one group with a single server-side cursor.",
    inputSchema: { group_id: IdSchema.optional(), include_contact: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25), cursor: z.string().optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { users: z.array(UserSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const cursor = typeof args.cursor === "string" ? decodeCursor(runtime.config.clientSecret, "group_users", args.cursor) : undefined;
    const groupId = cursor ? String(cursor.group_id) : requiredInitialId(args.group_id, "group_id", "group_users");
    const includeContact = cursor ? cursor.include_contact === true : args.include_contact === true;
    const pageId = cursor ? Number(cursor.page_id) : 0;
    const offset = cursor ? Number(cursor.offset) : 0;
    const limit = cursor ? Number(cursor.limit) : Number(args.limit ?? 25);
    const accessContext = cursor && typeof cursor.access_context === "string" ? cursor.access_context : typeof args.access_context === "string" ? args.access_context : undefined;
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser(`/v2/group/${encodeURIComponent(groupId)}/users`, access.context.id, { page_id: pageId }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { group_id: groupId, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < all.length
      ? encodeCursor(runtime.config.clientSecret, "group_users", payload)
      : hasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, "group_users", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 })
        : undefined;
    return { users: selected, page: page(selected.length, nextCursor), ...(nextAction("yfy_group_users", nextCursor) ? { next_action: nextAction("yfy_group_users", nextCursor)! } : {}), provenance: provenance(response.meta, access.context.id) };
  });
}
