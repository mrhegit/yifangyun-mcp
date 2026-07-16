import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { arrayValue, objectValue, projectItem, projectUser, provenance } from "../domain/projectors.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonArray, JsonObject, JsonValue } from "../types.js";
import { registerTool } from "./tooling.js";
import { ItemSchema, ProvenanceSchema } from "./schemas.js";

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
    inputSchema: { name: z.string().trim().min(1).max(222), parent_folder_id: IdSchema, department_id: IdSchema.optional(), access_context: AccessContextSchema },
    outputSchema: { folder: ItemSchema, provenance: ProvenanceSchema }
  }, { readOnly: false, idempotent: false }, async ({ name, parent_folder_id, department_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const body: JsonObject = { name: String(name), parent_id: providerId(parent_folder_id) };
    if (department_id) body.department_id = providerId(department_id);
    const response = await runtime.gateway.postUser("/v2/folder/create", access.context.id, body, {}, extra.signal);
    return { folder: projectItem(response.data, "evidence"), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_item_mutate", {
    title: "Mutate Yifangyun Item",
    description: "Update, move, copy, trash, permanently delete, or restore a file or folder.",
    inputSchema: {
      action: z.enum(["update", "move", "copy", "trash", "delete_permanently", "restore"]),
      item_type: z.enum(["file", "folder"]),
      item_id: IdSchema,
      name: z.string().trim().min(1).max(222).optional(),
      description: z.string().max(140).optional(),
      target_folder_id: IdSchema.optional(),
      department_id: IdSchema.optional(),
      access_context: AccessContextSchema
    },
    outputSchema: { action: z.string(), success: z.boolean(), item: ItemSchema.optional(), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    const access = runtime.gateway.context(contextId(args.access_context));
    const type = String(args.item_type);
    const id = encodeURIComponent(String(args.item_id));
    let endpoint: string;
    let body: JsonObject = {};
    if (args.action === "update") {
      if (!args.name && args.description === undefined) throw new YifangyunError("name or description is required for update.", { code: "YFY_INPUT_INVALID", phase: "item_mutate" });
      endpoint = `/v2/${type}/${id}/update`;
      if (typeof args.name === "string") body.name = args.name;
      if (typeof args.description === "string") body.description = args.description;
    } else if (args.action === "move" || args.action === "copy") {
      if (!args.target_folder_id) throw new YifangyunError("target_folder_id is required for move or copy.", { code: "YFY_INPUT_INVALID", phase: "item_mutate" });
      endpoint = `/v2/${type}/${id}/${String(args.action)}`;
      body = { target_folder_id: providerId(args.target_folder_id) };
      if (type === "folder" && args.department_id) body.department_id = providerId(args.department_id);
    } else {
      const suffix = args.action === "trash" ? "delete" : args.action === "delete_permanently" ? "delete_from_trash" : "restore_from_trash";
      endpoint = `/v2/${type}/${id}/${suffix}`;
    }
    const response = await runtime.gateway.postUser(endpoint, access.context.id, body, {}, extra.signal);
    const projected = projectItem(response.data, "evidence");
    return { action: String(args.action), success: true, ...(Object.keys(projected).length ? { item: projected } : {}), provenance: provenance(response.meta, access.context.id) };
  });

  registerTool(server, "yfy_file_upload", {
    title: "Upload File To Yifangyun",
    description: "Upload a local file through an official presigned transfer URL, targeting a folder id or path.",
    inputSchema: {
      local_path: z.string().trim().min(1),
      parent_folder_id: IdSchema.optional(),
      target_folder_path: z.string().trim().min(1).optional(),
      department_id: IdSchema.optional(),
      name: z.string().trim().min(1).max(222).optional(),
      overwrite: z.boolean().default(false),
      access_context: AccessContextSchema
    },
    outputSchema: { uploaded: z.boolean(), file_name: z.string(), size_bytes: z.number().int().nonnegative(), delivery_method: z.string(), remote_status_code: z.number().int(), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    if ((!args.parent_folder_id && !args.target_folder_path) || (args.parent_folder_id && args.target_folder_path)) {
      throw new YifangyunError("Pass exactly one of parent_folder_id or target_folder_path.", { code: "YFY_INPUT_INVALID", phase: "file_upload" });
    }
    const access = runtime.gateway.context(contextId(args.access_context));
    const source = await openUploadSource(runtime, args.local_path);
    const fileName = typeof args.name === "string" ? args.name : path.basename(String(args.local_path));
    const body: JsonObject = { name: fileName, upload_type: "api", is_covered: args.overwrite === true };
    if (args.parent_folder_id) body.parent_id = providerId(args.parent_folder_id);
    if (args.target_folder_path) body.target_folder_path = String(args.target_folder_path);
    if (args.department_id) body.department_id = providerId(args.department_id);
    const endpoint = args.parent_folder_id ? "/v2/file/upload_v2" : "/v2/file/upload_by_path";
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
    inputSchema: { file_id: IdSchema, local_path: z.string().trim().min(1), name: z.string().trim().min(1).max(222).optional(), remark: z.string().max(500).optional(), access_context: AccessContextSchema },
    outputSchema: { uploaded: z.boolean(), delivery: z.object({ file_name: z.string(), size_bytes: z.number().int().nonnegative(), method: z.string(), status_code: z.number().int() }), current_file: ItemSchema, provenance: z.array(ProvenanceSchema) }
  }, { readOnly: false, idempotent: false }, async ({ file_id, local_path, name, remark, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    const source = await openUploadSource(runtime, local_path);
    const fileName = typeof name === "string" ? name : path.basename(String(local_path));
    try {
      const prepare = await runtime.gateway.postUser(`/v2/file/${encodeURIComponent(String(file_id))}/new_version_v2`, access.context.id, {
        name: fileName,
        upload_type: "api",
        ...(typeof remark === "string" ? { remark } : {})
      }, {}, extra.signal);
      const prepared = objectValue(prepare.data);
      if (!prepared || typeof prepared.presign_url !== "string") {
        throw new YifangyunError("Version upload endpoint did not return a transfer URL.", { code: "YFY_UPLOAD_TICKET_INVALID", phase: "version_upload" });
      }
      const delivered = await runtime.client.uploadLocalFileToPresignedUrl(prepared.presign_url, source, fileName, extra.signal);
      const current = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/info_v2`, access.context.id, {}, extra.signal);
      return {
        uploaded: true,
        delivery: { file_name: delivered.fileName, size_bytes: delivered.sizeBytes, method: delivered.deliveryMethod, status_code: delivered.remoteStatusCode },
        current_file: projectItem(current.data, "evidence"),
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
    inputSchema: { action: z.enum(["list_folder", "get"]), folder_id: IdSchema.optional(), collaboration_id: IdSchema.optional(), access_context: AccessContextSchema },
    outputSchema: { collaborations: z.array(z.object({ id: z.string().optional(), role: z.string().optional(), status: z.string().optional(), accessible_by: z.record(z.unknown()).optional() })), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ action, folder_id, collaboration_id, access_context }, extra) => {
    const access = runtime.gateway.context(contextId(access_context));
    if (action === "list_folder" && !folder_id) throw new YifangyunError("folder_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    if (action === "get" && !collaboration_id) throw new YifangyunError("collaboration_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_read" });
    const endpoint = action === "list_folder" ? `/v2/folder/${encodeURIComponent(String(folder_id))}/collabs` : `/v2/collab/${encodeURIComponent(String(collaboration_id))}/info`;
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
    inputSchema: {
      action: z.enum(["invite", "invite_batch", "update_role", "delete", "remove_batch"]),
      folder_id: IdSchema.optional(),
      collaboration_id: IdSchema.optional(),
      collaboration_ids: z.array(IdSchema).min(1).max(100).optional(),
      role: RoleSchema.optional(),
      target_type: z.enum(["user", "group", "department", "user_list", "group_list", "department_list"]).optional(),
      target_id: IdSchema.optional(),
      target_ids: z.array(IdSchema).min(1).max(100).optional(),
      targets: z.array(z.object({ type: z.enum(["user", "group", "department", "user_list", "group_list", "department_list"]), id: IdSchema.optional(), ids: z.array(IdSchema).optional(), role: RoleSchema })).max(100).optional(),
      invitation_message: z.string().max(140).optional(),
      access_context: AccessContextSchema
    },
    outputSchema: { action: z.string(), success: z.boolean(), collaboration: z.record(z.unknown()), provenance: ProvenanceSchema }
  }, { readOnly: false, destructive: true, idempotent: false }, async (args, extra) => {
    const access = runtime.gateway.context(contextId(args.access_context));
    let endpoint: string;
    let body: JsonObject;
    if (args.action === "invite" || args.action === "invite_batch") {
      if (!args.folder_id) throw new YifangyunError("folder_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
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
      body = { folder_id: providerId(args.folder_id), accessible_by: accessibleBy, ...(typeof args.invitation_message === "string" ? { invitation_message: args.invitation_message } : {}) };
    } else if (args.action === "update_role") {
      if (!args.collaboration_id || !args.role) throw new YifangyunError("collaboration_id and role are required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = `/v2/collab/${encodeURIComponent(String(args.collaboration_id))}/update`;
      body = { role: String(args.role) };
    } else if (args.action === "delete") {
      if (!args.collaboration_id) throw new YifangyunError("collaboration_id is required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = `/v2/collab/${encodeURIComponent(String(args.collaboration_id))}/delete`;
      body = {};
    } else {
      if (!args.folder_id || !Array.isArray(args.collaboration_ids)) throw new YifangyunError("folder_id and collaboration_ids are required.", { code: "YFY_INPUT_INVALID", phase: "collaboration_mutate" });
      endpoint = "/v2/collab/remove";
      body = { folder_id: providerId(args.folder_id), collab_ids: args.collaboration_ids.map(providerId) as JsonArray };
    }
    const response = await runtime.gateway.postUser(endpoint, access.context.id, body, {}, extra.signal);
    return { action: String(args.action), success: true, collaboration: projectCollab(response.data), provenance: provenance(response.meta, access.context.id) };
  });
}
