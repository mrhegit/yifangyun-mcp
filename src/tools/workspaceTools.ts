import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { idValue, objectValue, projectDepartment, projectItem, provenance } from "../domain/projectors.js";
import { formatItemRef, parseItemRef } from "../domain/refs.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { CheckStatusSchema, FileRefSchema, FolderRefSchema, ItemSchema, PathEntrySchema, ProvenanceSchema, WorkspaceRefSchema } from "./schemas.js";

type MembershipStatus = "inside" | "outside" | "unavailable";

type MembershipAgentInterpretation = {
  may_claim_inside: boolean;
  may_claim_outside: boolean;
  may_download: boolean;
  narrative: string;
  next_steps: string[];
};

type MembershipProof = {
  ancestorIds: string[];
  status: MembershipStatus;
  reason: string;
  agent_interpretation: MembershipAgentInterpretation;
  observed_file_space?: JsonObject;
  observed_root_space?: JsonObject;
};

function spaceIdPresent(space: JsonObject | undefined): string | undefined {
  const id = space?.id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  return undefined;
}

function spaceTypePresent(space: JsonObject | undefined): "collaboration" | "department" | "personal" | undefined {
  if (typeof space?.type !== "string") return undefined;
  const value = space.type.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (value.includes("personal") || value === "private") return "personal";
  if (value.includes("department") || value.includes("enterprise") || value === "dept") return "department";
  if (value.includes("collab") || value.includes("share")) return "collaboration";
  return undefined;
}

function membershipUnavailableNextSteps(reason: string): string[] {
  switch (reason) {
    case "missing_ancestor_chain":
      return [
        "Do not re-run yfy_membership_check on the same file ref; missing ancestry will not become path proof by retry.",
        "Rediscover the file from the workspace with yfy_browse or yfy_resolve to obtain a path-backed ref.",
        "Only re-check membership or call yfy_download after you have a newly discovered workspace-path ref."
      ];
    case "incomplete_space_metadata":
      return [
        "Do not claim inside or outside, and do not assert outside from incomplete space metadata.",
        "Call yfy_get on the file (and workspace root if needed) to inspect space metadata.",
        "Rediscover from the workspace with yfy_browse/yfy_resolve; only check/download with a newly path-backed ref."
      ];
    case "same_space_path_inconclusive":
      return [
        "Do not claim inside or outside from an inconclusive same-space path.",
        "Resolve the exact relative path under the workspace root with yfy_resolve, or browse the parent directory with yfy_browse.",
        "Only check membership or download after the path under the configured root is proven."
      ];
    case "conflicting_membership_signals":
      return [
        "Stop automatic download; path and storage-space signals conflict.",
        "Preserve the membership diagnostics for human review.",
        "Do not claim inside or outside until the conflict is resolved with a new path-backed discovery."
      ];
    default:
      return [
        "Do not claim the file is inside or outside the workspace.",
        "Resolve the file via a path under the workspace root, or browse from the workspace to obtain a path-backed ref.",
        "Retry after the Provider exposes a complete ancestry chain or space metadata."
      ];
  }
}

function buildMembershipInterpretation(status: MembershipStatus, reason: string): MembershipAgentInterpretation {
  if (status === "inside") {
    return {
      may_claim_inside: true,
      may_claim_outside: false,
      may_download: true,
      narrative: "The file is inside the configured workspace root (path or parent folder hit the root).",
      next_steps: ["You may call yfy_download with this workspace and file ref.", "Optional yfy_download_release after host-side parsing; TTL also cleans up."]
    };
  }
  if (status === "outside") {
    return {
      may_claim_inside: false,
      may_claim_outside: true,
      may_download: false,
      narrative: reason === "different_space_id"
        ? "The file belongs to a different storage space id than the workspace root."
        : "The file belongs to a different storage space type than the workspace root (for example personal vs department).",
      next_steps: [
        "Do not claim this file is inside the workspace.",
        "Do not call yfy_download with this workspace for this file.",
        "Discover the file from the target workspace (browse/resolve) before download."
      ]
    };
  }
  const narratives: Record<string, string> = {
    conflicting_membership_signals: "Provider path and storage-space metadata conflict, so membership is unsafe to claim in either direction.",
    missing_ancestor_chain: "Provider metadata does not include a path that reaches the workspace root; membership is unproven. Do not treat this as outside or inside.",
    incomplete_space_metadata: "Space metadata is incomplete on the file and/or workspace root, so outside/inside cannot be decided.",
    same_space_path_inconclusive: "File and workspace appear to share a space, but the path does not prove the file is under the configured root."
  };
  return {
    may_claim_inside: false,
    may_claim_outside: false,
    may_download: false,
    narrative: narratives[reason] ?? "Workspace membership could not be proven from Provider metadata. Do not claim inside or outside.",
    next_steps: membershipUnavailableNextSteps(reason)
  };
}

export function workspaceMembershipProof(file: JsonObject, rootFolder: JsonObject, rootFolderId: string): MembershipProof {
  const chain = Array.isArray(file.provider_path_chain) ? file.provider_path_chain : [];
  const ancestorIds = chain.flatMap((entry) => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry.id === "string") {
      return [entry.id];
    }
    return [];
  });
  const fileSpace = objectValue(file.space);
  const rootSpace = objectValue(rootFolder.space);
  const observed = {
    ...(fileSpace ? { observed_file_space: fileSpace } : {}),
    ...(rootSpace ? { observed_root_space: rootSpace } : {})
  };

  const pathInside = ancestorIds.includes(rootFolderId) || file.parent_folder_id === rootFolderId;
  const fileSpaceId = spaceIdPresent(fileSpace);
  const rootSpaceId = spaceIdPresent(rootSpace);
  const fileSpaceType = spaceTypePresent(fileSpace);
  const rootSpaceType = spaceTypePresent(rootSpace);
  const differentSpaceId = fileSpaceId !== undefined && rootSpaceId !== undefined && fileSpaceId !== rootSpaceId;
  const sameSpaceId = fileSpaceId !== undefined && rootSpaceId !== undefined && fileSpaceId === rootSpaceId;
  const differentKnownSpaceType = fileSpaceType !== undefined && rootSpaceType !== undefined && fileSpaceType !== rootSpaceType;

  if ((pathInside && (differentSpaceId || differentKnownSpaceType)) || (sameSpaceId && differentKnownSpaceType)) {
    const reason = "conflicting_membership_signals";
    return { ancestorIds, status: "unavailable", reason, agent_interpretation: buildMembershipInterpretation("unavailable", reason), ...observed };
  }

  if (pathInside) {
    const reason = "path_or_parent_hit_root";
    return { ancestorIds, status: "inside", reason, agent_interpretation: buildMembershipInterpretation("inside", reason), ...observed };
  }

  if (differentSpaceId) {
    const reason = "different_space_id";
    return { ancestorIds, status: "outside", reason, agent_interpretation: buildMembershipInterpretation("outside", reason), ...observed };
  }

  if ((fileSpaceId === undefined || rootSpaceId === undefined) && differentKnownSpaceType) {
    const reason = "different_space_type";
    return { ancestorIds, status: "outside", reason, agent_interpretation: buildMembershipInterpretation("outside", reason), ...observed };
  }

  // 4. unavailable + reason
  let reason: string;
  if (fileSpaceId !== undefined && rootSpaceId !== undefined && fileSpaceId === rootSpaceId) {
    reason = "same_space_path_inconclusive";
  } else if (fileSpaceType !== undefined && rootSpaceType !== undefined && fileSpaceType === rootSpaceType) {
    reason = "same_space_path_inconclusive";
  } else if (ancestorIds.length === 0) {
    reason = "missing_ancestor_chain";
  } else if (fileSpaceId === undefined || rootSpaceId === undefined || fileSpaceType === undefined || rootSpaceType === undefined) {
    reason = "incomplete_space_metadata";
  } else {
    reason = "same_space_path_inconclusive";
  }
  return { ancestorIds, status: "unavailable", reason, agent_interpretation: buildMembershipInterpretation("unavailable", reason), ...observed };
}

function membershipDiagnostics(membership: MembershipProof, extra: JsonObject = {}): JsonObject {
  const interpretation = membership.agent_interpretation;
  return {
    reason: membership.reason,
    ...(membership.observed_file_space ? { observed_file_space: membership.observed_file_space } : {}),
    ...(membership.observed_root_space ? { observed_root_space: membership.observed_root_space } : {}),
    observed_ancestor_folder_ids: membership.ancestorIds,
    agent_interpretation: {
      may_claim_inside: interpretation.may_claim_inside,
      may_claim_outside: interpretation.may_claim_outside,
      may_download: interpretation.may_download,
      narrative: interpretation.narrative,
      next_steps: [...interpretation.next_steps]
    },
    ...extra
  };
}

function canDowngradeCheckToUnavailable(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  return error instanceof YifangyunError && error.code === "YFY_PROVIDER_HTTP_ERROR" && [400, 404, 422].includes(error.statusCode ?? 0);
}

function workspaceRelativeAncestors(file: JsonObject, rootFolderId: string): JsonObject[] {
  const chain = Array.isArray(file.provider_path_chain) ? file.provider_path_chain : [];
  const rootIndex = chain.findIndex((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.id === rootFolderId);
  return rootIndex >= 0 ? chain.slice(rootIndex + 1) as JsonObject[] : [];
}

const MEDIA_TYPE_ALIASES: Record<string, string> = {
  "application/excel": "application/vnd.ms-excel",
  "application/msexcel": "application/vnd.ms-excel",
  "application/x-excel": "application/vnd.ms-excel",
  "application/x-msexcel": "application/vnd.ms-excel",
  "application/mspowerpoint": "application/vnd.ms-powerpoint",
  "application/powerpoint": "application/vnd.ms-powerpoint",
  "application/x-mspowerpoint": "application/vnd.ms-powerpoint",
  "application/word": "application/msword",
  "application/x-msword": "application/msword"
};

/** 扩展名 → media type（content-type / magic 均不可用时回退） */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};

type MediaTypeSource = "content_type" | "magic_sniff" | "file_extension" | "octet_stream";

const STRONG_MAGIC_MEDIA_TYPES = new Set(["application/pdf", "application/zip", "image/jpeg", "image/png"]);

function isSpecificZipContainerMediaType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && (
    mediaType.includes("openxmlformats-officedocument")
    || mediaType.includes("macroenabled")
    || mediaType.includes("oasis.opendocument")
    || mediaType.endsWith("+zip")
  );
}

function normalizeSingleMediaType(value: unknown): string | undefined {
  const mediaType = typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) return undefined;
  return MEDIA_TYPE_ALIASES[mediaType] ?? mediaType;
}

function mediaTypeFromFileName(fileName: unknown): string | undefined {
  if (typeof fileName !== "string" || fileName.length === 0) return undefined;
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXTENSION_MEDIA_TYPES[ext];
}

/**
 * 强 magic 优先于响应头；弱文本嗅探只在响应头无类型时使用。
 */
export function resolveMediaType(contentType: unknown, detectedContentType: unknown, fileName?: unknown): { media_type: string; media_type_source: MediaTypeSource } {
  const providerType = normalizeSingleMediaType(contentType);
  const detected = normalizeSingleMediaType(detectedContentType);
  const fromName = mediaTypeFromFileName(fileName);
  if (detected === "application/zip") {
    if (isSpecificZipContainerMediaType(providerType)) {
      return { media_type: providerType!, media_type_source: "content_type" };
    }
    if (isSpecificZipContainerMediaType(fromName)) {
      return { media_type: fromName!, media_type_source: "file_extension" };
    }
  }
  if (detected && STRONG_MAGIC_MEDIA_TYPES.has(detected)) {
    return { media_type: detected, media_type_source: "magic_sniff" };
  }
  if (providerType && providerType !== "application/octet-stream") {
    return { media_type: providerType, media_type_source: "content_type" };
  }
  if (detected && detected !== "application/octet-stream") {
    return { media_type: detected, media_type_source: "magic_sniff" };
  }
  if (fromName) {
    return { media_type: fromName, media_type_source: "file_extension" };
  }
  return { media_type: "application/octet-stream", media_type_source: "octet_stream" };
}

export function normalizedMediaType(contentType: unknown, detectedContentType: unknown, fileName?: unknown): string {
  return resolveMediaType(contentType, detectedContentType, fileName).media_type;
}

async function getScopedFile(runtime: AppRuntime, fileRef: string, workspaceRef: string, signal?: AbortSignal) {
  const item = parseItemRef(fileRef);
  if (item.type !== "file") throw new YifangyunError("A file ref is required.", { code: "YFY_INPUT_INVALID", phase: "workspace_membership" });
  const scope = runtime.access.resolveWorkspaceRef(workspaceRef);
  if (item.accessContextId !== scope.context.id || item.identityRef !== scope.identityRef) {
    throw new YifangyunError("File and workspace refs belong to different access identities.", {
      code: "YFY_REF_CONTEXT_CONFLICT",
      phase: "workspace_membership",
      suggestedAction: "Discover the file from the same workspace before checking membership or downloading."
    });
  }
  const fileId = item.id;
  const [response, rootResponse] = await Promise.all([
    runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/info_v2`, scope.context.id, scope.context.externalEnterpriseId
      ? { external_enterprise_id: scope.context.externalEnterpriseId }
      : {}, signal),
    runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(scope.scope.rootFolderId)}/info`, scope.context.id, {}, signal)
  ]);
  const file = projectItem(response.data, "verification");
  const rootFolder = projectItem(rootResponse.data, "verification");
  const membership = workspaceMembershipProof(file, rootFolder, scope.scope.rootFolderId);
  return { file, fileId, fileRef, membership, response, rootResponse, scope };
}

export function registerWorkspaceTools(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("workspace")) {
    registerAuthorityTools(server, runtime);
  }
}

function registerAuthorityTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_workspace_validate", {
    title: "Validate Yifangyun Workspace",
    description: "Validate one configured workspace with explicit pass, fail, or unavailable checks.",
    inputSchema: { workspace: WorkspaceRefSchema, expected_path: z.array(z.string().trim().min(1)).optional() },
    outputSchema: {
      workspace: z.object({ ref: WorkspaceRefSchema, root: FolderRefSchema, access_context: z.string(), tags: z.array(z.string()) }).strict(),
      folder: ItemSchema.extend({ ref: FolderRefSchema }),
      business_path: z.array(z.string()),
      department_chain: z.array(z.record(z.unknown())),
      checks: z.object({ exists: CheckStatusSchema, not_deleted: CheckStatusSchema, first_page_reachable: CheckStatusSchema, last_page_reachable: CheckStatusSchema, department_chain_complete: CheckStatusSchema, expected_path_matches: CheckStatusSchema.optional() }).strict(),
      verdict: z.enum(["valid", "invalid", "unavailable"]),
      provenance: z.array(ProvenanceSchema)
    }
  }, { readOnly: true }, async ({ workspace, expected_path }, extra) => {
    const workspaceRef = String(workspace);
    const resolved = runtime.access.resolveWorkspaceRef(workspaceRef);
    const folderResponse = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/info`, resolved.context.id, {}, extra.signal);
    const folder = projectItem(folderResponse.data, "verification");
    const source = objectValue(folderResponse.data) ?? {};
    const space = objectValue(source.space);
    const departments: JsonObject[] = [];
    const observations: JsonObject[] = [provenance(folderResponse.meta, resolved.context.id, "workspace_root_metadata")];
    const seen = new Set<string>();
    let departmentId = idValue(space?.id);
    let departmentChainComplete: "pass" | "unavailable" = departmentId ? "pass" : "unavailable";
    while (departmentId && departmentId !== "0" && !seen.has(departmentId) && departments.length < 50) {
      seen.add(departmentId);
      try {
        const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/info`, {}, extra.signal);
        observations.push(provenance(response.meta, resolved.context.id, "workspace_department_metadata"));
        const department = projectDepartment(response.data);
        departments.unshift(department);
        departmentId = typeof department.parent_id === "string" ? department.parent_id : undefined;
        if (!departmentId) departmentChainComplete = "unavailable";
      } catch (error) {
        if (!canDowngradeCheckToUnavailable(error, extra.signal)) throw error;
        departmentChainComplete = "unavailable";
        break;
      }
    }
    if ((departmentId && seen.has(departmentId)) || departments.length >= 50) departmentChainComplete = "unavailable";
    const firstPage = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/children`, resolved.context.id, { type: "all", page_id: 0, page_capacity: 1 }, extra.signal);
    observations.push(provenance(firstPage.meta, resolved.context.id, "workspace_first_page"));
    const firstSource = objectValue(firstPage.data) ?? {};
    const pageCount = typeof firstSource.page_count === "number" ? firstSource.page_count : undefined;
    let lastPageReachable: "pass" | "unavailable" = pageCount === undefined ? "unavailable" : "pass";
    if (pageCount && pageCount > 1) {
      try {
        const lastPage = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/children`, resolved.context.id, { type: "all", page_id: pageCount - 1, page_capacity: 1 }, extra.signal);
        observations.push(provenance(lastPage.meta, resolved.context.id, "workspace_last_page"));
      } catch (error) {
        if (!canDowngradeCheckToUnavailable(error, extra.signal)) throw error;
        lastPageReachable = "unavailable";
      }
    }
    const businessPath = [...departments.map((entry) => String(entry.name ?? "")), String(folder.name ?? "")].filter(Boolean);
    const expected = Array.isArray(expected_path) ? expected_path.map(String) : undefined;
    const deletedKnown = typeof folder.is_deleted === "boolean" && typeof folder.in_trash === "boolean";
    const pathComplete = departmentChainComplete === "pass" && typeof folder.name === "string";
    const checks: Record<string, "pass" | "fail" | "unavailable"> = {
      exists: typeof folder.id !== "string" ? "unavailable" : folder.id === resolved.scope.rootFolderId ? "pass" : "fail",
      not_deleted: folder.is_deleted === true || folder.in_trash === true ? "fail" : deletedKnown ? "pass" : "unavailable",
      first_page_reachable: "pass",
      last_page_reachable: lastPageReachable,
      department_chain_complete: departmentChainComplete,
      ...(expected ? { expected_path_matches: !pathComplete ? "unavailable" : JSON.stringify(businessPath.slice(-expected.length)) === JSON.stringify(expected) ? "pass" : "fail" } : {})
    };
    const verdict = Object.values(checks).includes("fail") ? "invalid" : Object.values(checks).includes("unavailable") ? "unavailable" : "valid";
    const rootRef = formatItemRef("folder", resolved.scope.rootFolderId, resolved.context.id, resolved.identityRef);
    return {
      workspace: { ref: workspaceRef, root: rootRef, access_context: resolved.context.id, tags: resolved.scope.tags },
      folder: { ...folder, ref: rootRef },
      business_path: businessPath,
      department_chain: departments,
      checks,
      verdict,
      provenance: observations
    };
  });

  registerTool(server, "yfy_membership_check", {
    title: "Check Yifangyun Workspace Membership",
    description: "Check whether a context-bound file belongs to a configured workspace. Membership may be inside, outside, or unavailable. Read agent_interpretation before claiming membership; unavailable means neither inside nor outside may be claimed.",
    inputSchema: { file: FileRefSchema, workspace: WorkspaceRefSchema, mode: z.enum(["query", "assert"]).default("query") },
    outputSchema: {
      file: ItemSchema.extend({ ref: FileRefSchema }),
      workspace: z.object({ ref: WorkspaceRefSchema, root: FolderRefSchema, access_context: z.string() }).strict(),
      membership: z.enum(["inside", "outside", "unavailable"]),
      agent_interpretation: z.object({
        may_claim_inside: z.boolean(),
        may_claim_outside: z.boolean(),
        may_download: z.boolean(),
        narrative: z.string(),
        next_steps: z.array(z.string())
      }).strict(),
      diagnostics: z.object({
        reason: z.string(),
        observed_file_space: z.record(z.unknown()).optional(),
        observed_root_space: z.record(z.unknown()).optional(),
        observed_ancestor_folder_ids: z.array(z.string())
      }).strict(),
      ancestor_folders: z.array(FolderRefSchema),
      relative_ancestor_chain: z.array(PathEntrySchema),
      path_basis: z.literal("configured_workspace_root"),
      provenance: z.array(ProvenanceSchema)
    }
  }, { readOnly: true }, async ({ file, workspace, mode }, extra) => {
    const result = await getScopedFile(runtime, String(file), String(workspace), extra.signal);
    metrics.increment("scope_assertion_total", { outcome: `${result.membership.status}_scope` });
    if (mode === "assert" && result.membership.status !== "inside") {
      throw new YifangyunError(result.membership.status === "outside" ? "File is outside the configured workspace." : "Workspace membership could not be proven from Provider metadata.", {
        code: result.membership.status === "outside" ? "YFY_WORKSPACE_MEMBERSHIP_FAILED" : "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE",
        agentDetails: membershipDiagnostics(result.membership, {
          file_ref: String(file),
          workspace: String(workspace),
          root_folder_id: result.scope.scope.rootFolderId,
          membership: result.membership.status
        }),
        phase: "workspace_membership",
        suggestedAction: result.membership.agent_interpretation.next_steps[0]
      });
    }
    const ancestorFolders = result.membership.ancestorIds.map((id) => formatItemRef("folder", id, result.scope.context.id, result.scope.identityRef));
    return {
      file: { ...result.file, ref: String(file) },
      workspace: { ref: String(workspace), root: formatItemRef("folder", result.scope.scope.rootFolderId, result.scope.context.id, result.scope.identityRef), access_context: result.scope.context.id },
      membership: result.membership.status,
      agent_interpretation: result.membership.agent_interpretation,
      diagnostics: {
        reason: result.membership.reason,
        ...(result.membership.observed_file_space ? { observed_file_space: result.membership.observed_file_space } : {}),
        ...(result.membership.observed_root_space ? { observed_root_space: result.membership.observed_root_space } : {}),
        observed_ancestor_folder_ids: result.membership.ancestorIds
      },
      ancestor_folders: ancestorFolders,
      relative_ancestor_chain: workspaceRelativeAncestors(result.file, result.scope.scope.rootFolderId),
      path_basis: "configured_workspace_root",
      provenance: [provenance(result.response.meta, result.scope.context.id, "workspace_membership_file_metadata"), provenance(result.rootResponse.meta, result.scope.context.id, "workspace_membership_root_metadata")]
    };
  });
}
