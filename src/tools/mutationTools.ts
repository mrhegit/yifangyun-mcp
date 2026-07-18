import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { formatItemRef, parseItemRef } from "../domain/refs.js";
import { arrayValue, objectValue, projectItem, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonArray, JsonObject, JsonValue } from "../types.js";
import { registerTool } from "./tooling.js";
import { FileRefSchema, FolderRefSchema, ItemRefSchema, ItemSchema, ProvenanceSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);
const AccessContextSchema = z.string().trim().min(1).optional();
const RoleSchema = z.enum(["coowner", "editor", "online_collaborator", "viewer_uploader", "viewer", "previewer_uploader", "previewer", "uploader", "reset"]);

function contextId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerId(value: unknown): string | number {
  const text = String(value);
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : text;
}

function resolveBoundRef(runtime: AppRuntime, value: unknown, expectedType?: "file" | "folder") {
  const item = parseItemRef(String(value));
  if (expectedType && item.type !== expectedType) throw new YifangyunError(`A ${expectedType} ref is required.`, { code: "YFY_INPUT_INVALID", phase: "item_reference" });
  const access = runtime.gateway.context(item.accessContextId);
  if (access.identityRef !== item.identityRef) throw new YifangyunError("Item ref belongs to a different configured identity.", { code: "YFY_REF_IDENTITY_MISMATCH", phase: "item_reference" });
  return { access, item, ref: String(value) };
}

function boundItem(value: JsonValue | undefined, access: ReturnType<AppRuntime["gateway"]["context"]>): JsonObject {
  const item = projectItem(value, "evidence");
  return typeof item.id === "string" && (item.type === "file" || item.type === "folder")
    ? { ...item, ref: formatItemRef(item.type, item.id, access.context.id, access.identityRef) }
    : item;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function openUploadSource(runtime: AppRuntime, value: unknown): Promise<FileHandle> {
  const root = runtime.config.uploadRootDir;
  if (!root) {
    throw new YifangyunError("Local upload is disabled until YFY_UPLOAD_ROOT_DIR is configured.", { code: "YFY_LOCAL_UPLOAD_DISABLED", phase: "upload_source" });
  }
  let realRoot: string;
  let resolved: string;
  try {
    [realRoot, resolved] = await Promise.all([fs.realpath(root), fs.realpath(path.resolve(String(value)))]);
  } catch {
    throw new YifangyunError("The configured upload root or local_path is unavailable.", { code: "YFY_UPLOAD_SOURCE_INVALID", phase: "upload_source" });
  }
  if (!pathIsWithin(realRoot, resolved)) {
    throw new YifangyunError("local_path is outside the configured upload root.", { code: "YFY_UPLOAD_SOURCE_OUT_OF_SCOPE", phase: "upload_source" });
  }
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(resolved, "r");
    const [currentResolved, handleStat] = await Promise.all([
      fs.realpath(path.resolve(String(value))),
      handle.stat({ bigint: true })
    ]);
    if (!pathIsWithin(realRoot, currentResolved)) {
      throw new YifangyunError("local_path moved outside the configured upload root.", { code: "YFY_UPLOAD_SOURCE_OUT_OF_SCOPE", phase: "upload_source" });
    }
    const currentStat = await fs.stat(currentResolved, { bigint: true });
    if (!handleStat.isFile() || !currentStat.isFile() || handleStat.dev !== currentStat.dev || handleStat.ino !== currentStat.ino) {
      throw new YifangyunError("local_path changed while the upload source was being opened.", { code: "YFY_UPLOAD_SOURCE_CHANGED", phase: "upload_source" });
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof YifangyunError) throw error;
    throw new YifangyunError("The local upload source could not be opened safely.", { code: "YFY_UPLOAD_SOURCE_INVALID", phase: "upload_source" });
  }
}

function projectCollab(value: JsonValue | undefined): JsonObject {
  const source = objectValue(value);
  if (!source) return {};
  return {
    ...(source.id !== undefined ? { id: String(source.id) } : {}),
    ...(typeof source.role === "string" ? { role: source.role } : {}),
    ...(typeof source.status === "string" ? { status: source.status } : {}),
    ...(Object.keys(projectUser(source.accessible_by ?? source.user, false)).length ? { accessible_by: projectUser(source.accessible_by ?? source.user, false) } : {})
  };
}

const CollaborationReadSchema = z.object({
  action: z.enum(["list_folder", "get"]),
  folder: FolderRefSchema.optional(),
  collaboration_id: IdSchema.optional(),
  access_context: AccessContextSchema
}).strict().superRefine((value, context) => {
  if (value.action === "list_folder") {
    if (!value.folder) context.addIssue({ code: z.ZodIssueCode.custom, path: ["folder"], message: "folder is required for list_folder." });
    if (value.collaboration_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["collaboration_id"], message: "collaboration_id is not valid for list_folder." });
    if (value.access_context) context.addIssue({ code: z.ZodIssueCode.custom, path: ["access_context"], message: "The folder ref already selects the access identity." });
  } else {
    if (!value.collaboration_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["collaboration_id"], message: "collaboration_id is required for get." });
    if (value.folder) context.addIssue({ code: z.ZodIssueCode.custom, path: ["folder"], message: "folder is not valid for get." });
  }
});

const CollaborationMutateSchema = z.object({
  action: z.enum(["invite", "invite_batch", "update_role", "delete", "remove_batch"]),
  folder: FolderRefSchema.optional(),
  collaboration_id: IdSchema.optional(),
  collaboration_ids: z.array(IdSchema).min(1).max(100).optional(),
  role: RoleSchema.optional(),
  target_type: z.enum(["user", "group", "department", "user_list", "group_list", "department_list"]).optional(),
  target_id: IdSchema.optional(),
  target_ids: z.array(IdSchema).min(1).max(100).optional(),
  targets: z.array(z.object({ type: z.enum(["user", "group", "department", "user_list", "group_list", "department_list"]), id: IdSchema.optional(), ids: z.array(IdSchema).optional(), role: RoleSchema }).strict()).max(100).optional(),
  invitation_message: z.string().max(140).optional(),
  access_context: AccessContextSchema
}).strict().superRefine((value, context) => {
  const folderAction = ["invite", "invite_batch", "remove_batch"].includes(value.action);
  if (folderAction && !value.folder) context.addIssue({ code: z.ZodIssueCode.custom, path: ["folder"], message: `folder is required for ${value.action}.` });
  if (folderAction && value.access_context) context.addIssue({ code: z.ZodIssueCode.custom, path: ["access_context"], message: "The folder ref already selects the access identity." });
  if (!folderAction && value.folder) context.addIssue({ code: z.ZodIssueCode.custom, path: ["folder"], message: `folder is not valid for ${value.action}.` });
  if (["update_role", "delete"].includes(value.action) && !value.collaboration_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["collaboration_id"], message: `collaboration_id is required for ${value.action}.` });
  if (value.action === "update_role" && !value.role) context.addIssue({ code: z.ZodIssueCode.custom, path: ["role"], message: "role is required for update_role." });
  if (value.action === "remove_batch" && !value.collaboration_ids) context.addIssue({ code: z.ZodIssueCode.custom, path: ["collaboration_ids"], message: "collaboration_ids is required for remove_batch." });
  if (value.action === "invite" && (!value.target_type || !value.role || (!value.target_id && !value.target_ids))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["target_type"], message: "target_type, role and target_id or target_ids are required for invite." });
  if (value.action === "invite_batch" && (!value.targets || value.targets.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["targets"], message: "targets is required for invite_batch." });
});

export function registerMutationTools(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("mutation")) {
    registerDriveMutationTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("collaboration")) {
    registerCollaborationTools(server, runtime);
  }
}

function registerDriveMutationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_folder_create", {
    title: "Create Yifangyun Folder",
    description: "Create a folder under an existing folder or department root.",
    inputSchema: { name: z.string().trim().min(1).max(222), parent: FolderRefSchema, department_id: IdSchema.optional() },
    outputSchema: { folder: ItemSchema.extend({ ref: FolderRefSchema }), provenance: ProvenanceSchema }
  }, { readOnly: false, idempotent: false }, async ({ name, parent, department_id }, extra) => {
    const resolved = resolveBoundRef(runtime, parent, "folder");
    const body: JsonObject = { name: String(name), parent_id: providerId(resolved.item.id) };
    if (department_id) body.department_id = providerId(department_id);
    const response = await runtime.gateway.postUser("/v2/folder/create", resolved.access.context.id, body, {}, extra.signal);
    return { folder: boundItem(response.data, resolved.access), provenance: provenance(response.meta, resolved.access.context.id, "folder_create") };
  });

  registerTool(server, "yfy_item_mutate", {
    title: "Mutate Yifangyun Item",
    description: "Update, move, copy, trash, permanently delete, or restore a file or folder.",
    inputSchema: {
      action: z.enum(["update", "move", "copy", "trash", "delete_permanently", "restore"]),
      item: ItemRefSchema,
      name: z.string().trim().min(1).max(222).optional(),
      description: z.string().max(140).optional(),
      target: FolderRefSchema.optional(),
      department_id: IdSchema.optional(),
    },
    outputSchema: { action: z.string(), success: z.boolean(), item: ItemSchema.extend({ ref: ItemRefSchema }).optional(), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    const resolved = resolveBoundRef(runtime, args.item);
    const type = resolved.item.type;
    const id = encodeURIComponent(resolved.item.id);
    let endpoint: string;
    let body: JsonObject = {};
    if (args.action === "update") {
      if (!args.name && args.description === undefined) throw new YifangyunError("name or description is required for update.", { code: "YFY_INPUT_INVALID", phase: "item_mutate" });
      endpoint = `/v2/${type}/${id}/update`;
      if (typeof args.name === "string") body.name = args.name;
      if (typeof args.description === "string") body.description = args.description;
    } else if (args.action === "move" || args.action === "copy") {
      if (!args.target) throw new YifangyunError("target is required for move or copy.", { code: "YFY_INPUT_INVALID", phase: "item_mutate" });
      const target = resolveBoundRef(runtime, args.target, "folder");
      if (target.access.context.id !== resolved.access.context.id || target.access.identityRef !== resolved.access.identityRef) throw new YifangyunError("Source and target refs belong to different access identities.", { code: "YFY_REF_CONTEXT_CONFLICT", phase: "item_mutate" });
      endpoint = `/v2/${type}/${id}/${String(args.action)}`;
      body = { target_folder_id: providerId(target.item.id) };
      if (type === "folder" && args.department_id) body.department_id = providerId(args.department_id);
    } else {
      const suffix = args.action === "trash" ? "delete" : args.action === "delete_permanently" ? "delete_from_trash" : "restore_from_trash";
      endpoint = `/v2/${type}/${id}/${suffix}`;
    }
    const response = await runtime.gateway.postUser(endpoint, resolved.access.context.id, body, {}, extra.signal);
    const projected = boundItem(response.data, resolved.access);
    return { action: String(args.action), success: true, ...(Object.keys(projected).length ? { item: projected } : {}), provenance: provenance(response.meta, resolved.access.context.id, `item_${String(args.action)}`) };
  });

  registerTool(server, "yfy_file_upload", {
    title: "Upload File To Yifangyun",
    description: "Upload a local file through an official presigned transfer URL, targeting a folder id or path.",
    inputSchema: {
      local_path: z.string().trim().min(1),
      parent: FolderRefSchema.optional(),
      target_folder_path: z.string().trim().min(1).optional(),
      department_id: IdSchema.optional(),
      name: z.string().trim().min(1).max(222).optional(),
      overwrite: z.boolean().default(false),
      access_context: AccessContextSchema
    },
    outputSchema: { uploaded: z.boolean(), file_name: z.string(), size_bytes: z.number().int().nonnegative(), delivery_method: z.string(), remote_status_code: z.number().int(), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    if ((!args.parent && !args.target_folder_path) || (args.parent && args.target_folder_path)) {
      throw new YifangyunError("Pass exactly one of parent or target_folder_path.", { code: "YFY_INPUT_INVALID", phase: "file_upload" });
    }
    const parent = args.parent ? resolveBoundRef(runtime, args.parent, "folder") : undefined;
    if (parent && args.access_context && args.access_context !== parent.access.context.id) throw new YifangyunError("access_context conflicts with the parent folder ref.", { code: "YFY_REF_CONTEXT_CONFLICT", phase: "file_upload" });
    const access = parent?.access ?? runtime.gateway.context(contextId(args.access_context));
    const source = await openUploadSource(runtime, args.local_path);
    const fileName = typeof args.name === "string" ? args.name : path.basename(String(args.local_path));
    const body: JsonObject = { name: fileName, upload_type: "api", is_covered: args.overwrite === true };
    if (parent) body.parent_id = providerId(parent.item.id);
    if (args.target_folder_path) body.target_folder_path = String(args.target_folder_path);
    if (args.department_id) body.department_id = providerId(args.department_id);
    const endpoint = parent ? "/v2/file/upload_v2" : "/v2/file/upload_by_path";
    try {
      const prepare = await runtime.gateway.postUser(endpoint, access.context.id, body, {}, extra.signal);
      const prepared = objectValue(prepare.data);
      if (!prepared || typeof prepared.presign_url !== "string") {
        throw new YifangyunError("Upload prepare endpoint did not return a transfer URL.", { code: "YFY_UPLOAD_TICKET_INVALID", phase: "file_upload" });
      }
      const delivered = await runtime.client.uploadLocalFileToPresignedUrl(prepared.presign_url, source, fileName, extra.signal);
      return {
        uploaded: true,
        file_name: delivered.fileName,
        size_bytes: delivered.sizeBytes,
        delivery_method: delivered.deliveryMethod,
        remote_status_code: delivered.remoteStatusCode,
        provenance: provenance(prepare.meta, access.context.id)
      };
    } finally {
      await source.close().catch(() => undefined);
    }
  });

  registerTool(server, "yfy_file_version_upload", {
    title: "Upload Yifangyun File Version",
    description: "Upload a local file as a new version of an existing Yifangyun file.",
    inputSchema: { file: FileRefSchema, local_path: z.string().trim().min(1), name: z.string().trim().min(1).max(222).optional(), remark: z.string().max(500).optional() },
    outputSchema: { uploaded: z.boolean(), delivery: z.object({ file_name: z.string(), size_bytes: z.number().int().nonnegative(), method: z.string(), status_code: z.number().int() }), current_file: ItemSchema.extend({ ref: FileRefSchema }), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: false, idempotent: false }, async ({ file, local_path, name, remark }, extra) => {
    const resolved = resolveBoundRef(runtime, file, "file");
    const access = resolved.access;
    const source = await openUploadSource(runtime, local_path);
    const fileName = typeof name === "string" ? name : path.basename(String(local_path));
    try {
      const prepare = await runtime.gateway.postUser(`/v2/file/${encodeURIComponent(resolved.item.id)}/new_version_v2`, access.context.id, {
        name: fileName,
        upload_type: "api",
        ...(typeof remark === "string" ? { remark } : {})
      }, {}, extra.signal);
      const prepared = objectValue(prepare.data);
      if (!prepared || typeof prepared.presign_url !== "string") {
        throw new YifangyunError("Version upload endpoint did not return a transfer URL.", { code: "YFY_UPLOAD_TICKET_INVALID", phase: "version_upload" });
      }
      const delivered = await runtime.client.uploadLocalFileToPresignedUrl(prepared.presign_url, source, fileName, extra.signal);
      const current = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(resolved.item.id)}/info_v2`, access.context.id, {}, extra.signal);
      return {
        uploaded: true,
        delivery: { file_name: delivered.fileName, size_bytes: delivered.sizeBytes, method: delivered.deliveryMethod, status_code: delivered.remoteStatusCode },
        current_file: boundItem(current.data, access),
        provenance: [provenance(prepare.meta, access.context.id), provenance(current.meta, access.context.id)]
      };
    } finally {
      await source.close().catch(() => undefined);
    }
  });
}

function registerCollaborationTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_collaboration_read", {
    title: "Read Yifangyun Collaborations",
    description: "List folder collaboration members or get one collaboration record.",
    inputSchema: CollaborationReadSchema,
    outputSchema: { collaborations: z.array(z.object({ id: z.string().optional(), role: z.string().optional(), status: z.string().optional(), accessible_by: z.record(z.unknown()).optional() })), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ action, folder, collaboration_id, access_context }, extra) => {
    if (action === "get" && folder) throw new YifangyunError("folder is not valid for get.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    if (action === "list_folder" && access_context) throw new YifangyunError("The folder ref already selects the access identity.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    const resolvedFolder = folder ? resolveBoundRef(runtime, folder, "folder") : undefined;
    const access = resolvedFolder?.access ?? runtime.gateway.context(contextId(access_context));
    if (action === "list_folder" && !resolvedFolder) throw new YifangyunError("folder is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    if (action === "get" && !collaboration_id) throw new YifangyunError("collaboration_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    const endpoint = action === "list_folder" ? `/v2/folder/${encodeURIComponent(resolvedFolder!.item.id)}/collabs` : `/v2/collab/${encodeURIComponent(String(collaboration_id))}/info`;
    const response = await runtime.gateway.getUser(endpoint, access.context.id, {}, extra.signal);
    const source = objectValue(response.data) ?? {};
    const collaborations = action === "get"
      ? [projectCollab(response.data)]
      : [...arrayValue(source.collabs), ...arrayValue(source.items)].map(projectCollab);
    return { collaborations: collaborations.filter((entry) => Object.keys(entry).length > 0), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_collaboration_mutate", {
    title: "Mutate Yifangyun Collaboration",
    description: "Invite, update, delete, or batch-remove folder collaborations.",
    inputSchema: CollaborationMutateSchema,
    outputSchema: { action: z.string(), success: z.boolean(), collaboration: z.record(z.unknown()), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    const folderAction = ["invite", "invite_batch", "remove_batch"].includes(String(args.action));
    if (!folderAction && args.folder) throw new YifangyunError(`folder is not valid for ${String(args.action)}.`, { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
    if (folderAction && args.access_context) throw new YifangyunError("The folder ref already selects the access identity.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
    const resolvedFolder = args.folder ? resolveBoundRef(runtime, args.folder, "folder") : undefined;
    const access = resolvedFolder?.access ?? runtime.gateway.context(contextId(args.access_context));
    let endpoint: string;
    let body: JsonObject;
    if (args.action === "invite" || args.action === "invite_batch") {
      if (!resolvedFolder) throw new YifangyunError("folder is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      if (args.action === "invite" && (!args.target_type || !args.role || (!args.target_id && !Array.isArray(args.target_ids)))) {
        throw new YifangyunError("target_type, role and target_id or target_ids are required for invite.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      }
      if (args.action === "invite_batch" && (!Array.isArray(args.targets) || args.targets.length === 0)) {
        throw new YifangyunError("targets is required for invite_batch.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      }
      endpoint = args.action === "invite" ? "/v2/collab/invite" : "/v2/collab/invite_batch";
      const accessibleBy: JsonValue = args.action === "invite"
        ? { type: String(args.target_type), ...(args.target_id ? { id: providerId(args.target_id) } : {}), ...(Array.isArray(args.target_ids) ? { ids: args.target_ids.map(providerId) as JsonArray } : {}), role: String(args.role) }
        : (args.targets as JsonArray ?? []);
      body = { folder_id: providerId(resolvedFolder.item.id), accessible_by: accessibleBy, ...(typeof args.invitation_message === "string" ? { invitation_message: args.invitation_message } : {}) };
    } else if (args.action === "update_role") {
      if (!args.collaboration_id || !args.role) throw new YifangyunError("collaboration_id and role are required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = `/v2/collab/${encodeURIComponent(String(args.collaboration_id))}/update`;
      body = { role: String(args.role) };
    } else if (args.action === "delete") {
      if (!args.collaboration_id) throw new YifangyunError("collaboration_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = `/v2/collab/${encodeURIComponent(String(args.collaboration_id))}/delete`;
      body = {};
    } else {
      if (!resolvedFolder || !Array.isArray(args.collaboration_ids)) throw new YifangyunError("folder and collaboration_ids are required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = "/v2/collab/remove";
      body = { folder_id: providerId(resolvedFolder.item.id), collab_ids: args.collaboration_ids.map(providerId) as JsonArray };
    }
    const response = await runtime.gateway.postUser(endpoint, access.context.id, body, {}, extra.signal);
    return { action: String(args.action), success: true, collaboration: projectCollab(response.data), provenance: provenance(response.meta, access.context.id) };
  });
}
