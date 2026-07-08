import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConfigSummary } from "../config.js";
import { redactSensitiveText, YifangyunClient, YifangyunError } from "../client.js";
import type { ApiJsonResponse, ApiResponseMeta, AppConfig, IdLike, JsonArray, JsonObject, JsonPrimitive, JsonValue, ToolOutput } from "../types.js";

const ToolOutputSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
  meta: z.unknown().optional(),
  raw: z.unknown().optional(),
  warnings: z.array(z.string()).optional()
});

const JsonRecordSchema = z.record(z.unknown());
const IdSchema = z.union([z.string().trim().regex(/^\d+$/, "id must contain digits only"), z.number().int().nonnegative()]);
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
const ItemTypeSchema = z.enum(["file", "folder"]);
const AccessibleByTypeSchema = z.enum(["user", "group", "department", "user_list", "group_list", "department_list"]);
const CollabRoleSchema = z.enum(["coowner", "editor", "online_collaborator", "viewer_uploader", "viewer", "previewer_uploader", "previewer", "uploader", "reset"]);

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

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: JsonValue | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

function idString(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeOptionalId(value: IdLike | "" | undefined): IdLike | undefined {
  return value === "" ? undefined : value;
}

function idToPath(value: IdLike): string {
  return encodeURIComponent(String(value));
}

function clampPageCapacity(value: number | undefined, config: AppConfig): number {
  return Math.min(value ?? 50, config.maxPageCapacity);
}

function addPrimitive(target: JsonObject, key: string, source: JsonObject, sourceKey = key): void {
  const value = primitive(source[sourceKey]);
  if (value !== undefined) {
    target[key] = value;
  }
}

function addId(target: JsonObject, key: string, source: JsonObject, sourceKey = key): void {
  const value = idString(source[sourceKey]);
  if (value !== undefined) {
    target[key] = value;
  }
}

function addTimeFields(target: JsonObject, prefix: string, source: JsonObject, sourceKey = prefix): void {
  const value = numberValue(source[sourceKey]);
  if (value !== undefined) {
    target[`${prefix}_unix`] = value;
    target[`${prefix}_iso`] = new Date(value * 1000).toISOString();
  }
}

function compactPathEntry(value: JsonValue | undefined): JsonObject | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const output: JsonObject = {};
  addPrimitive(output, "type", value);
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  return Object.keys(output).length ? output : undefined;
}

function compactUser(value: JsonValue | undefined, includeContact = false): JsonObject | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  addPrimitive(output, "login", value);
  addId(output, "enterprise_id", value);
  if (booleanValue(value.active) !== undefined) {
    output.active = booleanValue(value.active) ?? false;
  }
  if (booleanValue(value.is_active) !== undefined) {
    output.active = booleanValue(value.is_active) ?? false;
  }
  if (includeContact) {
    addPrimitive(output, "email", value);
    addPrimitive(output, "phone", value);
  }
  return Object.keys(output).length ? output : undefined;
}

function compactDepartment(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  addId(output, "parent_id", value);
  addPrimitive(output, "order", value);
  addPrimitive(output, "space_total", value);
  addPrimitive(output, "space_used", value);
  addId(output, "storage_id", value);
  addPrimitive(output, "permission_type", value);
  addPrimitive(output, "user_count", value);
  addPrimitive(output, "children_departments_count", value);
  addPrimitive(output, "direct_item_count", value);
  addTimeFields(output, "created_at", value);
  const director = compactUser(value.director);
  if (director) {
    output.director = director;
  }
  return output;
}

function compactItem(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  addPrimitive(output, "type", value);
  addPrimitive(output, "size", value);
  addPrimitive(output, "extension", value);
  addPrimitive(output, "extension_category", value);
  addPrimitive(output, "description", value);
  addPrimitive(output, "folder_type", value);
  addPrimitive(output, "comments_count", value);
  addPrimitive(output, "sequence_id", value);
  addPrimitive(output, "sha1", value);
  addPrimitive(output, "remark", value);
  addPrimitive(output, "file_version_key", value);
  if (booleanValue(value.in_trash) !== undefined) {
    output.in_trash = booleanValue(value.in_trash) ?? false;
  }
  if (booleanValue(value.is_deleted) !== undefined) {
    output.is_deleted = booleanValue(value.is_deleted) ?? false;
  }
  if (booleanValue(value.shared) !== undefined) {
    output.shared = booleanValue(value.shared) ?? false;
  }
  if (booleanValue(value.is_frequently_used) !== undefined) {
    output.is_frequently_used = booleanValue(value.is_frequently_used) ?? false;
  }
  if (booleanValue(value.current) !== undefined) {
    output.current = booleanValue(value.current) ?? false;
  }
  addTimeFields(output, "created_at", value);
  addTimeFields(output, "modified_at", value);
  addTimeFields(output, "deleted_at", value);
  addId(output, "parent_folder_id", value);
  const parent = compactPathEntry(value.parent);
  if (parent) {
    output.parent = parent;
    if (!output.parent_folder_id && typeof parent.id === "string") {
      output.parent_folder_id = parent.id;
    }
  }
  const pathChain = arrayValue(value.path).map((entry) => compactPathEntry(entry)).filter((entry): entry is JsonObject => entry !== undefined);
  if (pathChain.length > 0) {
    output.path_chain = pathChain;
    output.ancestor_folder_ids = pathChain.map((entry) => entry.id).filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value.path === "string") {
    output.path = value.path;
  }
  const ownedBy = compactUser(value.owned_by);
  const modifiedBy = compactUser(value.modified_by);
  const deletedBy = compactUser(value.deleted_by);
  if (ownedBy) {
    output.owned_by = ownedBy;
  }
  if (modifiedBy) {
    output.modified_by = modifiedBy;
  }
  if (deletedBy) {
    output.deleted_by = deletedBy;
  }
  if (isObject(value.space)) {
    const space: JsonObject = {};
    addPrimitive(space, "type", value.space);
    addId(space, "id", value.space);
    addPrimitive(space, "name", value.space);
    if (Object.keys(space).length) {
      output.space = space;
    }
  }
  return output;
}

function compactItemBasic(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  addPrimitive(output, "type", value);
  addPrimitive(output, "size", value);
  addId(output, "parent_folder_id", value);
  addPrimitive(output, "extension_category", value);
  addTimeFields(output, "modified_at", value);
  return output;
}

function compactVersion(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addId(output, "file_id", value);
  addPrimitive(output, "name", value);
  addPrimitive(output, "size", value);
  addPrimitive(output, "sha1", value);
  addPrimitive(output, "description", value);
  addPrimitive(output, "remark", value);
  if (booleanValue(value.current) !== undefined) {
    output.current = booleanValue(value.current) ?? false;
  }
  addTimeFields(output, "modified_at", value);
  const modifiedBy = compactUser(value.modified_by);
  if (modifiedBy) {
    output.modified_by = modifiedBy;
  }
  return output;
}

function compactShareLink(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "unique_name", value);
  addPrimitive(output, "access_type", value, "access_type");
  addPrimitive(output, "access_type", value, "access");
  addPrimitive(output, "resource_type", value);
  addId(output, "resource_id", value);
  addPrimitive(output, "download_count", value);
  addPrimitive(output, "preview_count", value);
  addPrimitive(output, "download_count_total", value);
  addPrimitive(output, "view_count", value);
  addPrimitive(output, "disable_download", value);
  if (typeof value.url === "string") {
    output.url_present = true;
  }
  if (typeof value.share_link === "string") {
    output.share_link_present = true;
  }
  if (typeof value.password === "string" && value.password.length > 0) {
    output.password_protected = true;
  }
  if (booleanValue(value.password_protected) !== undefined) {
    output.password_protected = booleanValue(value.password_protected) ?? false;
  }
  if (booleanValue(value.closed) !== undefined) {
    output.closed = booleanValue(value.closed) ?? false;
  }
  addTimeFields(output, "created_at", value);
  addTimeFields(output, "updated_at", value);
  addTimeFields(output, "modified_at", value);
  addTimeFields(output, "due_time", value);
  const creator = compactUser(value.creator ?? value.created_by);
  if (creator) {
    output.creator = creator;
  }
  const item = compactItem(value.item);
  if (Object.keys(item).length && !("raw_value" in item)) {
    output.item = item;
  }
  return output;
}

function compactComment(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "content", value);
  addTimeFields(output, "created_at", value);
  const user = compactUser(value.user, true);
  if (user) {
    output.user = user;
  }
  const item = compactItem(value.item);
  if (Object.keys(item).length && !("raw_value" in item)) {
    output.item = item;
  }
  return output;
}

function compactCollab(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "role", value);
  if (booleanValue(value.accepted) !== undefined) {
    output.accepted = booleanValue(value.accepted) ?? false;
  }
  const item = compactItem(value.item);
  if (Object.keys(item).length && !("raw_value" in item)) {
    output.item = item;
  }
  if (isObject(value.accessible_by)) {
    const accessibleBy: JsonObject = {};
    addPrimitive(accessibleBy, "type", value.accessible_by);
    addId(accessibleBy, "id", value.accessible_by);
    addPrimitive(accessibleBy, "name", value.accessible_by);
    addPrimitive(accessibleBy, "role", value.accessible_by);
    if (Object.keys(accessibleBy).length) {
      output.accessible_by = accessibleBy;
    }
  }
  return output;
}

function compactGroup(value: JsonValue | undefined): JsonObject {
  if (!isObject(value)) {
    return { raw_value: value ?? null };
  }
  const output: JsonObject = {};
  addId(output, "id", value);
  addPrimitive(output, "name", value);
  addPrimitive(output, "description", value);
  if (booleanValue(value.visible) !== undefined) {
    output.visible = booleanValue(value.visible) ?? false;
  }
  if (booleanValue(value.collab_auto_accepted) !== undefined) {
    output.collab_auto_accepted = booleanValue(value.collab_auto_accepted) ?? false;
  }
  addId(output, "admin_user_id", value);
  addPrimitive(output, "user_count", value);
  return output;
}

function compactUserList(data: JsonValue, includeContact = false): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const output = pagingFrom(data);
  const users = arrayValue(data.users).map((value) => compactUser(value, includeContact) ?? { value });
  output.users = users;
  output.user_count = users.length;
  return output;
}

function pagingFrom(data: JsonObject): JsonObject {
  const output: JsonObject = {};
  addPrimitive(output, "page_id", data);
  addPrimitive(output, "page_capacity", data);
  addPrimitive(output, "page_count", data);
  addPrimitive(output, "total_count", data);
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
    addPrimitive(space, "type", data.space);
    addId(space, "id", data.space);
    addPrimitive(space, "name", data.space);
    if (Object.keys(space).length) {
      output.space = space;
    }
  }
  return output;
}

function compactItemListWithMode(data: JsonValue, includeFullMetadata: boolean): JsonObject {
  if (includeFullMetadata) {
    return compactItemList(data);
  }
  if (!isObject(data)) {
    return { raw: data };
  }
  const output = pagingFrom(data);
  const files = arrayValue(data.files).map((item) => compactItemBasic(item));
  const folders = arrayValue(data.folders).map((item) => compactItemBasic(item));
  output.files = files;
  output.folders = folders;
  output.file_count = files.length;
  output.folder_count = folders.length;
  return output;
}

function compactVersionList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const versions = arrayValue(data.file_versions).map((value) => compactVersion(value));
  const output: JsonObject = { versions, version_count: versions.length };
  addPrimitive(output, "success", data);
  return output;
}

function compactShareLinkList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const links = arrayValue(data.share_links ?? data.links).map((value) => compactShareLink(value));
  const output = pagingFrom(data);
  output.share_links = links;
  output.share_link_count = links.length;
  return output;
}

function compactCommentList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const comments = arrayValue(data.comments).map((value) => compactComment(value));
  return { comments, comment_count: comments.length };
}

function compactCollabList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const collabs = arrayValue(data.collabs ?? data.collab_list).map((value) => compactCollab(value));
  return { collabs, collab_count: collabs.length };
}

function compactChildren(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const children = arrayValue(data.children).map((child) => compactDepartment(child));
  return { children, child_count: children.length };
}

function compactGroupList(data: JsonValue): JsonObject {
  if (!isObject(data)) {
    return { raw: data };
  }
  const groups = arrayValue(data.groups ?? data.group_list).map((group) => compactGroup(group));
  return { groups, group_count: groups.length };
}

function metaToJson(meta: ApiResponseMeta): JsonObject {
  const output: JsonObject = {
    endpoint: meta.endpoint,
    fetched_at_iso: meta.fetchedAtIso,
    fetched_at_unix: meta.fetchedAtUnix,
    source_api_version: meta.sourceApiVersion,
    status_code: meta.statusCode
  };
  if (meta.requestId) {
    output.request_id = meta.requestId;
  }
  if (meta.rateLimit) {
    const rateLimit: JsonObject = {};
    if (meta.rateLimit.limit !== undefined) {
      rateLimit.limit = meta.rateLimit.limit;
    }
    if (meta.rateLimit.remaining !== undefined) {
      rateLimit.remaining = meta.rateLimit.remaining;
    }
    if (meta.rateLimit.resetSeconds !== undefined) {
      rateLimit.reset_seconds = meta.rateLimit.resetSeconds;
    }
    output.rate_limit = rateLimit;
  }
  return output;
}

function workflowMeta(name: string, metas: ApiResponseMeta[]): JsonObject {
  return {
    workflow: name,
    primary_request: metaToJson(metas[0]),
    related_requests: metas.slice(1).map((meta) => metaToJson(meta))
  };
}

function compactUploadResult(value: { deliveryMethod: string; fileName: string; localPath: string; remoteStatusCode: number; sizeBytes: number }): JsonObject {
  return {
    delivery_method: value.deliveryMethod,
    file_name: value.fileName,
    local_path: value.localPath,
    remote_status_code: value.remoteStatusCode,
    size_bytes: value.sizeBytes
  };
}

function ok(data: JsonValue, meta?: JsonObject, options: { raw?: JsonValue; warnings?: string[]; config?: AppConfig } = {}): ToolResponse {
  const output: ToolOutput = {
    ok: true,
    data,
    ...(meta ? { meta } : {}),
    ...(options.warnings && options.warnings.length ? { warnings: options.warnings } : {}),
    ...(options.raw !== undefined && options.config?.enableRawResponse ? { raw: options.raw } : {})
  };
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
        ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
        ...(error.statusCode ? { status_code: error.statusCode } : {}),
        ...(error.details ? { details: error.details } : {})
      }
    };
  } else {
    const message = error instanceof Error ? error.message : String(error);
    payload = { ok: false, error: { message: redactSensitiveText(message), retryable: false } };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true
  };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(values[index], index);
      }
    })
  );
  return results;
}

export function registerTools(server: McpServer, client: YifangyunClient, config: AppConfig): void {
  const registerReadTool = (
    name: string,
    definition: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => Promise<ToolResponse>
  ): void => {
    server.registerTool(
      name,
      {
        ...definition,
        outputSchema: ToolOutputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async (args) => {
        try {
          return await handler(args as Record<string, unknown>);
        } catch (error) {
          return fail(error);
        }
      }
    );
  };

  const registerMutationTool = (
    name: string,
    definition: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => Promise<ToolResponse>,
    destructiveHint = false
  ): void => {
    server.registerTool(
      name,
      {
        ...definition,
        outputSchema: ToolOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint, idempotentHint: false, openWorldHint: true }
      },
      async (args) => {
        try {
          return await handler(args as Record<string, unknown>);
        } catch (error) {
          return fail(error);
        }
      }
    );
  };

  const getFileInfo = async (fileId: IdLike, externalEnterpriseId?: IdLike, userId?: IdLike): Promise<ApiJsonResponse> =>
    client.getAsUser(`/v2/file/${idToPath(fileId)}/info_v2`, userId, {
      external_enterprise_id: externalEnterpriseId === undefined ? undefined : String(externalEnterpriseId)
    });

  const getFolderInfo = async (folderId: IdLike, userId?: IdLike): Promise<ApiJsonResponse> =>
    client.getAsUser(`/v2/folder/${idToPath(folderId)}/info`, userId);

  const getFileVersions = async (fileId: IdLike, userId?: IdLike): Promise<ApiJsonResponse> =>
    client.getAsUser(`/v2/file/${idToPath(fileId)}/versions`, userId);

  const getFileVersionInfo = async (fileId: IdLike, versionId: IdLike, userId?: IdLike): Promise<ApiJsonResponse> =>
    client.getAsUser(`/v2/file/${idToPath(fileId)}/version/${idToPath(versionId)}/info`, userId);

  const requireId = (value: IdLike | "" | undefined, fieldName: string): IdLike => {
    const resolved = normalizeOptionalId(value);
    if (resolved === undefined) {
      throw new YifangyunError(`${fieldName} is required for this action.`);
    }
    return resolved;
  };

  const requireNonEmptyString = (value: unknown, fieldName: string): string => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new YifangyunError(`${fieldName} is required for this action.`);
    }
    return value;
  };

  const requireJsonObject = (value: unknown, fieldName: string): JsonObject => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new YifangyunError(`${fieldName} must be a JSON object for this action.`);
    }
    return value as JsonObject;
  };

  const requireNonEmptyArray = (value: unknown, fieldName: string): JsonArray => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new YifangyunError(`${fieldName} must contain at least one item for this action.`);
    }
    return value as JsonArray;
  };

  const collectFolderAncestors = async (folderId: IdLike, userId?: IdLike): Promise<{ chain: JsonObject[]; folder: JsonObject; meta: ApiResponseMeta }> => {
    const response = await getFolderInfo(folderId, userId);
    const folder = compactItem(response.data);
    const chain = arrayValue(folder.path_chain).filter((value): value is JsonObject => isObject(value));
    return { chain, folder, meta: response.meta };
  };

  const collectFileAncestors = async (
    fileId: IdLike,
    externalEnterpriseId?: IdLike,
    userId?: IdLike
  ): Promise<{ chain: JsonObject[]; file: JsonObject; meta: ApiResponseMeta }> => {
    const response = await getFileInfo(fileId, externalEnterpriseId, userId);
    const file = compactItem(response.data);
    const chain = arrayValue(file.path_chain).filter((value): value is JsonObject => isObject(value));
    return { chain, file, meta: response.meta };
  };

  const resolveInFolderByName = async (folderId: IdLike, query: string, userId?: IdLike): Promise<JsonObject | undefined> => {
    const response = await client.getAsUser("/v2/item/search", userId, {
      query_words: query,
      type: "file",
      query_filter: "file_name",
      search_in_folder: String(folderId),
      precise_search: true,
      page_id: 0,
      page_capacity: clampPageCapacity(20, config)
    });
    const data = compactItemList(response.data);
    const files = arrayValue(data.files).filter((value): value is JsonObject => isObject(value));
    return files.find((item) => item.name === query) ?? files[0];
  };

  const getDownloadToTemp = async (
    fileId: IdLike,
    versionId: IdLike | undefined,
    externalEnterpriseId: IdLike | undefined,
    userId?: IdLike
  ): Promise<{ download: JsonObject; metas: ApiResponseMeta[] }> => {
    const infoResponse = await getFileInfo(fileId, externalEnterpriseId, userId);
    const info = compactItem(infoResponse.data);
    const ticket = await client.getAsUser(`/v2/file/${idToPath(fileId)}/download_v2`, userId, {
      version: versionId === undefined ? undefined : String(versionId),
      external_enterprise_id: externalEnterpriseId === undefined ? undefined : String(externalEnterpriseId)
    });
    if (!isObject(ticket.data) || typeof ticket.data.download_url !== "string") {
      throw new YifangyunError("Download API did not return download_url.", { details: { response_shape: ticket.data as JsonValue } });
    }
    const fileNameHint = stringValue(info.name) ?? `${String(fileId)}.bin`;
    const downloaded = await client.downloadFromUrlToTemp(ticket.data.download_url, { fileNameHint, retry: true });
    const download: JsonObject = {
      file_id: String(fileId),
      file_name: downloaded.fileName,
      temp_path: downloaded.tempPath,
      sha256: downloaded.sha256,
      size_bytes: downloaded.sizeBytes,
      ...(downloaded.contentType ? { content_type: downloaded.contentType } : {})
    };
    if (versionId !== undefined) {
      download.version_id = String(versionId);
    }
    if (stringValue(info.file_version_key)) {
      download.file_version_key = stringValue(info.file_version_key) as string;
    }
    return { download, metas: [infoResponse.meta, ticket.meta, downloaded.meta] };
  };

  const buildScopeSnapshot = async (
    rootFolderId: IdLike,
    userId: IdLike | undefined,
    options: { includeFiles: boolean; includeFolders: boolean; maxDepth: number; maxItems: number; pageCapacity: number }
  ): Promise<{ data: JsonObject; metas: ApiResponseMeta[]; warnings: string[] }> => {
    const metas: ApiResponseMeta[] = [];
    const warnings: string[] = [];
    const rootInfo = await getFolderInfo(rootFolderId, userId);
    metas.push(rootInfo.meta);
    const rootFolder = compactItem(rootInfo.data);
    const folders: JsonObject[] = [];
    const files: JsonObject[] = [];
    let truncated = false;
    let visited = 0;

    const walk = async (folderId: IdLike, depth: number, displayPath: string): Promise<void> => {
      if (depth > options.maxDepth || truncated) {
        return;
      }
      let pageId = 0;
      while (!truncated) {
        const response = await client.getAsUser(`/v2/folder/${idToPath(folderId)}/children`, userId, {
          type: "all",
          page_id: pageId,
          page_capacity: clampPageCapacity(options.pageCapacity, config)
        });
        metas.push(response.meta);
        const list = compactItemList(response.data);
        const childFolders = arrayValue(list.folders).filter((value): value is JsonObject => isObject(value));
        const childFiles = arrayValue(list.files).filter((value): value is JsonObject => isObject(value));

        for (const folder of childFolders) {
          if (visited >= options.maxItems) {
            truncated = true;
            break;
          }
          visited += 1;
          const nextDisplay = `${displayPath}/${String(folder.name ?? folder.id ?? "folder")}`;
          folder.depth = depth + 1;
          folder.path_display = nextDisplay;
          if (options.includeFolders) {
            folders.push(folder);
          }
          await walk(String(folder.id ?? "0"), depth + 1, nextDisplay);
          if (truncated) {
            break;
          }
        }

        for (const file of childFiles) {
          if (visited >= options.maxItems) {
            truncated = true;
            break;
          }
          visited += 1;
          file.depth = depth + 1;
          file.path_display = `${displayPath}/${String(file.name ?? file.id ?? "file")}`;
          if (options.includeFiles) {
            files.push(file);
          }
        }

        if (truncated || list.has_more !== true) {
          break;
        }
        pageId = numberValue(list.next_page_id) ?? pageId + 1;
      }
    };

    await walk(rootFolderId, 0, String(rootFolder.name ?? rootFolder.id ?? rootFolderId));
    if (truncated) {
      warnings.push("Snapshot truncated by max_items. Increase max_items for a fuller result.");
    }
    return {
      data: {
        root_folder: rootFolder,
        folders,
        files,
        stats: {
          max_depth: options.maxDepth,
          max_items: options.maxItems,
          folder_count: folders.length,
          file_count: files.length,
          truncated,
          visited_count: visited
        }
      },
      metas,
      warnings
    };
  };

  const listPagedItems = async (
    fetchPage: (pageId: number) => Promise<ApiJsonResponse>,
    mode: "all" | "folders",
    metas: ApiResponseMeta[]
  ): Promise<JsonObject[]> => {
    let pageId = 0;
    const items: JsonObject[] = [];
    while (true) {
      const response = await fetchPage(pageId);
      metas.push(response.meta);
      const list = compactItemList(response.data);
      if (mode === "folders") {
        items.push(...arrayValue(list.folders).filter((value): value is JsonObject => isObject(value)));
      } else {
        items.push(
          ...[...arrayValue(list.folders), ...arrayValue(list.files)].filter((value): value is JsonObject => isObject(value))
        );
      }
      if (list.has_more !== true) {
        break;
      }
      pageId = numberValue(list.next_page_id) ?? pageId + 1;
    }
    return items;
  };

  const resolvePath = async (input: {
    departmentId?: IdLike;
    pathText: string;
    startFolderId?: IdLike;
    userId?: IdLike;
  }): Promise<{ data: JsonObject; metas: ApiResponseMeta[] }> => {
    const segments = input.pathText.split("/").map((item) => item.trim()).filter(Boolean);
    if (segments.length === 0) {
      throw new YifangyunError("path must include at least one non-empty segment.");
    }
    const metas: ApiResponseMeta[] = [];
    const matched: JsonObject[] = [];
    let currentFolderId = input.startFolderId;

    const listAtRoot = async (): Promise<JsonObject[]> => {
      if (currentFolderId !== undefined) {
        const folderId = currentFolderId;
        return listPagedItems(
          async (pageId) => client.getAsUser(`/v2/folder/${idToPath(folderId)}/children`, input.userId, {
            type: "all",
            page_id: pageId,
            page_capacity: clampPageCapacity(200, config)
          }),
          "all",
          metas
        );
      }
      if (input.departmentId !== undefined) {
        return listPagedItems(
          async (pageId) => client.getAsUser("/v2/folder/department_folders", input.userId, {
            department_id: String(input.departmentId),
            page_id: pageId,
            page_capacity: clampPageCapacity(200, config)
          }),
          "folders",
          metas
        );
      }
      return listPagedItems(
        async (pageId) => client.getAsUser("/v2/folder/personal_items", input.userId, {
          page_id: pageId,
          page_capacity: clampPageCapacity(200, config)
        }),
        "all",
        metas
      );
    };

    let candidates = await listAtRoot();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isLast = index === segments.length - 1;
      const match = candidates.find((item) => item.name === segment && (isLast || item.type === "folder"));
      if (!match) {
        return {
          data: { matched_segments: matched, missing_segment: segment, resolved: false },
          metas
        };
      }
      matched.push(match);
      if (!isLast) {
        currentFolderId = String(match.id ?? "0");
        const folderId = currentFolderId;
        candidates = await listPagedItems(
          async (pageId) => client.getAsUser(`/v2/folder/${idToPath(folderId)}/children`, input.userId, {
            type: "all",
            page_id: pageId,
            page_capacity: clampPageCapacity(200, config)
          }),
          "all",
          metas
        );
      }
    }

    return {
      data: {
        matched_segments: matched,
        resolved: true,
        resolved_item: matched[matched.length - 1]
      },
      metas
    };
  };

  registerReadTool(
    "yfy_auth_test",
    {
      title: "Test Yifangyun Authentication",
      description: "Validate enterprise JWT authentication, user JWT authentication, and lightweight organization/user API access. Returns no token values.",
      inputSchema: { user_id: OptionalIdSchema.describe("Optional user id to test. Empty or omitted values default to YFY_DEFAULT_USER_ID.") }
    },
    async ({ user_id }) => {
      const resolvedUserId = normalizeOptionalId(user_id as IdLike | "" | undefined);
      await client.getEnterpriseToken();
      await client.getUserToken(resolvedUserId ?? config.defaultUserId);
      const departmentInfo = await client.getEnterprise("/v2/admin/department/0/info");
      const userInfo = await client.getAsUser("/v2/user/info", resolvedUserId ?? config.defaultUserId);
      return ok(
        {
          config: getConfigSummary(config),
          enterprise_token_ok: true,
          user_token_ok: true,
          department_info_keys: isObject(departmentInfo.data) ? Object.keys(departmentInfo.data).slice(0, 20) : [],
          user_info_keys: isObject(userInfo.data) ? Object.keys(userInfo.data).slice(0, 20) : []
        },
        workflowMeta("yfy_auth_test", [departmentInfo.meta, userInfo.meta])
      );
    }
  );

  registerReadTool(
    "yfy_get_user_info",
    {
      title: "Get Yifangyun User Info",
      description: "Get basic information for a Yifangyun user token. Defaults to the configured default user.",
      inputSchema: { user_id: OptionalIdSchema.describe("User id to inspect. Empty or omitted values default to YFY_DEFAULT_USER_ID.") }
    },
    async ({ user_id }) => {
      const response = await client.getAsUser("/v2/user/info", normalizeOptionalId(user_id as IdLike | "" | undefined) ?? config.defaultUserId);
      return ok(compactUser(response.data, false) ?? { raw_keys: isObject(response.data) ? Object.keys(response.data) : [] }, metaToJson(response.meta), {
        config,
        raw: response.data
      });
    }
  );

  registerReadTool(
    "yfy_get_department_info",
    {
      title: "Get Yifangyun Department Info",
      description: "Get department metadata using the enterprise token. Use department_id=0 for the root department when supported by the deployment.",
      inputSchema: { department_id: IdSchema.default(0).describe("Department id. Use 0 for root if available.") }
    },
    async ({ department_id }) => {
      const response = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id as IdLike)}/info`);
      return ok(compactDepartment(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_department_children",
    {
      title: "List Yifangyun Department Children",
      description: "List child departments using the enterprise token. This is for organization discovery, not file access.",
      inputSchema: {
        department_id: IdSchema.default(0).describe("Parent department id. Use 0 for root if available."),
        permission_filter: z.boolean().optional().describe("Whether to filter by permission when the deployment supports it.")
      }
    },
    async ({ department_id, permission_filter }) => {
      const response = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id as IdLike)}/children`, {
        permission_filter: permission_filter as boolean | undefined
      });
      return ok(compactChildren(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_department_users",
    {
      title: "List Yifangyun Department Users",
      description: "List users in a department using the enterprise token. Contact fields are excluded unless include_contact is true.",
      inputSchema: {
        department_id: IdSchema.describe("Department id."),
        page_id: z.number().int().min(0).default(0).describe("Zero-based page number."),
        include_contact: z.boolean().default(false).describe("Whether to include email and phone when returned by the API.")
      }
    },
    async ({ department_id, page_id, include_contact }) => {
      const response = await client.getEnterprise(`/v2/admin/department/${idToPath(department_id as IdLike)}/users`, {
        page_id: page_id as number
      });
      return ok(compactUserList(response.data, include_contact as boolean), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_personal_items",
    {
      title: "List Yifangyun Personal Items",
      description: "List first-level files and folders in a user's personal cloud-drive space.",
      inputSchema: { ...OptionalUserShape, ...PageShape }
    },
    async ({ user_id, page_id, page_capacity }) => {
      const response = await client.getAsUser("/v2/folder/personal_items", normalizeOptionalId(user_id as IdLike | "" | undefined), {
        page_id: page_id as number,
        page_capacity: clampPageCapacity(page_capacity as number | undefined, config)
      });
      return ok(compactItemList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_department_folders",
    {
      title: "List Yifangyun Department Folders",
      description: "List first-level cloud-drive folders for a department. Uses a user token because file access depends on user permissions.",
      inputSchema: { department_id: IdSchema.describe("Department id."), ...OptionalUserShape, ...PageShape }
    },
    async ({ department_id, user_id, page_id, page_capacity }) => {
      const response = await client.getAsUser("/v2/folder/department_folders", normalizeOptionalId(user_id as IdLike | "" | undefined), {
        department_id: String(department_id as IdLike),
        page_id: page_id as number,
        page_capacity: clampPageCapacity(page_capacity as number | undefined, config)
      });
      return ok(compactItemList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_folder_children",
    {
      title: "List Yifangyun Folder Children",
      description: "List direct child files and folders under a folder. This tool does not recurse.",
      inputSchema: { folder_id: IdSchema.describe("Folder id."), type: FolderChildTypeSchema.default("all"), ...OptionalUserShape, ...PageShape }
    },
    async ({ folder_id, type, user_id, page_id, page_capacity }) => {
      const response = await client.getAsUser(`/v2/folder/${idToPath(folder_id as IdLike)}/children`, normalizeOptionalId(user_id as IdLike | "" | undefined), {
        type: type as string,
        page_id: page_id as number,
        page_capacity: clampPageCapacity(page_capacity as number | undefined, config)
      });
      return ok(compactItemList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  const searchSchema = {
    query_words: z.string().min(1).max(200).describe("Search keyword."),
    type: SearchTypeSchema.default("all").describe("Search target type."),
    query_filter: QueryFilterSchema.default("all").describe("Search field: file_name, content, creator, tag, or all."),
    department_id: z.union([z.string(), z.number().int()]).optional().describe("Search space: 0 personal, -1 collaborations, or a department id."),
    search_in_folder: OptionalIdSchema.describe("Restrict search to a parent folder."),
    sort_by: SortBySchema.default("date"),
    sort_direction: SortDirectionSchema.default("desc"),
    precise_search: z.boolean().optional(),
    fields: z.string().optional(),
    ...OptionalUserShape,
    ...PageShape
  };

  registerReadTool(
    "yfy_search_items",
    {
      title: "Search Yifangyun Items",
      description: "Search files/folders by keyword. Supports personal space, collaboration space, department space via department_id, or folder scope via search_in_folder.",
      inputSchema: searchSchema
    },
    async (params) => {
      const response = await client.getAsUser("/v2/item/search", normalizeOptionalId(params.user_id as IdLike | "" | undefined), {
        query_words: params.query_words as string,
        type: params.type as string,
        query_filter: params.query_filter as string,
        department_id: params.department_id === undefined ? undefined : String(params.department_id),
        search_in_folder: normalizeOptionalId(params.search_in_folder as IdLike | "" | undefined) === undefined ? undefined : String(normalizeOptionalId(params.search_in_folder as IdLike | "" | undefined)),
        sort_by: params.sort_by as string,
        sort_direction: params.sort_direction as string,
        precise_search: params.precise_search as boolean | undefined,
        fields: params.fields as string | undefined,
        page_id: params.page_id as number,
        page_capacity: clampPageCapacity(params.page_capacity as number | undefined, config)
      });
      return ok(compactItemList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_search_items_advanced",
    {
      title: "Search Yifangyun Items Advanced",
      description: "OpenAPI-first advanced search wrapper with the full supported query surface and richer metadata output.",
      inputSchema: { ...searchSchema, include_full_metadata: z.boolean().default(true) }
    },
    async (params) => {
      const response = await client.getAsUser("/v2/item/search", normalizeOptionalId(params.user_id as IdLike | "" | undefined), {
        query_words: params.query_words as string,
        type: params.type as string,
        query_filter: params.query_filter as string,
        department_id: params.department_id === undefined ? undefined : String(params.department_id),
        search_in_folder: normalizeOptionalId(params.search_in_folder as IdLike | "" | undefined) === undefined ? undefined : String(normalizeOptionalId(params.search_in_folder as IdLike | "" | undefined)),
        sort_by: params.sort_by as string,
        sort_direction: params.sort_direction as string,
        precise_search: params.precise_search as boolean | undefined,
        fields: params.fields as string | undefined,
        page_id: params.page_id as number,
        page_capacity: clampPageCapacity(params.page_capacity as number | undefined, config)
      });
      return ok(compactItemListWithMode(response.data, params.include_full_metadata as boolean), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_file_info",
    {
      title: "Get Yifangyun File Info",
      description: "Get file metadata by file id. Uses user-token permissions.",
      inputSchema: { file_id: IdSchema.describe("File id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, external_enterprise_id, user_id }) => {
      const response = await getFileInfo(file_id as IdLike, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_file_info_full",
    {
      title: "Get Yifangyun File Info Full",
      description: "Get richer file metadata for authority and evidence workflows, including ancestry, sha1, ownership, parent, and path-chain fields when available.",
      inputSchema: { file_id: IdSchema.describe("File id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, external_enterprise_id, user_id }) => {
      const response = await getFileInfo(file_id as IdLike, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_folder_info",
    {
      title: "Get Yifangyun Folder Info",
      description: "Get folder metadata by folder id, including ancestry information when the OpenAPI returns path fields.",
      inputSchema: { folder_id: IdSchema.describe("Folder id."), ...OptionalUserShape }
    },
    async ({ folder_id, user_id }) => {
      const response = await getFolderInfo(folder_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_file_versions",
    {
      title: "Get Yifangyun File Versions",
      description: "Get all versions of a file through the official OpenAPI.",
      inputSchema: { file_id: IdSchema.describe("File id."), ...OptionalUserShape }
    },
    async ({ file_id, user_id }) => {
      const response = await getFileVersions(file_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactVersionList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_file_version_info",
    {
      title: "Get Yifangyun File Version Info",
      description: "Get a specific file version through the official OpenAPI.",
      inputSchema: { file_id: IdSchema.describe("File id."), version_id: IdSchema.describe("File version id."), ...OptionalUserShape }
    },
    async ({ file_id, version_id, user_id }) => {
      const response = await getFileVersionInfo(file_id as IdLike, version_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactVersion(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_folder_ancestors",
    {
      title: "Get Yifangyun Folder Ancestors",
      description: "Return the folder path chain and ancestor folder ids for a folder.",
      inputSchema: { folder_id: IdSchema.describe("Folder id."), ...OptionalUserShape }
    },
    async ({ folder_id, user_id }) => {
      const result = await collectFolderAncestors(folder_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok({ folder: result.folder, ancestor_chain: result.chain, ancestor_folder_ids: result.chain.map((entry) => entry.id).filter((entry): entry is string => typeof entry === "string") }, metaToJson(result.meta));
    }
  );

  registerReadTool(
    "yfy_get_file_ancestors",
    {
      title: "Get Yifangyun File Ancestors",
      description: "Return the file path chain and ancestor folder ids for a file.",
      inputSchema: { file_id: IdSchema.describe("File id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, external_enterprise_id, user_id }) => {
      const result = await collectFileAncestors(file_id as IdLike, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok({ file: result.file, ancestor_chain: result.chain, ancestor_folder_ids: result.chain.map((entry) => entry.id).filter((entry): entry is string => typeof entry === "string") }, metaToJson(result.meta));
    }
  );

  registerReadTool(
    "yfy_assert_file_in_scope",
    {
      title: "Assert Yifangyun File In Scope",
      description: "Check whether a file belongs to a root folder scope based on official file ancestry metadata.",
      inputSchema: { file_id: IdSchema.describe("File id."), root_folder_id: IdSchema.describe("Expected root folder id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, root_folder_id, external_enterprise_id, user_id }) => {
      const result = await collectFileAncestors(file_id as IdLike, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      const rootId = String(root_folder_id as IdLike);
      const ancestorIds = result.chain.map((entry) => entry.id).filter((entry): entry is string => typeof entry === "string");
      const inScope = ancestorIds.includes(rootId) || String(result.file.parent_folder_id ?? "") === rootId;
      return ok({
        file: result.file,
        in_scope: inScope,
        matched_ancestor_id: inScope ? rootId : null,
        ancestor_chain: result.chain,
        ancestor_folder_ids: ancestorIds,
        root_scope_match: inScope
      }, metaToJson(result.meta));
    }
  );

  registerReadTool(
    "yfy_build_scope_snapshot",
    {
      title: "Build Yifangyun Scope Snapshot",
      description: "Build a flat structured snapshot for a root folder using official list-children pagination.",
      inputSchema: {
        root_folder_id: IdSchema.describe("Root folder id."),
        max_depth: z.number().int().min(0).default(5),
        max_items: z.number().int().min(1).max(10000).default(1000),
        include_files: z.boolean().default(true),
        include_folders: z.boolean().default(true),
        page_capacity: z.number().int().min(1).max(500).default(200),
        ...OptionalUserShape
      }
    },
    async ({ root_folder_id, max_depth, max_items, include_files, include_folders, page_capacity, user_id }) => {
      const snapshot = await buildScopeSnapshot(root_folder_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined), {
        includeFiles: include_files as boolean,
        includeFolders: include_folders as boolean,
        maxDepth: max_depth as number,
        maxItems: max_items as number,
        pageCapacity: page_capacity as number
      });
      return ok(snapshot.data, workflowMeta("yfy_build_scope_snapshot", snapshot.metas), { warnings: snapshot.warnings });
    }
  );

  registerReadTool(
    "yfy_list_folder_tree",
    {
      title: "List Yifangyun Folder Tree",
      description: "List a recursive folder tree as a flat item array using only official OpenAPI list endpoints.",
      inputSchema: {
        root_folder_id: IdSchema.describe("Root folder id."),
        max_depth: z.number().int().min(0).default(5),
        max_items: z.number().int().min(1).max(10000).default(1000),
        page_capacity: z.number().int().min(1).max(500).default(200),
        ...OptionalUserShape
      }
    },
    async ({ root_folder_id, max_depth, max_items, page_capacity, user_id }) => {
      const snapshot = await buildScopeSnapshot(root_folder_id as IdLike, normalizeOptionalId(user_id as IdLike | "" | undefined), {
        includeFiles: true,
        includeFolders: true,
        maxDepth: max_depth as number,
        maxItems: max_items as number,
        pageCapacity: page_capacity as number
      });
      const folders = arrayValue(snapshot.data.folders).filter((value): value is JsonObject => isObject(value));
      const files = arrayValue(snapshot.data.files).filter((value): value is JsonObject => isObject(value));
      const items = [...folders, ...files].sort((left, right) => String(left.path_display ?? "").localeCompare(String(right.path_display ?? "")));
      return ok({ root_folder: snapshot.data.root_folder, items, stats: snapshot.data.stats }, workflowMeta("yfy_list_folder_tree", snapshot.metas), { warnings: snapshot.warnings });
    }
  );

  registerReadTool(
    "yfy_batch_get_file_info",
    {
      title: "Batch Get Yifangyun File Info",
      description: "Fetch multiple file metadata records with bounded concurrency.",
      inputSchema: { file_ids: z.array(IdSchema).min(1).max(100), external_enterprise_id: OptionalIdSchema, ...OptionalUserShape }
    },
    async ({ file_ids, external_enterprise_id, user_id }) => {
      const metas: ApiResponseMeta[] = [];
      const externalEnterpriseId = normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined);
      const userId = normalizeOptionalId(user_id as IdLike | "" | undefined);
      const files = await mapWithConcurrency(file_ids as IdLike[], 5, async (fileId) => {
        const response = await getFileInfo(fileId, externalEnterpriseId, userId);
        metas.push(response.meta);
        return compactItem(response.data);
      });
      return ok({ files, file_count: files.length }, workflowMeta("yfy_batch_get_file_info", metas));
    }
  );

  registerReadTool(
    "yfy_resolve_path",
    {
      title: "Resolve Yifangyun Path",
      description: "Resolve a personal, department-root, or folder-root relative path by walking official list endpoints.",
      inputSchema: {
        path: z.string().min(1).describe("Path text like /FolderA/FolderB/file.docx"),
        start_folder_id: OptionalIdSchema.describe("Optional starting folder id for relative traversal."),
        department_id: OptionalIdSchema.describe("Optional department id to resolve from department root."),
        ...OptionalUserShape
      }
    },
    async ({ path: pathText, start_folder_id, department_id, user_id }) => {
      const result = await resolvePath({
        departmentId: normalizeOptionalId(department_id as IdLike | "" | undefined),
        pathText: pathText as string,
        startFolderId: normalizeOptionalId(start_folder_id as IdLike | "" | undefined),
        userId: normalizeOptionalId(user_id as IdLike | "" | undefined)
      });
      return ok(result.data, workflowMeta("yfy_resolve_path", result.metas));
    }
  );

  registerReadTool(
    "yfy_get_share_links",
    {
      title: "Get Yifangyun Share Links",
      description: "Get file or folder share-link list using the official share-link list endpoints.",
      inputSchema: { item_type: ItemTypeSchema, item_id: IdSchema, owner_id: OptionalIdSchema, page_id: z.number().int().min(0).default(0), ...OptionalUserShape }
    },
    async ({ item_type, item_id, owner_id, page_id, user_id }) => {
      const endpoint = item_type === "file" ? `/v2/file/${idToPath(item_id as IdLike)}/share_links` : `/v2/folder/${idToPath(item_id as IdLike)}/share_links`;
      const response = await client.getAsUser(endpoint, normalizeOptionalId(user_id as IdLike | "" | undefined), {
        owner_id: normalizeOptionalId(owner_id as IdLike | "" | undefined) === undefined ? undefined : String(normalizeOptionalId(owner_id as IdLike | "" | undefined)),
        page_id: page_id as number
      });
      return ok(compactShareLinkList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_comments",
    {
      title: "Get Yifangyun File Comments",
      description: "Get the official comment list for a file.",
      inputSchema: { file_id: IdSchema.describe("File id."), ...OptionalUserShape }
    },
    async ({ file_id, user_id }) => {
      const response = await client.getAsUser(`/v2/file/${idToPath(file_id as IdLike)}/comments`, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactCommentList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_collab_items",
    {
      title: "List Yifangyun Collaboration Folders",
      description: "List collaboration folders visible to the current user via the official collab_folders endpoint.",
      inputSchema: { sort_by: SortBySchema.default("date"), sort_direction: SortDirectionSchema.default("desc"), ...OptionalUserShape, ...PageShape }
    },
    async ({ sort_by, sort_direction, user_id, page_id, page_capacity }) => {
      const response = await client.getAsUser("/v2/folder/collab_folders", normalizeOptionalId(user_id as IdLike | "" | undefined), {
        sort_by: sort_by as string,
        sort_direction: sort_direction as string,
        page_id: page_id as number,
        page_capacity: clampPageCapacity(page_capacity as number | undefined, config)
      });
      return ok(compactItemList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_folder_collabs",
    {
      title: "Get Yifangyun Folder Collabs",
      description: "Get collaboration members for a folder.",
      inputSchema: { folder_id: IdSchema.describe("Folder id."), ...OptionalUserShape }
    },
    async ({ folder_id, user_id }) => {
      const response = await client.getAsUser(`/v2/folder/${idToPath(folder_id as IdLike)}/collabs`, normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(compactCollabList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_list_groups",
    {
      title: "List Yifangyun Groups",
      description: "List company-visible groups.",
      inputSchema: { query_words: z.string().max(200).optional().describe("Optional group search text."), ...OptionalUserShape }
    },
    async ({ query_words, user_id }) => {
      const response = await client.getAsUser("/v2/group/list", normalizeOptionalId(user_id as IdLike | "" | undefined), {
        query_words: query_words as string | undefined
      });
      return ok(compactGroupList(response.data), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_group_users",
    {
      title: "Get Yifangyun Group Users",
      description: "Get group member list through the official group users endpoint.",
      inputSchema: { group_id: IdSchema.describe("Group id."), query_words: z.string().max(200).optional(), page_id: z.number().int().min(0).default(0), ...OptionalUserShape }
    },
    async ({ group_id, query_words, page_id, user_id }) => {
      const response = await client.getAsUser(`/v2/group/${idToPath(group_id as IdLike)}/users`, normalizeOptionalId(user_id as IdLike | "" | undefined), {
        query_words: query_words as string | undefined,
        page_id: page_id as number
      });
      return ok(compactUserList(response.data, true), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  registerReadTool(
    "yfy_get_user_by_query",
    {
      title: "Search Yifangyun Users",
      description: "Search enterprise users through the official /v2/user/search endpoint.",
      inputSchema: { query_words: z.string().max(200).optional().describe("Search text; omitted means enterprise-wide list."), page_id: z.number().int().min(0).default(0), ...OptionalUserShape }
    },
    async ({ query_words, page_id, user_id }) => {
      const response = await client.getAsUser("/v2/user/search", normalizeOptionalId(user_id as IdLike | "" | undefined), {
        query_words: query_words as string | undefined,
        page_id: page_id as number
      });
      return ok(compactUserList(response.data, true), metaToJson(response.meta), { config, raw: response.data });
    }
  );

  if (config.allowDownloadUrl) {
    registerReadTool(
      "yfy_get_download_url",
      {
        title: "Get Yifangyun File Download URL",
        description: "Get a pre-signed download URL for a file. This sensitive tool is registered only when YFY_ALLOW_DOWNLOAD_URL is enabled.",
        inputSchema: { file_id: IdSchema.describe("File id."), version: OptionalIdSchema.describe("File version id or 0 for current version when supported."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
      },
      async ({ file_id, version, external_enterprise_id, user_id }) => {
        const response = await client.getAsUser(`/v2/file/${idToPath(file_id as IdLike)}/download_v2`, normalizeOptionalId(user_id as IdLike | "" | undefined), {
          version: normalizeOptionalId(version as IdLike | "" | undefined) === undefined ? undefined : String(normalizeOptionalId(version as IdLike | "" | undefined)),
          external_enterprise_id: normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined) === undefined ? undefined : String(normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined))
        });
        const output: JsonObject = {};
        if (isObject(response.data)) {
          if (primitive(response.data.success) !== undefined) {
            output.success = primitive(response.data.success) as JsonPrimitive;
          }
          if (primitive(response.data.download_url) !== undefined) {
            output.download_url = primitive(response.data.download_url) as JsonPrimitive;
          }
        }
        return ok(isObject(response.data) ? output : { raw: response.data }, metaToJson(response.meta), {
          config,
          raw: response.data
        });
      }
    );
  }

  registerReadTool(
    "yfy_download_file_to_temp",
    {
      title: "Download Yifangyun File To Temp",
      description: "Download a file to a local temp path without exposing download_url to the MCP caller.",
      inputSchema: { file_id: IdSchema.describe("File id."), version_id: OptionalIdSchema.describe("Optional version id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, version_id, external_enterprise_id, user_id }) => {
      const result = await getDownloadToTemp(file_id as IdLike, normalizeOptionalId(version_id as IdLike | "" | undefined), normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(result.download, workflowMeta("yfy_download_file_to_temp", result.metas));
    }
  );

  registerReadTool(
    "yfy_download_and_hash",
    {
      title: "Download And Hash Yifangyun File",
      description: "Download a file to temp and return sha256, size, and local path for evidence workflows.",
      inputSchema: { file_id: IdSchema.describe("File id."), version_id: OptionalIdSchema.describe("Optional version id."), external_enterprise_id: OptionalIdSchema.describe("External collaboration enterprise id when required."), ...OptionalUserShape }
    },
    async ({ file_id, version_id, external_enterprise_id, user_id }) => {
      const result = await getDownloadToTemp(file_id as IdLike, normalizeOptionalId(version_id as IdLike | "" | undefined), normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok(result.download, workflowMeta("yfy_download_and_hash", result.metas));
    }
  );

  registerReadTool(
    "yfy_verify_file_current_version",
    {
      title: "Verify Yifangyun File Current Version",
      description: "Verify current metadata against expected fields and optionally verify a downloaded sha256.",
      inputSchema: {
        file_id: IdSchema.describe("File id."),
        expected_sha1: z.string().optional(),
        expected_sha256: z.string().optional(),
        expected_size_bytes: z.number().int().nonnegative().optional(),
        expected_modified_at_unix: z.number().int().nonnegative().optional(),
        expected_file_version_key: z.string().optional(),
        expected_version_id: OptionalIdSchema.optional(),
        external_enterprise_id: OptionalIdSchema.optional(),
        verify_download_hash: z.boolean().default(false),
        ...OptionalUserShape
      }
    },
    async (params) => {
      const userId = normalizeOptionalId(params.user_id as IdLike | "" | undefined);
      const externalEnterpriseId = normalizeOptionalId(params.external_enterprise_id as IdLike | "" | undefined);
      const fileResponse = await getFileInfo(params.file_id as IdLike, externalEnterpriseId, userId);
      const file = compactItem(fileResponse.data);
      const checks: JsonObject = {};
      if (params.expected_sha1) {
        checks.sha1 = file.sha1 === params.expected_sha1;
      }
      if (params.expected_size_bytes !== undefined) {
        checks.size_bytes = numberValue(file.size) === params.expected_size_bytes;
      }
      if (params.expected_modified_at_unix !== undefined) {
        checks.modified_at_unix = numberValue(file.modified_at_unix) === params.expected_modified_at_unix;
      }
      if (params.expected_file_version_key) {
        checks.file_version_key = file.file_version_key === params.expected_file_version_key;
      }
      const metas = [fileResponse.meta];
      if (params.expected_version_id !== undefined && normalizeOptionalId(params.expected_version_id as IdLike | "" | undefined) !== undefined) {
        const versionsResponse = await getFileVersions(params.file_id as IdLike, userId);
        metas.push(versionsResponse.meta);
        const versionList = compactVersionList(versionsResponse.data);
        const versions = arrayValue(versionList.versions).filter((value): value is JsonObject => isObject(value));
        const currentVersion = versions.find((value) => value.current === true);
        checks.current_version_id = String(currentVersion?.id ?? "") === String(normalizeOptionalId(params.expected_version_id as IdLike | "" | undefined));
      }
      if ((params.verify_download_hash as boolean) || params.expected_sha256) {
        const download = await getDownloadToTemp(params.file_id as IdLike, undefined, externalEnterpriseId, userId);
        metas.push(...download.metas);
        checks.download_sha256 = params.expected_sha256 ? download.download.sha256 === params.expected_sha256 : true;
        checks.download_size_bytes = params.expected_size_bytes !== undefined ? download.download.size_bytes === params.expected_size_bytes : true;
      }
      const checkValues = Object.values(checks).filter((value): value is boolean => typeof value === "boolean");
      return ok({ file, checks, matches: checkValues.length === 0 ? true : checkValues.every(Boolean) }, workflowMeta("yfy_verify_file_current_version", metas));
    }
  );

  registerReadTool(
    "yfy_lock_current_original",
    {
      title: "Lock Yifangyun Current Original",
      description: "Authority workflow tool: assert scope, fetch current metadata, then download and hash the current original.",
      inputSchema: { file_id: IdSchema.describe("File id."), root_folder_id: IdSchema.describe("Expected root folder id."), external_enterprise_id: OptionalIdSchema.optional(), ...OptionalUserShape }
    },
    async ({ file_id, root_folder_id, external_enterprise_id, user_id }) => {
      const ancestry = await collectFileAncestors(file_id as IdLike, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      const rootId = String(root_folder_id as IdLike);
      const ancestorIds = ancestry.chain.map((entry) => entry.id).filter((entry): entry is string => typeof entry === "string");
      const inScope = ancestorIds.includes(rootId) || String(ancestry.file.parent_folder_id ?? "") === rootId;
      if (!inScope) {
        throw new YifangyunError("File is outside the requested root_folder_id scope.", {
          details: {
            root_folder_id: rootId,
            ancestor_folder_ids: ancestorIds,
            file_id: String(file_id as IdLike)
          }
        });
      }
      const download = await getDownloadToTemp(file_id as IdLike, undefined, normalizeOptionalId(external_enterprise_id as IdLike | "" | undefined), normalizeOptionalId(user_id as IdLike | "" | undefined));
      return ok({
        scope_proof: {
          in_scope: true,
          root_folder_id: rootId,
          ancestor_chain: ancestry.chain,
          ancestor_folder_ids: ancestorIds
        },
        file: ancestry.file,
        download: download.download
      }, workflowMeta("yfy_lock_current_original", [ancestry.meta, ...download.metas]));
    }
  );

  if (config.enableMutationTools) {
    registerMutationTool(
      "yfy_create_folder",
      {
        title: "Create Yifangyun Folder",
        description: "Create a folder through the official /v2/folder/create endpoint.",
        inputSchema: {
          name: z.string().min(1).max(222),
          parent_id: IdSchema.describe("Parent folder id."),
          department_id: OptionalIdSchema.describe("When parent_id=0, optionally create in a department root."),
          ...OptionalUserShape
        }
      },
      async ({ name, parent_id, department_id, user_id }) => {
        const body: JsonObject = { name: name as string, parent_id: asNumberOrString(parent_id as IdLike) };
        if (normalizeOptionalId(department_id as IdLike | "" | undefined) !== undefined) {
          body.department_id = asNumberOrString(normalizeOptionalId(department_id as IdLike | "" | undefined) as IdLike);
        }
        const response = await client.postAsUser("/v2/folder/create", normalizeOptionalId(user_id as IdLike | "" | undefined), body);
        return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_update_file",
      {
        title: "Update Yifangyun File",
        description: "Update a file name and/or description through the official /v2/file/{id}/update endpoint.",
        inputSchema: { file_id: IdSchema, name: z.string().min(1).max(222).optional(), description: z.string().max(140).optional(), ...OptionalUserShape }
      },
      async ({ file_id, name, description, user_id }) => {
        const body: JsonObject = {};
        if (typeof name === "string") {
          body.name = name;
        }
        if (typeof description === "string") {
          body.description = description;
        }
        const response = await client.postAsUser(`/v2/file/${idToPath(file_id as IdLike)}/update`, normalizeOptionalId(user_id as IdLike | "" | undefined), body);
        return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_update_folder",
      {
        title: "Update Yifangyun Folder",
        description: "Update a folder name and/or description through the official /v2/folder/{id}/update endpoint.",
        inputSchema: { folder_id: IdSchema, name: z.string().min(1).max(222).optional(), description: z.string().max(140).optional(), ...OptionalUserShape }
      },
      async ({ folder_id, name, description, user_id }) => {
        const body: JsonObject = {};
        if (typeof name === "string") {
          body.name = name;
        }
        if (typeof description === "string") {
          body.description = description;
        }
        const response = await client.postAsUser(`/v2/folder/${idToPath(folder_id as IdLike)}/update`, normalizeOptionalId(user_id as IdLike | "" | undefined), body);
        return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_move_item",
      {
        title: "Move Yifangyun Item",
        description: "Move a file or folder to another folder using the official move endpoints.",
        inputSchema: { item_type: ItemTypeSchema, item_id: IdSchema, target_folder_id: IdSchema, department_id: OptionalIdSchema, ...OptionalUserShape }
      },
      async ({ item_type, item_id, target_folder_id, department_id, user_id }) => {
        const endpoint = item_type === "file" ? `/v2/file/${idToPath(item_id as IdLike)}/move` : `/v2/folder/${idToPath(item_id as IdLike)}/move`;
        const body: JsonObject = { target_folder_id: asNumberOrString(target_folder_id as IdLike) };
        if (item_type === "folder" && normalizeOptionalId(department_id as IdLike | "" | undefined) !== undefined) {
          body.department_id = asNumberOrString(normalizeOptionalId(department_id as IdLike | "" | undefined) as IdLike);
        }
        const response = await client.postAsUser(endpoint, normalizeOptionalId(user_id as IdLike | "" | undefined), body);
        return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_copy_item",
      {
        title: "Copy Yifangyun Item",
        description: "Copy a file or folder using the official copy endpoints.",
        inputSchema: { item_type: ItemTypeSchema, item_id: IdSchema, target_folder_id: IdSchema, department_id: OptionalIdSchema, ...OptionalUserShape }
      },
      async ({ item_type, item_id, target_folder_id, department_id, user_id }) => {
        const endpoint = item_type === "file" ? `/v2/file/${idToPath(item_id as IdLike)}/copy` : `/v2/folder/${idToPath(item_id as IdLike)}/copy`;
        const body: JsonObject = { target_folder_id: asNumberOrString(target_folder_id as IdLike) };
        if (item_type === "folder" && normalizeOptionalId(department_id as IdLike | "" | undefined) !== undefined) {
          body.department_id = asNumberOrString(normalizeOptionalId(department_id as IdLike | "" | undefined) as IdLike);
        }
        const response = await client.postAsUser(endpoint, normalizeOptionalId(user_id as IdLike | "" | undefined), body);
        return ok(compactItem(response.data), metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_delete_item",
      {
        title: "Delete Yifangyun Item",
        description: "Delete a file/folder to trash or permanently delete it from trash using official endpoints.",
        inputSchema: { item_type: ItemTypeSchema, item_id: IdSchema, from_trash: z.boolean().default(false), ...OptionalUserShape }
      },
      async ({ item_type, item_id, from_trash, user_id }) => {
        const suffix = (from_trash as boolean) ? "delete_from_trash" : "delete";
        const endpoint = item_type === "file" ? `/v2/file/${idToPath(item_id as IdLike)}/${suffix}` : `/v2/folder/${idToPath(item_id as IdLike)}/${suffix}`;
        const response = await client.postAsUser(endpoint, normalizeOptionalId(user_id as IdLike | "" | undefined), {});
        return ok(isObject(response.data) ? response.data : { success: true }, metaToJson(response.meta), { config, raw: response.data });
      },
      true
    );

    registerMutationTool(
      "yfy_restore_item",
      {
        title: "Restore Yifangyun Item",
        description: "Restore a file or folder from trash using official endpoints.",
        inputSchema: { item_type: ItemTypeSchema, item_id: IdSchema, ...OptionalUserShape }
      },
      async ({ item_type, item_id, user_id }) => {
        const endpoint = item_type === "file" ? `/v2/file/${idToPath(item_id as IdLike)}/restore_from_trash` : `/v2/folder/${idToPath(item_id as IdLike)}/restore_from_trash`;
        const response = await client.postAsUser(endpoint, normalizeOptionalId(user_id as IdLike | "" | undefined), {});
        return ok(isObject(response.data) ? response.data : { success: true }, metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_upload_file",
      {
        title: "Upload Local File To Yifangyun Folder",
        description: "OpenAPI-first upload: request presign_url via /v2/file/upload_v2, then upload the local file bytes to that official presigned URL.",
        inputSchema: { local_path: z.string().min(1), parent_folder_id: IdSchema, name: z.string().min(1).max(222).optional(), is_covered: z.boolean().default(false), ...OptionalUserShape }
      },
      async ({ local_path, parent_folder_id, name, is_covered, user_id }) => {
        const fileName = (name as string | undefined) ?? path.basename(local_path as string);
        const prepareBody: JsonObject = {
          parent_id: asNumberOrString(parent_folder_id as IdLike),
          name: fileName,
          upload_type: "api",
          is_covered: is_covered as boolean
        };
        const prepare = await client.postAsUser("/v2/file/upload_v2", normalizeOptionalId(user_id as IdLike | "" | undefined), prepareBody);
        if (!isObject(prepare.data) || typeof prepare.data.presign_url !== "string") {
          throw new YifangyunError("Upload prepare endpoint did not return presign_url.", { details: { response_shape: prepare.data } });
        }
        const upload = await client.uploadLocalFileToPresignedUrl(prepare.data.presign_url, local_path as string, fileName);
        const resolved = await resolveInFolderByName(parent_folder_id as IdLike, fileName, normalizeOptionalId(user_id as IdLike | "" | undefined));
        return ok({ prepared: true, upload: compactUploadResult(upload), resolved_item: resolved ?? null }, workflowMeta("yfy_upload_file", [prepare.meta]));
      }
    );

    registerMutationTool(
      "yfy_upload_file_by_path",
      {
        title: "Upload Local File To Yifangyun Path",
        description: "Official upload_by_path wrapper plus local file delivery to the returned presign_url.",
        inputSchema: { local_path: z.string().min(1), target_folder_path: z.string().min(1), department_id: OptionalIdSchema, name: z.string().min(1).max(222).optional(), is_covered: z.boolean().default(false), ...OptionalUserShape }
      },
      async ({ local_path, target_folder_path, department_id, name, is_covered, user_id }) => {
        const fileName = (name as string | undefined) ?? path.basename(local_path as string);
        const prepareBody: JsonObject = {
          target_folder_path: target_folder_path as string,
          name: fileName,
          upload_type: "api",
          is_covered: is_covered as boolean
        };
        if (normalizeOptionalId(department_id as IdLike | "" | undefined) !== undefined) {
          prepareBody.department_id = asNumberOrString(normalizeOptionalId(department_id as IdLike | "" | undefined) as IdLike);
        }
        const prepare = await client.postAsUser("/v2/file/upload_by_path", normalizeOptionalId(user_id as IdLike | "" | undefined), prepareBody);
        if (!isObject(prepare.data) || typeof prepare.data.presign_url !== "string") {
          throw new YifangyunError("Upload-by-path prepare endpoint did not return presign_url.", { details: { response_shape: prepare.data } });
        }
        const upload = await client.uploadLocalFileToPresignedUrl(prepare.data.presign_url, local_path as string, fileName);
        const resolved = await resolvePath({ departmentId: normalizeOptionalId(department_id as IdLike | "" | undefined), pathText: `${target_folder_path}/${fileName}`, userId: normalizeOptionalId(user_id as IdLike | "" | undefined) });
        return ok({ prepared: true, upload: compactUploadResult(upload), resolved_path: resolved.data }, workflowMeta("yfy_upload_file_by_path", [prepare.meta, ...resolved.metas]));
      }
    );

    registerMutationTool(
      "yfy_upload_new_version",
      {
        title: "Upload New Yifangyun File Version",
        description: "OpenAPI-first new-version upload: request presign_url via /v2/file/{id}/new_version_v2, then upload local bytes to that URL.",
        inputSchema: { file_id: IdSchema, local_path: z.string().min(1), name: z.string().min(1).max(222).optional(), remark: z.string().max(500).optional(), ...OptionalUserShape }
      },
      async ({ file_id, local_path, name, remark, user_id }) => {
        const fileName = (name as string | undefined) ?? path.basename(local_path as string);
        const prepareBody: JsonObject = {
          name: fileName,
          upload_type: "api"
        };
        if (typeof remark === "string") {
          prepareBody.remark = remark;
        }
        const prepare = await client.postAsUser(`/v2/file/${idToPath(file_id as IdLike)}/new_version_v2`, normalizeOptionalId(user_id as IdLike | "" | undefined), prepareBody);
        if (!isObject(prepare.data) || typeof prepare.data.presign_url !== "string") {
          throw new YifangyunError("New-version prepare endpoint did not return presign_url.", { details: { response_shape: prepare.data } });
        }
        const upload = await client.uploadLocalFileToPresignedUrl(prepare.data.presign_url, local_path as string, fileName);
        const current = await getFileInfo(file_id as IdLike, undefined, normalizeOptionalId(user_id as IdLike | "" | undefined));
        return ok({ prepared: true, upload: compactUploadResult(upload), current_file: compactItem(current.data) }, workflowMeta("yfy_upload_new_version", [prepare.meta, current.meta]));
      }
    );

    registerMutationTool(
      "yfy_manage_collab",
      {
        title: "Manage Yifangyun Collaboration",
        description: "Manage collaboration through the official collab endpoints: invite, invite_batch, info, update, delete, remove.",
        inputSchema: {
          action: z.enum(["invite", "invite_batch", "info", "update", "delete", "remove"]),
          collab_id: OptionalIdSchema,
          folder_id: OptionalIdSchema,
          accessible_by: JsonRecordSchema.optional(),
          accessible_by_list: z.array(JsonRecordSchema).optional(),
          invitation_message: z.string().max(140).optional(),
          role: CollabRoleSchema.optional(),
          collab_ids: z.array(IdSchema).optional(),
          ...OptionalUserShape
        }
      },
      async (params) => {
        const userId = normalizeOptionalId(params.user_id as IdLike | "" | undefined);
        let response: ApiJsonResponse;
        switch (params.action) {
          case "invite":
            response = await client.postAsUser("/v2/collab/invite", userId, {
              folder_id: asNumberOrString(requireId(params.folder_id as IdLike | "" | undefined, "folder_id")),
              accessible_by: requireJsonObject(params.accessible_by, "accessible_by"),
              ...(typeof params.invitation_message === "string" ? { invitation_message: params.invitation_message } : {})
            });
            break;
          case "invite_batch":
            response = await client.postAsUser("/v2/collab/invite_batch", userId, {
              folder_id: asNumberOrString(requireId(params.folder_id as IdLike | "" | undefined, "folder_id")),
              accessible_by: requireNonEmptyArray(params.accessible_by_list, "accessible_by_list"),
              ...(typeof params.invitation_message === "string" ? { invitation_message: params.invitation_message } : {})
            });
            break;
          case "info":
            response = await client.getAsUser(`/v2/collab/${idToPath(requireId(params.collab_id as IdLike | "" | undefined, "collab_id"))}/info`, userId);
            break;
          case "update":
            response = await client.postAsUser(`/v2/collab/${idToPath(requireId(params.collab_id as IdLike | "" | undefined, "collab_id"))}/update`, userId, { role: requireNonEmptyString(params.role, "role") });
            break;
          case "delete":
            response = await client.postAsUser(`/v2/collab/${idToPath(requireId(params.collab_id as IdLike | "" | undefined, "collab_id"))}/delete`, userId, {});
            break;
          default:
            response = await client.postAsUser("/v2/collab/remove", userId, {
              folder_id: asNumberOrString(requireId(params.folder_id as IdLike | "" | undefined, "folder_id")),
              collab_ids: requireNonEmptyArray(params.collab_ids, "collab_ids")
            });
            break;
        }
        return ok(isObject(response.data) && response.data.item ? compactCollab(response.data) : response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );
  }

  if (config.enableAdminTools) {
    registerMutationTool(
      "yfy_admin_departments",
      {
        title: "Yifangyun Admin Departments",
        description: "Official admin department wrapper: info, children, users, space_list, create, update, delete, add_user, remove_user, update_space.",
        inputSchema: { action: z.enum(["info", "children", "users", "space_list", "create", "update", "delete", "add_user", "remove_user", "update_space"]), department_id: OptionalIdSchema, page_id: z.number().int().min(0).default(0), permission_filter: z.boolean().optional(), body: JsonRecordSchema.optional() }
      },
      async (params) => {
        let response: ApiJsonResponse;
        const departmentId = normalizeOptionalId(params.department_id as IdLike | "" | undefined);
        switch (params.action) {
          case "info":
            response = await client.getEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/info`);
            break;
          case "children":
            response = await client.getEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/children`, { permission_filter: params.permission_filter as boolean | undefined });
            break;
          case "users":
            response = await client.getEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/users`, { page_id: params.page_id as number });
            break;
          case "space_list":
            response = await client.getEnterprise("/v2/admin/department/space_list");
            break;
          case "create":
            response = await client.postEnterprise("/v2/admin/department/create", requireJsonObject(params.body, "body"));
            break;
          case "update":
            response = await client.postEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/update`, requireJsonObject(params.body, "body"));
            break;
          case "delete":
            response = await client.postEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/delete`, requireJsonObject(params.body, "body"));
            break;
          case "add_user":
            response = await client.postEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/add_user`, requireJsonObject(params.body, "body"));
            break;
          case "remove_user":
            response = await client.postEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/remove_user`, requireJsonObject(params.body, "body"));
            break;
          default:
            response = await client.postEnterprise(`/v2/admin/department/${idToPath(requireId(departmentId, "department_id"))}/update_space`, requireJsonObject(params.body, "body"));
            break;
        }
        return ok(response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_admin_groups",
      {
        title: "Yifangyun Admin Groups",
        description: "Official admin group wrapper: list, info, users, create, update, delete, add_user, remove_user.",
        inputSchema: { action: z.enum(["list", "info", "users", "create", "update", "delete", "add_user", "remove_user"]), group_id: OptionalIdSchema, body: JsonRecordSchema.optional() }
      },
      async (params) => {
        let response: ApiJsonResponse;
        const groupId = normalizeOptionalId(params.group_id as IdLike | "" | undefined);
        switch (params.action) {
          case "list":
            response = await client.getEnterprise("/v2/admin/group/list");
            break;
          case "info":
            response = await client.getEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/info`);
            break;
          case "users":
            response = await client.getEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/users`);
            break;
          case "create":
            response = await client.postEnterprise("/v2/admin/group/create", requireJsonObject(params.body, "body"));
            break;
          case "update":
            response = await client.postEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/update`, requireJsonObject(params.body, "body"));
            break;
          case "delete":
            response = await client.postEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/delete`, requireJsonObject(params.body, "body"));
            break;
          case "add_user":
            response = await client.postEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/add_user`, requireJsonObject(params.body, "body"));
            break;
          default:
            response = await client.postEnterprise(`/v2/admin/group/${idToPath(requireId(groupId, "group_id"))}/remove_user`, requireJsonObject(params.body, "body"));
            break;
        }
        return ok(response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_admin_users",
      {
        title: "Yifangyun Admin Users",
        description: "Official admin user wrapper: info, get_user_info, create, update, delete, login_url, login_params.",
        inputSchema: { action: z.enum(["info", "get_user_info", "create", "update", "delete", "login_url", "login_params"]), user_id: OptionalIdSchema, identifier: z.string().optional(), identifier_type: z.string().optional(), platform_id: OptionalIdSchema, last_login_flag: z.boolean().optional(), body: JsonRecordSchema.optional() }
      },
      async (params) => {
        let response: ApiJsonResponse;
        const userId = normalizeOptionalId(params.user_id as IdLike | "" | undefined);
        switch (params.action) {
          case "info":
            response = await client.getEnterprise(`/v2/admin/user/${idToPath(requireId(userId, "user_id"))}/info`, { last_login_flag: params.last_login_flag as boolean | undefined });
            break;
          case "get_user_info":
            response = await client.getEnterprise("/v2/admin/user/get_user_info", { identifier: requireNonEmptyString(params.identifier, "identifier"), type: requireNonEmptyString(params.identifier_type, "identifier_type"), platform_id: String(requireId(params.platform_id as IdLike | "" | undefined, "platform_id")) });
            break;
          case "create":
            response = await client.postEnterprise("/v2/admin/user/create", requireJsonObject(params.body, "body"));
            break;
          case "update":
            response = await client.postEnterprise(`/v2/admin/user/${idToPath(requireId(userId, "user_id"))}/update`, requireJsonObject(params.body, "body"));
            break;
          case "delete":
            response = await client.postEnterprise(`/v2/admin/user/${idToPath(requireId(userId, "user_id"))}/delete`, requireJsonObject(params.body, "body"));
            break;
          case "login_url":
            response = await client.getEnterprise("/v2/admin/user/get_login_url", { identifier: requireNonEmptyString(params.identifier, "identifier"), type: requireNonEmptyString(params.identifier_type, "identifier_type"), platform_id: String(requireId(params.platform_id as IdLike | "" | undefined, "platform_id")) });
            break;
          default:
            response = await client.getEnterprise("/v2/admin/user/get_login_params", { identifier: requireNonEmptyString(params.identifier, "identifier"), type: requireNonEmptyString(params.identifier_type, "identifier_type"), platform_id: String(requireId(params.platform_id as IdLike | "" | undefined, "platform_id")) });
            break;
        }
        return ok(response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_admin_logs",
      {
        title: "Yifangyun Admin Logs",
        description: "Official admin log wrapper: action_type_info, log_info, log_list, log_list_paginated.",
        inputSchema: { action: z.enum(["action_type_info", "log_info", "log_list", "log_list_paginated"]), body: JsonRecordSchema.optional() }
      },
      async (params) => {
        const endpoint = params.action === "action_type_info"
          ? "/v2/admin/log/action_type_info"
          : params.action === "log_info"
            ? "/v2/admin/log/log_info"
            : params.action === "log_list"
              ? "/v2/admin/log/log_list"
              : "/v2/admin/log/log_list_by_pagination";
        const response = await client.postEnterprise(endpoint, requireJsonObject(params.body, "body"));
        return ok(response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );

    registerMutationTool(
      "yfy_admin_sync",
      {
        title: "Yifangyun Admin Sync",
        description: "Official admin platform sync wrapper: mapping_user/group/department and sync_users/groups/departments.",
        inputSchema: { action: z.enum(["mapping_user", "mapping_group", "mapping_department", "sync_users", "sync_groups", "sync_departments"]), platform_id: IdSchema, query_id: z.string().optional(), yfy_id: OptionalIdSchema, body: JsonRecordSchema.optional() }
      },
      async (params) => {
        const platformId = requireId(params.platform_id as IdLike | "" | undefined, "platform_id");
        let response: ApiJsonResponse;
        switch (params.action) {
          case "mapping_user":
            response = await client.getEnterprise(`/v2/admin/platform/${idToPath(platformId)}/mapping_user`, { user_id: requireNonEmptyString(params.query_id, "query_id"), yfy_user_id: String(requireId(params.yfy_id as IdLike | "" | undefined, "yfy_id")) });
            break;
          case "mapping_group":
            response = await client.getEnterprise(`/v2/admin/platform/${idToPath(platformId)}/mapping_group`, { group_id: requireNonEmptyString(params.query_id, "query_id"), yfy_group_id: String(requireId(params.yfy_id as IdLike | "" | undefined, "yfy_id")) });
            break;
          case "mapping_department":
            response = await client.getEnterprise(`/v2/admin/platform/${idToPath(platformId)}/mapping_department`, { department_id: requireNonEmptyString(params.query_id, "query_id"), yfy_department_id: String(requireId(params.yfy_id as IdLike | "" | undefined, "yfy_id")) });
            break;
          case "sync_users":
            response = await client.postEnterprise(`/v2/admin/platform/${idToPath(platformId)}/sync_users`, requireJsonObject(params.body, "body"));
            break;
          case "sync_groups":
            response = await client.postEnterprise(`/v2/admin/platform/${idToPath(platformId)}/sync_groups`, requireJsonObject(params.body, "body"));
            break;
          default:
            response = await client.postEnterprise(`/v2/admin/platform/${idToPath(platformId)}/sync_departments`, requireJsonObject(params.body, "body"));
            break;
        }
        return ok(response.data, metaToJson(response.meta), { config, raw: response.data });
      }
    );
  }
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asNumberOrString(value: IdLike): string | number {
  return typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : value;
}
