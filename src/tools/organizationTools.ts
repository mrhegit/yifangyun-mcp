import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject, JsonValue } from "../types.js";
import { continuationAction, pageOutput, paginatedRequestSchema, parsePaginatedRequest } from "./pagination.js";
import { DepartmentSchema, GroupSchema, NextActionSchema, ProvenanceSchema, SimplePageSchema, UserSchema } from "./schemas.js";
import { registerTool } from "./tooling.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const PageOutputShape = { page: SimplePageSchema, next_action: NextActionSchema.optional() };
const LimitSchema = z.number().int().min(1).max(100).default(25);
const AccessContextSchema = z.string().trim().min(1).optional();

const DepartmentChildrenRequest = paginatedRequestSchema({ department_id: IdSchema.default("0"), limit: LimitSchema });
const DepartmentUsersRequest = paginatedRequestSchema({ department_id: IdSchema, include_contact: z.boolean().default(false), limit: LimitSchema });
const UserSearchRequest = paginatedRequestSchema({ query: z.string().trim().min(1).max(200), include_contact: z.boolean().default(false), limit: LimitSchema, access_context: AccessContextSchema });
const GroupListRequest = paginatedRequestSchema({ query: z.string().trim().max(200).optional(), limit: LimitSchema, access_context: AccessContextSchema });
const GroupUsersRequest = paginatedRequestSchema({ group_id: IdSchema, include_contact: z.boolean().default(false), limit: LimitSchema, access_context: AccessContextSchema });

const DepartmentChildrenCursor = z.object({ department_id: IdSchema, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const DepartmentUsersCursor = z.object({ department_id: IdSchema, include_contact: z.boolean(), page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const UserSearchCursor = z.object({ query: z.string().min(1), include_contact: z.boolean(), page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), access_context: z.string().optional() }).strict();
const GroupListCursor = z.object({ query: z.string().optional(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), access_context: z.string().optional() }).strict();
const GroupUsersCursor = z.object({ group_id: IdSchema, include_contact: z.boolean(), page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100), access_context: z.string().optional() }).strict();

function firstArray(source: JsonObject, ...keys: string[]): JsonValue[] {
  for (const key of keys) {
    const values = arrayValue(source[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function users(value: JsonValue | undefined, includeContact: boolean): JsonObject[] {
  const source = objectValue(value) ?? {};
  return firstArray(source, "users", "members", "items").map((entry) => projectUser(entry, includeContact)).filter((entry) => Object.keys(entry).length > 0);
}

const ContactPolicySchema = z.object({
  requested: z.boolean(),
  fields: z.enum(["included", "none_available", "omitted_by_default"])
}).strict();

function contactPolicy(includeContact: boolean, projectedUsers: JsonObject[]): { requested: boolean; fields: "included" | "none_available" | "omitted_by_default" } {
  if (!includeContact) return { requested: false, fields: "omitted_by_default" };
  const hasContact = projectedUsers.some((user) => typeof user.email === "string" || typeof user.phone === "string");
  return { requested: true, fields: hasContact ? "included" : "none_available" };
}

function departments(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return firstArray(source, "departments", "children", "items").map(projectDepartment).filter((entry) => Object.keys(entry).length > 0);
}

function groups(value: JsonValue | undefined): JsonObject[] {
  const source = objectValue(value) ?? {};
  return firstArray(source, "groups", "items").map(projectGroup).filter((entry) => Object.keys(entry).length > 0);
}

function hasMore(value: JsonObject): boolean {
  return value.has_more === true || typeof value.next_page_id === "number";
}

export function registerOrganizationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_department_get", {
    title: "Get Yifangyun Department", description: "Get one department by numeric ID.",
    inputSchema: { department_id: IdSchema }, outputSchema: { department: DepartmentSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ department_id }, extra) => {
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(String(department_id))}/info`, {}, extra.signal);
    return { department: projectDepartment(response.data), provenance: provenance(response.meta, undefined, "department_get") };
  });

  registerTool(server, "yfy_department_children", {
    title: "List Yifangyun Child Departments", description: "List direct child departments with a stable server-side cursor.",
    inputSchema: z.object({ request: DepartmentChildrenRequest }).strict(), outputSchema: { departments: z.array(DepartmentSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(DepartmentChildrenRequest, args.request, "department_children");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "department_children", request.cursor, DepartmentChildrenCursor) : undefined;
    const departmentId = cursor?.department_id ?? (request.mode === "first_request" ? request.department_id : "0");
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : 25);
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/children`, {}, extra.signal);
    const all = departments(response.data);
    const selected = all.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "department_children", { department_id: departmentId, offset: nextOffset, limit }) : undefined;
    const next = continuationAction("yfy_department_children", nextCursor);
    return { departments: selected, page: pageOutput(selected.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "department_children") };
  });

  registerTool(server, "yfy_department_users", {
    title: "List Yifangyun Department Users", description: "List users in one department. Contact fields require include_contact=true.",
    inputSchema: z.object({ request: DepartmentUsersRequest }).strict(), outputSchema: { users: z.array(UserSchema), contact_policy: ContactPolicySchema, ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(DepartmentUsersRequest, args.request, "department_users");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "department_users", request.cursor, DepartmentUsersCursor) : undefined;
    const departmentId = cursor?.department_id ?? (request.mode === "first_request" ? request.department_id : "");
    const includeContact = cursor?.include_contact ?? (request.mode === "first_request" && request.include_contact);
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : 25);
    const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/users`, { page_id: pageId }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { department_id: departmentId, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit };
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "department_users", payload)
      : hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "department_users", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 }) : undefined;
    const next = continuationAction("yfy_department_users", nextCursor);
    return { users: selected, contact_policy: contactPolicy(includeContact, selected), page: pageOutput(selected.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "department_users") };
  });

  registerTool(server, "yfy_user_search", {
    title: "Search Yifangyun Users", description: "Search visible enterprise users with a stable cursor.",
    inputSchema: z.object({ request: UserSearchRequest }).strict(), outputSchema: { users: z.array(UserSchema), contact_policy: ContactPolicySchema, ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(UserSearchRequest, args.request, "user_search");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "user_search", request.cursor, UserSearchCursor) : undefined;
    const query = cursor?.query ?? (request.mode === "first_request" ? request.query : "");
    const includeContact = cursor?.include_contact ?? (request.mode === "first_request" && request.include_contact);
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : 25);
    const accessContext = cursor?.access_context ?? (request.mode === "first_request" ? request.access_context : undefined);
    const access = runtime.gateway.context(accessContext);
    const capacity = Math.min(runtime.config.maxPageCapacity, Math.max(50, limit));
    const response = await runtime.gateway.getUser("/v2/user/search", access.context.id, { query_words: query, page_id: pageId, page_capacity: capacity }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: capacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { query, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "user_search", payload)
      : hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "user_search", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 }) : undefined;
    const next = continuationAction("yfy_user_search", nextCursor);
    return { users: selected, contact_policy: contactPolicy(includeContact, selected), page: pageOutput(selected.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "user_search") };
  });

  registerTool(server, "yfy_group_list", {
    title: "List Yifangyun Groups", description: "List or filter visible groups with stable local pagination.",
    inputSchema: z.object({ request: GroupListRequest }).strict(), outputSchema: { groups: z.array(GroupSchema), ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(GroupListRequest, args.request, "group_list");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "group_list", request.cursor, GroupListCursor) : undefined;
    const query = cursor?.query ?? (request.mode === "first_request" ? request.query : undefined);
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : 25);
    const accessContext = cursor?.access_context ?? (request.mode === "first_request" ? request.access_context : undefined);
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser("/v2/group/list", access.context.id, { query_words: query }, extra.signal);
    const all = groups(response.data);
    const selected = all.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "group_list", { ...(query ? { query } : {}), offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) }) : undefined;
    const next = continuationAction("yfy_group_list", nextCursor);
    return { groups: selected, page: pageOutput(selected.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "group_list") };
  });

  registerTool(server, "yfy_group_users", {
    title: "List Yifangyun Group Users", description: "List members of one group with a stable cursor.",
    inputSchema: z.object({ request: GroupUsersRequest }).strict(), outputSchema: { users: z.array(UserSchema), contact_policy: ContactPolicySchema, ...PageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = parsePaginatedRequest(GroupUsersRequest, args.request, "group_users");
    const cursor = request.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "group_users", request.cursor, GroupUsersCursor) : undefined;
    const groupId = cursor?.group_id ?? (request.mode === "first_request" ? request.group_id : "");
    const includeContact = cursor?.include_contact ?? (request.mode === "first_request" && request.include_contact);
    const pageId = cursor?.page_id ?? 0;
    const offset = cursor?.offset ?? 0;
    const limit = cursor?.limit ?? (request.mode === "first_request" ? request.limit : 25);
    const accessContext = cursor?.access_context ?? (request.mode === "first_request" ? request.access_context : undefined);
    const access = runtime.gateway.context(accessContext);
    const response = await runtime.gateway.getUser(`/v2/group/${encodeURIComponent(groupId)}/users`, access.context.id, { page_id: pageId }, extra.signal);
    const all = users(response.data, includeContact);
    const selected = all.slice(offset, offset + limit);
    const providerPage = projectPage(response.data, { itemCount: all.length, providerCount: all.length, pageCapacity: runtime.config.maxPageCapacity, pageId });
    const nextOffset = offset + selected.length;
    const payload = { group_id: groupId, include_contact: includeContact, page_id: pageId, offset: nextOffset, limit, ...(accessContext ? { access_context: accessContext } : {}) };
    const nextCursor = nextOffset < all.length ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "group_users", payload)
      : hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "group_users", { ...payload, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0 }) : undefined;
    const next = continuationAction("yfy_group_users", nextCursor);
    return { users: selected, contact_policy: contactPolicy(includeContact, selected), page: pageOutput(selected.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta, undefined, "group_users") };
  });
}
