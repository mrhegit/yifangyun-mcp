import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonArray, JsonObject, JsonValue } from "../types.js";
import { continuationAction, pageOutput, paginatedRequestSchema, parsePaginatedRequest } from "./pagination.js";
import { registerTool } from "./tooling.js";
import { DepartmentSchema, GroupSchema, JsonValueSchema, NextActionSchema, ProvenanceSchema, SimplePageSchema, UserSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const JsonObjectSchema = z.record(z.unknown());
const AdminLimitSchema = z.number().int().min(1).max(100).default(25);
const AdminPageOutputShape = { page: SimplePageSchema.optional(), next_action: NextActionSchema.optional() };
const DepartmentUsersRequest = paginatedRequestSchema({ department_id: IdSchema, include_contact: z.boolean().default(false), limit: AdminLimitSchema });
const DepartmentUsersCursor = z.object({ department_id: IdSchema, include_contact: z.boolean(), page_id: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const GroupListRequest = paginatedRequestSchema({ query: z.string().max(200).optional(), limit: AdminLimitSchema });
const GroupUsersRequest = paginatedRequestSchema({ group_id: IdSchema, include_contact: z.boolean().default(false), limit: AdminLimitSchema });
const GroupListCursor = z.object({ query: z.string().optional(), page_id: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const GroupUsersCursor = z.object({ group_id: IdSchema, include_contact: z.boolean(), page_id: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const AdminLogRequest = paginatedRequestSchema({ start_date: z.string().length(10).optional(), end_date: z.string().length(10).optional(), date: z.string().length(10).optional(), limit: AdminLimitSchema });
const AdminLogCursor = z.object({ action: z.enum(["list", "list_paginated"]), start_date: z.string().optional(), end_date: z.string().optional(), date: z.string().optional(), page_id: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();

function providerId(value: unknown): string | number {
  const text = String(value);
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : text;
}

function sanitize(value: JsonValue, depth = 0): JsonValue {
  if (depth > 8) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 1000).map((entry) => sanitize(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const output: JsonObject = {};
  for (const [key, field] of Object.entries(value)) {
    if (["access_token", "refresh_token", "client_secret", "password", "presign_url", "download_url"].includes(key.toLowerCase())) {
      output[`${key}_present`] = field !== null && field !== "";
    } else {
      output[key] = sanitize(field, depth + 1);
    }
  }
  return output;
}

function requireFields(args: Record<string, unknown>, fields: string[], phase: string): void {
  const missing = fields.filter((field) => args[field] === undefined || args[field] === "");
  if (missing.length) {
    throw new YifangyunError(`Missing required fields: ${missing.join(", ")}`, { code: "YFY_INPUT_INVALID", phase });
  }
}

function optionalBody(args: Record<string, unknown>, fields: string[]): JsonObject {
  const output: JsonObject = {};
  for (const field of fields) {
    const value = args[field];
    if (value !== undefined && value !== "") {
      output[field] = value as JsonValue;
    }
  }
  return output;
}

function pageCapacity(runtime: AppRuntime, limit: number): number {
  return Math.min(limit, runtime.config.maxPageCapacity);
}

function resultCount(value: JsonValue): number {
  const source = objectValue(value) ?? {};
  return Math.max(...["items", "users", "groups", "departments", "logs", "results", "user_activities"].map((key) => arrayValue(source[key]).length), 0);
}

function hasMore(value: JsonObject): boolean {
  return value.has_more === true || typeof value.next_page_id === "number";
}

export function registerAdminTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("admin")) {
    return;
  }
  registerDepartmentTools(server, runtime);
  registerGroupTools(server, runtime);
  registerUserTools(server, runtime);
  registerLogTools(server, runtime);
  registerPlatformTools(server, runtime);
}

function registerDepartmentTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_admin_department_read", {
    title: "Read Yifangyun Admin Departments",
    description: "Get department metadata, children, users, or space usage through the enterprise plane.",
    inputSchema: z.object({ action: z.enum(["get", "children", "users", "spaces"]), department_id: IdSchema.optional(), operator_id: IdSchema.optional(), request: DepartmentUsersRequest.optional() }).strict().superRefine((value, context) => {
      if (["get", "children"].includes(value.action) && !value.department_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["department_id"], message: "department_id is required." });
      if (value.action === "spaces" && !value.operator_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["operator_id"], message: "operator_id is required." });
      if (value.action === "users" && !value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is required for paginated users." });
      if (value.action !== "users" && value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is only valid for users." });
    }),
    outputSchema: { department: DepartmentSchema.optional(), departments: z.array(DepartmentSchema).optional(), users: z.array(UserSchema).optional(), spaces: z.unknown().optional(), ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = args.action === "users" ? parsePaginatedRequest(DepartmentUsersRequest, args.request, "admin_department_users") : undefined;
    const cursor = request?.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_department_users", request.cursor, DepartmentUsersCursor) : undefined;
    const departmentId = cursor?.department_id ?? (request?.mode === "first_request" ? request.department_id : "");
    const includeContact = cursor?.include_contact ?? (request?.mode === "first_request" && request.include_contact === true);
    const pageId = cursor?.page_id ?? 0;
    const limit = cursor?.limit ?? (request?.mode === "first_request" ? request.limit : 25);
    const endpoint = args.action === "get" ? `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/info`
      : args.action === "children" ? `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/children`
        : args.action === "users" ? `/v2/admin/department/${encodeURIComponent(departmentId)}/users`
          : "/v2/admin/department/space_list";
    const capacity = pageCapacity(runtime, limit);
    const response = await runtime.gateway.getEnterprise(endpoint, {
      ...(args.action === "users" ? { page_id: pageId, page_capacity: capacity } : {}),
      ...(args.action === "spaces" ? { operator_id: String(args.operator_id) } : {})
    }, extra.signal);
    if (args.action === "get") return { department: projectDepartment(response.data), provenance: provenance(response.meta) };
    if (args.action === "children") {
      const source = objectValue(response.data) ?? {};
      return { departments: [...arrayValue(source.departments), ...arrayValue(source.children), ...arrayValue(source.items)].map(projectDepartment), provenance: provenance(response.meta) };
    }
    if (args.action === "users") {
      const source = objectValue(response.data) ?? {};
      const users = [...arrayValue(source.users), ...arrayValue(source.items)].map((value) => projectUser(value, includeContact));
      const providerPage = projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
      const nextCursor = hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_department_users", { department_id: departmentId, include_contact: includeContact, page_id: Number(providerPage.next_page_id ?? pageId + 1), limit }) : undefined;
      const next = continuationAction("yfy_admin_department_read", nextCursor, { action: "users" });
      return { users, page: pageOutput(users.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta) };
    }
    return { spaces: sanitize(response.data), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_admin_department_mutate", {
    title: "Mutate Yifangyun Admin Department",
    description: "Create, update, delete, add/remove a user, or update quota for a department.",
    inputSchema: {
      action: z.enum(["create", "update", "delete", "add_user", "remove_user", "update_space"]),
      department_id: IdSchema.optional(), parent_id: IdSchema.optional(), user_id: IdSchema.optional(), operator_id: IdSchema.optional(),
      name: z.string().trim().min(1).max(30).optional(), director_id: IdSchema.optional(), space_total: z.number().int().optional(),
      hide_phone: z.boolean().optional(), disable_share: z.boolean().optional(), enable_watermark: z.boolean().optional(), create_common_folder: z.boolean().optional(), collab_auto_accepted: z.boolean().optional()
    },
    outputSchema: { action: z.string(), success: z.boolean(), department: DepartmentSchema, provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    if (args.action === "create") requireFields(args, ["name", "parent_id"], "admin_department_mutate");
    if (["update", "delete", "add_user", "remove_user", "update_space"].includes(String(args.action))) requireFields(args, ["department_id"], "admin_department_mutate");
    if (["add_user", "remove_user"].includes(String(args.action))) requireFields(args, ["user_id"], "admin_department_mutate");
    if (args.action === "update_space") requireFields(args, ["operator_id", "space_total"], "admin_department_mutate");
    let endpoint: string;
    let body: JsonObject;
    if (args.action === "create") {
      endpoint = "/v2/admin/department/create";
      body = optionalBody(args, ["name", "space_total", "hide_phone", "disable_share", "enable_watermark", "create_common_folder", "collab_auto_accepted"]);
      body.parent_id = providerId(args.parent_id);
      if (args.director_id) body.director_id = providerId(args.director_id);
    } else if (args.action === "update") {
      endpoint = `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/update`;
      body = optionalBody(args, ["name", "space_total", "hide_phone", "disable_share", "enable_watermark", "collab_auto_accepted"]);
      if (args.parent_id) body.parent_id = providerId(args.parent_id);
      if (args.director_id) body.director_id = providerId(args.director_id);
    } else if (args.action === "delete") {
      endpoint = `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/delete`;
      body = {};
    } else if (args.action === "add_user" || args.action === "remove_user") {
      endpoint = `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/${args.action}`;
      body = { user_id: providerId(args.user_id) };
    } else {
      endpoint = `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/update_space`;
      body = { operatorId: providerId(args.operator_id), spaceTotal: Number(args.space_total) };
    }
    const response = await runtime.gateway.postEnterprise(endpoint, body, {}, extra.signal);
    return { action: String(args.action), success: true, department: projectDepartment(response.data), provenance: provenance(response.meta) };
  });
}

function registerGroupTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_admin_group_read", {
    title: "Read Yifangyun Admin Groups",
    description: "List groups, get group metadata, or list group users.",
    inputSchema: z.object({ action: z.enum(["list", "get", "users"]), group_id: IdSchema.optional(), request: z.union([GroupListRequest, GroupUsersRequest]).optional() }).strict().superRefine((value, context) => {
      if (value.action === "get" && !value.group_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["group_id"], message: "group_id is required for get." });
      if (value.action !== "get" && !value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is required for paginated actions." });
      if (value.action === "get" && value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is not valid for get." });
    }),
    outputSchema: { group: GroupSchema.optional(), groups: z.array(GroupSchema).optional(), users: z.array(UserSchema).optional(), ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    const request = args.action === "list" ? parsePaginatedRequest(GroupListRequest, args.request, "admin_group_list")
      : args.action === "users" ? parsePaginatedRequest(GroupUsersRequest, args.request, "admin_group_users") : undefined;
    const listCursor = args.action === "list" && request?.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_list", request.cursor, GroupListCursor) : undefined;
    const usersCursor = args.action === "users" && request?.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_users", request.cursor, GroupUsersCursor) : undefined;
    const groupId = usersCursor?.group_id ?? (request?.mode === "first_request" && "group_id" in request ? request.group_id : "");
    const query = listCursor?.query ?? (request?.mode === "first_request" && "query" in request ? request.query : undefined);
    const includeContact = usersCursor?.include_contact ?? (request?.mode === "first_request" && "include_contact" in request && request.include_contact === true);
    const pageId = listCursor?.page_id ?? usersCursor?.page_id ?? 0;
    const limit = listCursor?.limit ?? usersCursor?.limit ?? (request?.mode === "first_request" ? request.limit : 25);
    const endpoint = args.action === "list" ? "/v2/admin/group/list" : args.action === "get" ? `/v2/admin/group/${encodeURIComponent(String(args.group_id))}/info` : `/v2/admin/group/${encodeURIComponent(groupId)}/users`;
    const capacity = pageCapacity(runtime, limit);
    const response = await runtime.gateway.getEnterprise(endpoint, args.action === "get" ? {} : { query_words: query, page_id: pageId, page_capacity: capacity }, extra.signal);
    if (args.action === "get") return { group: projectGroup(response.data), provenance: provenance(response.meta) };
    const source = objectValue(response.data) ?? {};
    if (args.action === "list") {
      const groups = [...arrayValue(source.groups), ...arrayValue(source.items)].map(projectGroup);
      const providerPage = projectPage(response.data, { itemCount: groups.length, pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
      const nextCursor = hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_list", { ...(query ? { query } : {}), page_id: Number(providerPage.next_page_id ?? pageId + 1), limit }) : undefined;
      const next = continuationAction("yfy_admin_group_read", nextCursor, { action: "list" });
      return { groups, page: pageOutput(groups.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta) };
    }
    const users = [...arrayValue(source.users), ...arrayValue(source.items)].map((value) => projectUser(value, includeContact));
    const providerPage = projectPage(response.data, { itemCount: users.length, pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
    const nextCursor = hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_users", { group_id: groupId, include_contact: includeContact, page_id: Number(providerPage.next_page_id ?? pageId + 1), limit }) : undefined;
    const next = continuationAction("yfy_admin_group_read", nextCursor, { action: "users" });
    return { users, page: pageOutput(users.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_admin_group_mutate", {
    title: "Mutate Yifangyun Admin Group",
    description: "Create, update, delete, add a user, or remove a user from a group.",
    inputSchema: { action: z.enum(["create", "update", "delete", "add_user", "remove_user"]), group_id: IdSchema.optional(), user_id: IdSchema.optional(), name: z.string().trim().min(1).max(30).optional(), admin_user_id: IdSchema.optional(), description: z.string().max(500).optional(), visible: z.boolean().optional(), collab_auto_accepted: z.boolean().optional() },
    outputSchema: { action: z.string(), success: z.boolean(), group: GroupSchema, provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    if (args.action === "create") requireFields(args, ["name"], "admin_group_mutate");
    if (args.action !== "create") requireFields(args, ["group_id"], "admin_group_mutate");
    if (["add_user", "remove_user"].includes(String(args.action))) requireFields(args, ["user_id"], "admin_group_mutate");
    const endpoint = args.action === "create" ? "/v2/admin/group/create" : `/v2/admin/group/${encodeURIComponent(String(args.group_id))}/${args.action}`;
    const body = ["add_user", "remove_user"].includes(String(args.action))
      ? { user_id: providerId(args.user_id) }
      : optionalBody(args, ["name", "description", "visible", "collab_auto_accepted"]);
    if (args.admin_user_id) body.admin_user_id = providerId(args.admin_user_id);
    const response = await runtime.gateway.postEnterprise(endpoint, body, {}, extra.signal);
    return { action: String(args.action), success: true, group: projectGroup(response.data), provenance: provenance(response.meta) };
  });
}

function registerUserTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_admin_user_read", {
    title: "Read Yifangyun Admin User",
    description: "Get a user, lookup an external identity, or request short-lived login material.",
    inputSchema: { action: z.enum(["get", "lookup", "login_url", "login_params"]), user_id: IdSchema.optional(), identifier: z.string().min(1).optional(), identifier_type: z.enum(["simple_phone_or_email", "user_ticket"]).optional(), platform_id: IdSchema.optional(), include_contact: z.boolean().default(false) },
    outputSchema: { user: UserSchema.optional(), auth_material: z.unknown().optional(), sensitive: z.boolean().optional(), provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    if (args.action === "get") requireFields(args, ["user_id"], "admin_user_read");
    if (args.action !== "get") requireFields(args, ["identifier", "identifier_type", "platform_id"], "admin_user_read");
    const endpoint = args.action === "get" ? `/v2/admin/user/${encodeURIComponent(String(args.user_id))}/info`
      : args.action === "lookup" ? "/v2/admin/user/get_user_info"
        : args.action === "login_url" ? "/v2/admin/user/get_login_url" : "/v2/admin/user/get_login_params";
    const response = await runtime.gateway.getEnterprise(endpoint, args.action === "get" ? {} : { identifier: String(args.identifier), type: String(args.identifier_type), platform_id: String(args.platform_id) }, extra.signal);
    return args.action === "get" || args.action === "lookup"
      ? { user: projectUser(response.data, args.include_contact === true), provenance: provenance(response.meta) }
      : { auth_material: sanitize(response.data), sensitive: true, provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_admin_user_mutate", {
    title: "Mutate Yifangyun Admin User",
    description: "Create, update, or delete a user. Delete requires a transfer target.",
    inputSchema: { action: z.enum(["create", "update", "delete"]), user_id: IdSchema.optional(), transfer_to_user_id: IdSchema.optional(), full_name: z.string().trim().min(1).max(30).optional(), name: z.string().trim().min(1).max(30).optional(), phone: z.string().optional(), email: z.string().email().optional(), storage_id: IdSchema.optional(), space_total: z.number().int().optional(), hide_phone: z.boolean().optional(), disable_download: z.boolean().optional(), force_active: z.boolean().optional(), password: z.string().min(6).max(32).optional() },
    outputSchema: { action: z.string(), success: z.boolean(), user: UserSchema, provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    if (args.action === "update" || args.action === "delete") requireFields(args, ["user_id"], "admin_user_mutate");
    if (args.action === "delete") requireFields(args, ["transfer_to_user_id"], "admin_user_mutate");
    const endpoint = args.action === "create" ? "/v2/admin/user/create" : `/v2/admin/user/${encodeURIComponent(String(args.user_id))}/${args.action}`;
    const body = args.action === "delete"
      ? { user_receive_items: providerId(args.transfer_to_user_id) }
      : optionalBody(args, ["full_name", "name", "phone", "email", "space_total", "hide_phone", "disable_download", "force_active", "password"]);
    if (args.storage_id) body.storage_id = providerId(args.storage_id);
    const response = await runtime.gateway.postEnterprise(endpoint, body, {}, extra.signal);
    return { action: String(args.action), success: true, user: projectUser(response.data, true), provenance: provenance(response.meta) };
  });
}

function registerLogTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_admin_log_query", {
    title: "Query Yifangyun Admin Logs",
    description: "Resolve action types or query admin logs through official read-oriented POST endpoints.",
    inputSchema: z.object({ action: z.enum(["action_types", "info", "list", "list_paginated"]), body: JsonObjectSchema.optional(), action_types: z.array(z.number().int().nonnegative()).optional(), request: AdminLogRequest.optional() }).strict().superRefine((value, context) => {
      if (value.action === "info" && !value.body) context.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "body is required for info." });
      if (["list", "list_paginated"].includes(value.action) && !value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is required for paginated logs." });
      if (!["list", "list_paginated"].includes(value.action) && value.request) context.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: "request is only valid for paginated logs." });
    }),
    outputSchema: { result: JsonValueSchema, ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    let endpoint: string;
    let body: JsonObject;
    const paged = args.action === "list" || args.action === "list_paginated";
    const request = paged ? parsePaginatedRequest(AdminLogRequest, args.request, "admin_log_query") : undefined;
    const cursor = request?.mode === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_log_query", request.cursor, AdminLogCursor) : undefined;
    const action = cursor?.action ?? args.action as "action_types" | "info" | "list" | "list_paginated";
    if (cursor && action !== args.action) throw new YifangyunError("Admin log cursor action does not match the requested action.", { code: "YFY_CURSOR_INVALID", phase: "admin_log_query" });
    const startDate = cursor?.start_date ?? (request?.mode === "first_request" ? request.start_date : undefined);
    const endDate = cursor?.end_date ?? (request?.mode === "first_request" ? request.end_date : undefined);
    const date = cursor?.date ?? (request?.mode === "first_request" ? request.date : undefined);
    const pageId = cursor?.page_id ?? 0;
    const limit = cursor?.limit ?? (request?.mode === "first_request" ? request.limit : 25);
    if (args.action === "action_types") {
      endpoint = "/v2/admin/log/action_type_info";
      body = { is_all: !Array.isArray(args.action_types), ...(Array.isArray(args.action_types) ? { action_types: args.action_types as JsonArray } : {}) };
    } else if (args.action === "info") {
      if (!args.body) throw new YifangyunError("body is required for info action.", { code: "YFY_INPUT_INVALID", phase: "admin_log_query" });
      endpoint = "/v2/admin/log/log_info";
      body = args.body as JsonObject;
    } else if (args.action === "list") {
      if (!startDate || !endDate) throw new YifangyunError("start_date and end_date are required for list.", { code: "YFY_INPUT_INVALID", phase: "admin_log_query" });
      endpoint = "/v2/admin/log/log_list";
      body = { start_date: startDate, end_date: endDate, page_id: pageId + 1, page_capacity: pageCapacity(runtime, limit) };
    } else {
      if (!date) throw new YifangyunError("date is required for list_paginated.", { code: "YFY_INPUT_INVALID", phase: "admin_log_query" });
      endpoint = "/v2/admin/log/log_list_by_pagination";
      body = { date, pagination: pageId + 1, page_capacity: pageCapacity(runtime, limit) };
    }
    const response = await runtime.gateway.postEnterprise(endpoint, body, {}, extra.signal);
    const result = sanitize(response.data);
    if (!paged) return { result, provenance: provenance(response.meta) };
    const providerPage = projectPage(response.data, { itemCount: resultCount(response.data), pageCapacity: limit, requestedPageCapacity: limit, pageId });
    const nextCursor = hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_log_query", { action: args.action as "list" | "list_paginated", ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}), ...(date ? { date } : {}), page_id: Number(providerPage.next_page_id ?? pageId + 1), limit }) : undefined;
    const next = continuationAction("yfy_admin_log_query", nextCursor, { action: String(args.action) });
    return { result, page: pageOutput(resultCount(response.data), nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta) };
  });
}

function registerPlatformTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_admin_platform_map", {
    title: "Map Yifangyun Platform Identity",
    description: "Query mapping between third-party and Yifangyun user, group, or department identifiers.",
    inputSchema: { entity: z.enum(["user", "group", "department"]), platform_id: IdSchema, external_id: z.string().min(1), yfy_id: IdSchema },
    outputSchema: { mapping: JsonValueSchema, provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ entity, platform_id, external_id, yfy_id }, extra) => {
    const key = String(entity) === "user" ? "user_id" : String(entity) === "group" ? "group_id" : "department_id";
    const response = await runtime.gateway.getEnterprise(`/v2/admin/platform/${encodeURIComponent(String(platform_id))}/mapping_${String(entity)}`, { [key]: String(external_id), [`yfy_${key}`]: String(yfy_id) }, extra.signal);
    return { mapping: sanitize(response.data), provenance: provenance(response.meta) };
  });

  registerTool(server, "yfy_admin_platform_sync", {
    title: "Synchronize Yifangyun Platform Entities",
    description: "Synchronize third-party users, groups, or departments through the official admin endpoint.",
    inputSchema: { entity: z.enum(["users", "groups", "departments"]), platform_id: IdSchema, body: JsonObjectSchema },
    outputSchema: { synchronized: z.boolean(), entity: z.string(), result: JsonValueSchema, provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async ({ entity, platform_id, body }, extra) => {
    const response = await runtime.gateway.postEnterprise(`/v2/admin/platform/${encodeURIComponent(String(platform_id))}/sync_${String(entity)}`, body as JsonObject, {}, extra.signal);
    return { synchronized: true, entity: String(entity), result: sanitize(response.data), provenance: provenance(response.meta) };
  });
}
