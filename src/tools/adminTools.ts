import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { arrayValue, objectValue, projectDepartment, projectGroup, projectPage, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonArray, JsonObject, JsonValue } from "../types.js";
import { continuationAction, CursorFieldSchema, pageOutput, resolvePaginationArgs } from "./pagination.js";
import { registerTool } from "./tooling.js";
import { DepartmentSchema, GroupSchema, JsonValueSchema, NextActionSchema, ProvenanceSchema, SimplePageSchema, UserSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const JsonObjectSchema = z.record(z.unknown());
const AdminLimitSchema = z.number().int().min(1).max(100);
const AdminPageOutputShape = { page: SimplePageSchema.optional(), next_action: NextActionSchema.optional() };
const PageFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const DepartmentUsersCursor = z.object({ department_id: IdSchema, include_contact: z.boolean(), page_fingerprint: PageFingerprintSchema, page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const GroupListCursor = z.object({ query: z.string().optional(), page_fingerprint: PageFingerprintSchema, page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const GroupUsersCursor = z.object({ group_id: IdSchema, include_contact: z.boolean(), page_fingerprint: PageFingerprintSchema, page_id: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();
const AdminLogCursor = z.object({ action: z.enum(["list", "list_paginated"]), start_date: z.string().optional(), end_date: z.string().optional(), date: z.string().optional(), page_fingerprint: PageFingerprintSchema, page_id: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100) }).strict();

const AdminDepartmentReadInputShape = {
  action: z.enum(["get", "children", "users", "spaces"]),
  department_id: IdSchema.optional(),
  operator_id: IdSchema.optional(),
  include_contact: z.boolean().optional(),
  limit: AdminLimitSchema.optional(),
  cursor: CursorFieldSchema.optional()
};
const AdminDepartmentReadInputValidator = z.union([
  z.object({ action: z.literal("get"), department_id: IdSchema }).strict(),
  z.object({ action: z.literal("children"), department_id: IdSchema }).strict(),
  z.object({ action: z.literal("users"), department_id: IdSchema, include_contact: z.boolean().optional(), limit: AdminLimitSchema.optional() }).strict(),
  z.object({ action: z.literal("users"), cursor: CursorFieldSchema }).strict(),
  z.object({ action: z.literal("spaces"), operator_id: IdSchema }).strict()
]);

const AdminGroupReadInputShape = {
  action: z.enum(["list", "get", "users"]),
  group_id: IdSchema.optional(),
  query: z.string().max(200).optional(),
  include_contact: z.boolean().optional(),
  limit: AdminLimitSchema.optional(),
  cursor: CursorFieldSchema.optional()
};
const AdminGroupReadInputValidator = z.union([
  z.object({ action: z.literal("list"), query: z.string().max(200).optional(), limit: AdminLimitSchema.optional() }).strict(),
  z.object({ action: z.literal("list"), cursor: CursorFieldSchema }).strict(),
  z.object({ action: z.literal("get"), group_id: IdSchema }).strict(),
  z.object({ action: z.literal("users"), group_id: IdSchema, include_contact: z.boolean().optional(), limit: AdminLimitSchema.optional() }).strict(),
  z.object({ action: z.literal("users"), cursor: CursorFieldSchema }).strict()
]);

const AdminLogQueryInputShape = {
  action: z.enum(["action_types", "info", "list", "list_paginated"]),
  body: JsonObjectSchema.optional(),
  action_types: z.array(z.number().int().nonnegative()).optional(),
  start_date: z.string().length(10).optional(),
  end_date: z.string().length(10).optional(),
  date: z.string().length(10).optional(),
  limit: AdminLimitSchema.optional(),
  cursor: CursorFieldSchema.optional()
};
const AdminLogQueryInputValidator = z.union([
  z.object({ action: z.literal("action_types"), action_types: z.array(z.number().int().nonnegative()).optional() }).strict(),
  z.object({ action: z.literal("info"), body: JsonObjectSchema }).strict(),
  z.object({ action: z.literal("list"), start_date: z.string().length(10), end_date: z.string().length(10), limit: AdminLimitSchema.optional() }).strict(),
  z.object({ action: z.literal("list"), cursor: CursorFieldSchema }).strict(),
  z.object({ action: z.literal("list_paginated"), date: z.string().length(10), limit: AdminLimitSchema.optional() }).strict(),
  z.object({ action: z.literal("list_paginated"), cursor: CursorFieldSchema }).strict()
]);

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

function providerPageFingerprint(value: JsonValue): string {
  const source = objectValue(value) ?? {};
  const rows = Object.fromEntries(["items", "users", "groups", "departments", "logs", "results", "user_activities"]
    .filter((key) => Array.isArray(source[key]))
    .map((key) => [key, source[key]]));
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function assertProviderPageAdvanced(previous: string | undefined, current: string, pageId: number, offset: number, phase: string): void {
  if (previous && offset === 0 && previous === current) {
    throw new YifangyunError("Provider pagination repeated the previous page.", {
      code: "YFY_PROVIDER_PAGINATION_STALLED",
      phase,
      suggestedAction: `Stop pagination at Provider page ${pageId}; retry later or narrow the query.`
    });
  }
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
    continuationFixedKeys: ["action"],
    inputSchema: AdminDepartmentReadInputShape,
    inputValidator: AdminDepartmentReadInputValidator,
    outputSchema: { department: DepartmentSchema.optional(), departments: z.array(DepartmentSchema).optional(), users: z.array(UserSchema).optional(), spaces: z.unknown().optional(), ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    let departmentId = typeof args.department_id === "string" ? args.department_id : "";
    let includeContact = args.include_contact === true;
    let pageId = 0;
    let offset = 0;
    let limit = typeof args.limit === "number" ? args.limit : 25;
    let cursor: z.infer<typeof DepartmentUsersCursor> | undefined;
    if (args.action === "users") {
      const pageArgs = resolvePaginationArgs(args as Record<string, unknown>, "admin_department_users", { fixedKeys: ["action"] });
      cursor = pageArgs.kind === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_department_users", pageArgs.cursor, DepartmentUsersCursor) : undefined;
      departmentId = cursor?.department_id ?? (pageArgs.kind === "first" ? String(pageArgs.data.department_id ?? "") : "");
      includeContact = cursor?.include_contact ?? (pageArgs.kind === "first" && pageArgs.data.include_contact === true);
      pageId = cursor?.page_id ?? 0;
      offset = cursor?.offset ?? 0;
      limit = cursor?.limit ?? (pageArgs.kind === "first" && typeof pageArgs.data.limit === "number" ? pageArgs.data.limit as number : 25);
    }
    const endpoint = args.action === "get" ? `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/info`
      : args.action === "children" ? `/v2/admin/department/${encodeURIComponent(String(args.department_id))}/children`
        : args.action === "users" ? `/v2/admin/department/${encodeURIComponent(departmentId)}/users`
          : "/v2/admin/department/space_list";
    const response = await runtime.gateway.getEnterprise(endpoint, {
      ...(args.action === "users" ? { page_id: pageId } : {}),
      ...(args.action === "spaces" ? { operator_id: String(args.operator_id) } : {})
    }, extra.signal);
    if (args.action === "get") return { department: projectDepartment(response.data), provenance: provenance(response.meta) };
    if (args.action === "children") {
      const source = objectValue(response.data) ?? {};
      return { departments: [...arrayValue(source.departments), ...arrayValue(source.children), ...arrayValue(source.items)].map(projectDepartment), provenance: provenance(response.meta) };
    }
    if (args.action === "users") {
      const source = objectValue(response.data) ?? {};
      const allUsers = [...arrayValue(source.users), ...arrayValue(source.items)].map((value) => projectUser(value, includeContact));
      const fingerprint = providerPageFingerprint(response.data);
      assertProviderPageAdvanced(cursor?.page_fingerprint, fingerprint, pageId, offset, "admin_department_users");
      const users = allUsers.slice(offset, offset + limit);
      const nextOffset = offset + users.length;
      const providerPage = projectPage(response.data, { itemCount: allUsers.length, providerCount: allUsers.length, pageCapacity: 1, pageId });
      const nextCursor = nextOffset < allUsers.length
        ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_department_users", { department_id: departmentId, include_contact: includeContact, page_fingerprint: fingerprint, page_id: pageId, offset: nextOffset, limit })
        : hasMore(providerPage)
          ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_department_users", { department_id: departmentId, include_contact: includeContact, page_fingerprint: fingerprint, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit })
          : undefined;
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
    continuationFixedKeys: ["action"],
    inputSchema: AdminGroupReadInputShape,
    inputValidator: AdminGroupReadInputValidator,
    outputSchema: { group: GroupSchema.optional(), groups: z.array(GroupSchema).optional(), users: z.array(UserSchema).optional(), ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    let groupId = typeof args.group_id === "string" ? args.group_id : "";
    let query = typeof args.query === "string" ? args.query : undefined;
    let includeContact = args.include_contact === true;
    let pageId = 0;
    let offset = 0;
    let limit = typeof args.limit === "number" ? args.limit : 25;
    let previousPageFingerprint: string | undefined;
    if (args.action === "list" || args.action === "users") {
      const phase = args.action === "list" ? "admin_group_list" : "admin_group_users";
      const pageArgs = resolvePaginationArgs(args as Record<string, unknown>, phase, { fixedKeys: ["action"] });
      if (args.action === "list") {
        const listCursor = pageArgs.kind === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_list", pageArgs.cursor, GroupListCursor) : undefined;
        query = listCursor?.query ?? (pageArgs.kind === "first" && typeof pageArgs.data.query === "string" ? pageArgs.data.query : undefined);
        pageId = listCursor?.page_id ?? 0;
        offset = listCursor?.offset ?? 0;
        limit = listCursor?.limit ?? (pageArgs.kind === "first" && typeof pageArgs.data.limit === "number" ? pageArgs.data.limit as number : 25);
        previousPageFingerprint = listCursor?.page_fingerprint;
      } else {
        const usersCursor = pageArgs.kind === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_users", pageArgs.cursor, GroupUsersCursor) : undefined;
        groupId = usersCursor?.group_id ?? (pageArgs.kind === "first" ? String(pageArgs.data.group_id ?? "") : "");
        includeContact = usersCursor?.include_contact ?? (pageArgs.kind === "first" && pageArgs.data.include_contact === true);
        pageId = usersCursor?.page_id ?? 0;
        offset = usersCursor?.offset ?? 0;
        limit = usersCursor?.limit ?? (pageArgs.kind === "first" && typeof pageArgs.data.limit === "number" ? pageArgs.data.limit as number : 25);
        previousPageFingerprint = usersCursor?.page_fingerprint;
      }
    }
    const endpoint = args.action === "list" ? "/v2/admin/group/list" : args.action === "get" ? `/v2/admin/group/${encodeURIComponent(String(args.group_id))}/info` : `/v2/admin/group/${encodeURIComponent(groupId)}/users`;
    const response = await runtime.gateway.getEnterprise(endpoint, args.action === "get" ? {} : { query_words: query, page_id: pageId }, extra.signal);
    if (args.action === "get") return { group: projectGroup(response.data), provenance: provenance(response.meta) };
    const source = objectValue(response.data) ?? {};
    const fingerprint = providerPageFingerprint(response.data);
    assertProviderPageAdvanced(previousPageFingerprint, fingerprint, pageId, offset, args.action === "list" ? "admin_group_list" : "admin_group_users");
    if (args.action === "list") {
      const allGroups = [...arrayValue(source.groups), ...arrayValue(source.items)].map(projectGroup);
      const groups = allGroups.slice(offset, offset + limit);
      const nextOffset = offset + groups.length;
      const providerPage = projectPage(response.data, { itemCount: allGroups.length, providerCount: allGroups.length, pageCapacity: 1, pageId });
      const nextCursor = nextOffset < allGroups.length
        ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_list", { ...(query ? { query } : {}), page_fingerprint: fingerprint, page_id: pageId, offset: nextOffset, limit })
        : hasMore(providerPage)
          ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_list", { ...(query ? { query } : {}), page_fingerprint: fingerprint, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit })
          : undefined;
      const next = continuationAction("yfy_admin_group_read", nextCursor, { action: "list" });
      return { groups, page: pageOutput(groups.length, nextCursor), ...(next ? { next_action: next } : {}), provenance: provenance(response.meta) };
    }
    const allUsers = [...arrayValue(source.users), ...arrayValue(source.items)].map((value) => projectUser(value, includeContact));
    const users = allUsers.slice(offset, offset + limit);
    const nextOffset = offset + users.length;
    const providerPage = projectPage(response.data, { itemCount: allUsers.length, providerCount: allUsers.length, pageCapacity: 1, pageId });
    const nextCursor = nextOffset < allUsers.length
      ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_users", { group_id: groupId, include_contact: includeContact, page_fingerprint: fingerprint, page_id: pageId, offset: nextOffset, limit })
      : hasMore(providerPage)
        ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_group_users", { group_id: groupId, include_contact: includeContact, page_fingerprint: fingerprint, page_id: Number(providerPage.next_page_id ?? pageId + 1), offset: 0, limit })
        : undefined;
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
    continuationFixedKeys: ["action"],
    inputSchema: AdminLogQueryInputShape,
    inputValidator: AdminLogQueryInputValidator,
    outputSchema: { result: JsonValueSchema, ...AdminPageOutputShape, provenance: ProvenanceSchema }
  }, { readOnly: true }, async (args, extra) => {
    let endpoint: string;
    let body: JsonObject;
    const paged = args.action === "list" || args.action === "list_paginated";
    let startDate = typeof args.start_date === "string" ? args.start_date : undefined;
    let endDate = typeof args.end_date === "string" ? args.end_date : undefined;
    let date = typeof args.date === "string" ? args.date : undefined;
    let pageId = 0;
    let limit = typeof args.limit === "number" ? args.limit : 25;
    let previousPageFingerprint: string | undefined;
    if (paged) {
      const pageArgs = resolvePaginationArgs(args as Record<string, unknown>, "admin_log_query", { fixedKeys: ["action"] });
      const cursor = pageArgs.kind === "continuation" ? decodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_log_query", pageArgs.cursor, AdminLogCursor) : undefined;
      const action = cursor?.action ?? args.action as "list" | "list_paginated";
      if (cursor && action !== args.action) throw new YifangyunError("Admin log cursor action does not match the requested action.", { code: "YFY_CURSOR_INVALID", phase: "admin_log_query" });
      startDate = cursor?.start_date ?? (pageArgs.kind === "first" && typeof pageArgs.data.start_date === "string" ? pageArgs.data.start_date : undefined);
      endDate = cursor?.end_date ?? (pageArgs.kind === "first" && typeof pageArgs.data.end_date === "string" ? pageArgs.data.end_date : undefined);
      date = cursor?.date ?? (pageArgs.kind === "first" && typeof pageArgs.data.date === "string" ? pageArgs.data.date : undefined);
      pageId = cursor?.page_id ?? 0;
      limit = cursor?.limit ?? (pageArgs.kind === "first" && typeof pageArgs.data.limit === "number" ? pageArgs.data.limit as number : 25);
      previousPageFingerprint = cursor?.page_fingerprint;
    }
    const capacity = pageCapacity(runtime, limit);
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
      body = { start_date: startDate, end_date: endDate, page_id: pageId + 1, page_capacity: capacity };
    } else {
      if (!date) throw new YifangyunError("date is required for list_paginated.", { code: "YFY_INPUT_INVALID", phase: "admin_log_query" });
      endpoint = "/v2/admin/log/log_list_by_pagination";
      body = { date, pagination: pageId + 1, page_capacity: capacity };
    }
    const response = await runtime.gateway.postEnterprise(endpoint, body, {}, extra.signal);
    const result = sanitize(response.data);
    if (!paged) return { result, provenance: provenance(response.meta) };
    const fingerprint = providerPageFingerprint(response.data);
    assertProviderPageAdvanced(previousPageFingerprint, fingerprint, pageId, 0, "admin_log_query");
    const providerPage = projectPage(response.data, { itemCount: resultCount(response.data), pageCapacity: capacity, requestedPageCapacity: capacity, pageId });
    const nextCursor = hasMore(providerPage) ? encodeCursor(runtime.config.clientSecret, runtime.configFingerprint, "admin_log_query", { action: args.action as "list" | "list_paginated", ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}), ...(date ? { date } : {}), page_fingerprint: fingerprint, page_id: Number(providerPage.next_page_id ?? pageId + 1), limit }) : undefined;
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
