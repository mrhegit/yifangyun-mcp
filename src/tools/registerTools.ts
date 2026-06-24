import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfigSummary } from "../config.js";
import { redactSensitiveText, YifangyunClient, YifangyunError } from "../client.js";
import type { AppConfig, IdLike, JsonArray, JsonObject, JsonPrimitive, JsonValue, ToolOutput } from "../types.js";

const IdSchema = z.union([
  z.string().trim().regex(/^\d+$/, "id must contain digits only"),
  z.number().int().nonnegative()
]);
const OptionalIdSchema = z.union([IdSchema, z.literal("")]).optional();

const OptionalUserShape = {
  user_id: OptionalIdSchema.describe("Yifangyun user id used to access cloud-drive resources. Empty or omitted values use the server strategy.")
};

const PageShape = {
  page_id: z.number().int().min(0).default(0).describe("Zero-based page number."),
  page_capacity: z.number().int().min(1).max(500).default(50).describe("Requested page size. Clamped by YFY_MAX_PAGE_CAPACITY.")
};

const SortBySchema = z.enum(["name", "date", "size", "score"]);
const SortDirectionSchema = z.enum(["asc", "desc"]);
const SearchTypeSchema = z.enum(["file", "folder", "all"]);
const QueryFilterSchema = z.enum(["file_name", "content", "creator", "tag", "all"]);
const FolderChildTypeSchema = z.enum(["file", "folder", "all"]);

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: ToolOutput;
  isError?: boolean;
};

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function primitive(value: JsonValue | undefined): JsonPrimitive | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

function copyPrimitive(source: JsonObject, target: JsonObject, keys: string[]): void {
  for (const key of keys) {
    const field = primitive(source[key]);
    if (field !== undefined) {
      target[key] = field;
    }
  }
}

function compactUser(value: JsonValue | undefined, includeContact = false): JsonObject | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const output: JsonObject = {};
  copyPrimitive(value, output, ["id", "name", "login", "active", "enterprise_id"]);
  if (includeContact) {
    copyPrimitive(value, output, ["email", "phone"]);
  }
  return Object.keys(output).length ? output : undefined;
}

function compactDepartment(value: JsonValue): JsonObject {
  if (!isObject(value)) {
    return { value };
  }
  const output: JsonObject = {};
  copyPrimitive(value, output, ["id", "name", "parent_id", "order", "space_total", "space_used", "storage_id", "permission_type"]);
  const director = compactUser(value.director);
  if (director) {
    output.director = director;
  }
  return output;
}

function compactItem(value: JsonValue): JsonObject {
  if (!isObject(value)) {
    return { value };
  }
  const output: JsonObject = {};
  copyPrimitive(value, output, [
    "id",
    "name",
    "type",
    "size",
    "extension",
    "extension_category",
    "created_at",
    "modified_at",
    "parent_folder_id",
    "path",
    "in_trash",
    "is_deleted",
    "file_version_key"
  ]);
  const ownedBy = compactUser(value.owned_by);
  const modifiedBy = compactUser(value.modified_by);
  if (ownedBy) {
    output.owned_by = ownedBy;
  }
  if (modifiedBy) {
    output.modified_by = modifiedBy;
  }
  return output;
}

function pagingFrom(data: JsonObject): JsonObject {
  const output: JsonObject = {};
  copyPrimitive(data, output, ["page_id", "page_capacity", "page_count", "total_count"]);
  const pageId = numberValue(data.page_id);
  const pageCount = numberValue(data.page_count);
  if (pageId !== undefined && pageCount !== undefined) {
    output.has_more = pageId + 1 < pageCount;
    if (pageId + 1 < pageCount) {
      output.next_page_id = pageId + 1;
    }
  }
  return output;
}

function compactItemList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const output = pagingFrom(data);
  const files = arrayValue(data.files).map((item) => compactItem(item));
  const folders = arrayValue(data.folders).map((item) => compactItem(item));
  output.files = files;
  output.folders = folders;
  output.file_count = files.length;
  output.folder_count = folders.length;
  if (isObject(data.space)) {
    const space: JsonObject = {};
    copyPrimitive(data.space, space, ["type", "id", "name"]);
    output.space = space;
  }
  return output;
}

function compactUserList(data: JsonValue, includeContact: boolean): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const output = pagingFrom(data);
  const users = arrayValue(data.users).map((user) => compactUser(user, includeContact) ?? { value: user });
  output.users = users;
  output.user_count = users.length;
  return output;
}

function compactChildren(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const children = arrayValue(data.children).map((child) => compactDepartment(child));
  return { children, child_count: children.length };
}

function clampPageCapacity(value: number | undefined, config: AppConfig): number {
  return Math.min(value ?? 50, config.maxPageCapacity);
}

function idToPath(value: IdLike): string {
  return encodeURIComponent(String(value));
}

function normalizeOptionalId(value: IdLike | "" | undefined): IdLike | undefined {
  return value === "" ? undefined : value;
}

function ok(data: JsonValue): ToolResponse {
  const output: ToolOutput = { ok: true, data };
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output
  };
}

function fail(error: unknown): ToolResponse {
  let payload: ToolOutput;
  if (error instanceof YifangyunError) {
    payload = {
      ok: false,
      error: {
        message: redactSensitiveText(error.message),
        retryable: error.retryable,
        ...(error.statusCode ? { status_code: error.statusCode } : {}),
        ...(error.details ? { details: error.details } : {})
      }
    };
  } else {
    const message = error instanceof Error ? error.message : String(error);
    payload = { ok: false, error: { message: redactSensitiveText(message), retryable: false } };
  }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

export function registerTools(server: McpServer, client: YifangyunClient, config: AppConfig): void {
  server.registerTool(
    "yfy_auth_test",
    {
      title: "Test Yifangyun Authentication",
      description: "Validate enterprise JWT authentication, user JWT authentication, and lightweight organization/user API access. Returns no token values.",
      inputSchema: {
        user_id: OptionalIdSchema.describe("Optional user id to test. Empty or omitted values default to YFY_DEFAULT_USER_ID.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ user_id }) => {
      const resolvedUserId = normalizeOptionalId(user_id);
      try {
        await client.getEnterpriseToken();
        await client.getUserToken(resolvedUserId ?? config.defaultUserId);
        const departmentInfo = await client.getEnterprise("/v2/admin/department/0/info");
        const userInfo = await client.getAsUser("/v2/user/info", resolvedUserId ?? config.defaultUserId);
        return ok({
          config: getConfigSummary(config),
          enterprise_token_ok: true,
          user_token_ok: true,
          department_info_keys: isObject(departmentInfo) ? Object.keys(departmentInfo).slice(0, 20) : [],
          user_info_keys: isObject(userInfo) ? Object.keys(userInfo).slice(0, 20) : []
        });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_get_user_info",
    {
      title: "Get Yifangyun User Info",
      description: "Get basic information for a Yifangyun user token. Defaults to the configured default user.",
      inputSchema: { user_id: OptionalIdSchema.describe("User id to inspect. Empty or omitted values default to YFY_DEFAULT_USER_ID.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ user_id }) => {
      try {
        const data = await client.getAsUser("/v2/user/info", normalizeOptionalId(user_id) ?? config.defaultUserId);
        return ok(compactUser(data, false) ?? { raw_keys: isObject(data) ? Object.keys(data) : [] });
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_get_department_info",
    {
      title: "Get Yifangyun Department Info",
      description: "Get department metadata using the enterprise token. Use department_id=0 for the root department when supported by the deployment.",
      inputSchema: { department_id: IdSchema.default(0).describe("Department id. Use 0 for root if available.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ department_id }) => {
      try {
        const data = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id)}/info`);
        return ok(compactDepartment(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_list_department_children",
    {
      title: "List Yifangyun Department Children",
      description: "List child departments using the enterprise token. This is for organization discovery, not file access.",
      inputSchema: {
        department_id: IdSchema.default(0).describe("Parent department id. Use 0 for root if available."),
        permission_filter: z.boolean().optional().describe("Whether to filter by permission when the deployment supports it.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ department_id, permission_filter }) => {
      try {
        const data = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id)}/children`, { permission_filter });
        return ok(compactChildren(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_list_department_users",
    {
      title: "List Yifangyun Department Users",
      description: "List users in a department using the enterprise token. Contact fields are excluded unless include_contact is true.",
      inputSchema: {
        department_id: IdSchema.describe("Department id."),
        page_id: z.number().int().min(0).default(0).describe("Zero-based page number."),
        include_contact: z.boolean().default(false).describe("Whether to include email and phone when returned by the API.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ department_id, page_id, include_contact }) => {
      try {
        const data = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id)}/users`, { page_id });
        return ok(compactUserList(data, include_contact));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_list_personal_items",
    {
      title: "List Yifangyun Personal Items",
      description: "List first-level files and folders in a user's personal cloud-drive space.",
      inputSchema: { ...OptionalUserShape, ...PageShape },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ user_id, page_id, page_capacity }) => {
      try {
        const data = await client.getAsUser("/v2/folder/personal_items", normalizeOptionalId(user_id), { page_id, page_capacity: clampPageCapacity(page_capacity, config) });
        return ok(compactItemList(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_list_department_folders",
    {
      title: "List Yifangyun Department Folders",
      description: "List first-level cloud-drive folders for a department. Uses a user token because file access depends on user permissions.",
      inputSchema: { department_id: IdSchema.describe("Department id."), ...OptionalUserShape, ...PageShape },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ department_id, user_id, page_id, page_capacity }) => {
      try {
        const data = await client.getAsUser("/v2/folder/department_folders", normalizeOptionalId(user_id), {
          department_id: String(department_id),
          page_id,
          page_capacity: clampPageCapacity(page_capacity, config)
        });
        return ok(compactItemList(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_list_folder_children",
    {
      title: "List Yifangyun Folder Children",
      description: "List direct child files and folders under a folder. This tool does not recurse.",
      inputSchema: {
        folder_id: IdSchema.describe("Folder id."),
        type: FolderChildTypeSchema.default("all").describe("Child type filter: file, folder, or all."),
        ...OptionalUserShape,
        ...PageShape
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ folder_id, type, user_id, page_id, page_capacity }) => {
      try {
        const data = await client.getAsUser(`/v2/folder/${idToPath(folder_id)}/children`, normalizeOptionalId(user_id), {
          type,
          page_id,
          page_capacity: clampPageCapacity(page_capacity, config)
        });
        return ok(compactItemList(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_search_items",
    {
      title: "Search Yifangyun Items",
      description: "Search files/folders by keyword. Supports personal space, collaboration space, department space via department_id, or folder scope via search_in_folder.",
      inputSchema: {
        query_words: z.string().min(1).max(200).describe("Search keyword."),
        type: SearchTypeSchema.default("all").describe("Search target type."),
        query_filter: QueryFilterSchema.default("all").describe("Search field: file_name, content, creator, tag, or all."),
        department_id: z.union([z.string(), z.number().int()]).optional().describe("Search space: 0 personal, -1 collaborations, or a department id."),
        search_in_folder: OptionalIdSchema.describe("Restrict search to a parent folder."),
        sort_by: SortBySchema.default("date"),
        sort_direction: SortDirectionSchema.default("desc"),
        precise_search: z.boolean().optional().describe("Whether to enable precise search when supported."),
        fields: z.string().optional().describe("Optional fields flag passed through to Yifangyun."),
        ...OptionalUserShape,
        ...PageShape
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (params) => {
      try {
        const data = await client.getAsUser("/v2/item/search", normalizeOptionalId(params.user_id), {
          query_words: params.query_words,
          type: params.type,
          query_filter: params.query_filter,
          department_id: params.department_id === undefined ? undefined : String(params.department_id),
          search_in_folder: normalizeOptionalId(params.search_in_folder) === undefined ? undefined : String(normalizeOptionalId(params.search_in_folder)),
          sort_by: params.sort_by,
          sort_direction: params.sort_direction,
          precise_search: params.precise_search,
          fields: params.fields,
          page_id: params.page_id,
          page_capacity: clampPageCapacity(params.page_capacity, config)
        });
        return ok(compactItemList(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_get_file_info",
    {
      title: "Get Yifangyun File Info",
      description: "Get file metadata by file id. Uses user-token permissions.",
      inputSchema: {
        file_id: IdSchema.describe("File id."),
        external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."),
        ...OptionalUserShape
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ file_id, external_enterprise_id, user_id }) => {
      try {
        const resolvedExternalEnterpriseId = normalizeOptionalId(external_enterprise_id);
        const data = await client.getAsUser(`/v2/file/${idToPath(file_id)}/info_v2`, normalizeOptionalId(user_id), {
          external_enterprise_id: resolvedExternalEnterpriseId === undefined ? undefined : String(resolvedExternalEnterpriseId)
        });
        return ok(compactItem(data));
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "yfy_get_download_url",
    {
      title: "Get Yifangyun File Download URL",
      description: "Get a pre-signed download URL for a file. The server never downloads the file content and never logs the URL.",
      inputSchema: {
        file_id: IdSchema.describe("File id."),
        version: OptionalIdSchema.describe("File version id or 0 for current version when supported."),
        external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."),
        ...OptionalUserShape
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ file_id, version, external_enterprise_id, user_id }) => {
      try {
        if (!config.allowDownloadUrl) {
          throw new YifangyunError("Download URL output is disabled by YFY_ALLOW_DOWNLOAD_URL.");
        }
        const resolvedVersion = normalizeOptionalId(version);
        const resolvedExternalEnterpriseId = normalizeOptionalId(external_enterprise_id);
        const data = await client.getAsUser(`/v2/file/${idToPath(file_id)}/download_v2`, normalizeOptionalId(user_id), {
          version: resolvedVersion === undefined ? undefined : String(resolvedVersion),
          external_enterprise_id: resolvedExternalEnterpriseId === undefined ? undefined : String(resolvedExternalEnterpriseId)
        });
        if (!isObject(data)) {
          return ok({ raw: data });
        }
        const output: JsonObject = {};
        copyPrimitive(data, output, ["success", "download_url"]);
        return ok(output);
      } catch (error) {
        return fail(error);
      }
    }
  );
}
