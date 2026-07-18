import { promises as fs } from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, versionSelectionProof, type EvidenceDownloadStrategy, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { idValue, objectValue, projectDepartment, projectItem, provenance } from "../domain/projectors.js";
import { formatItemRef, formatVersionRef, parseItemRef, parseVersionRef } from "../domain/refs.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { CheckStatusSchema, FileRefSchema, FileVersionSchema, FolderRefSchema, ItemSchema, PathEntrySchema, ProvenanceSchema, VerificationStatusSchema, VersionRefSchema, VersionSelectionProofSchema, WorkspaceRefSchema } from "./schemas.js";

function progressReporter(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: unknown) => Promise<void>; signal: AbortSignal }) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let lastBytes = 0;
  let lastAt = 0;
  return (bytes: number, totalBytes?: number) => {
    if (extra.signal.aborted) return;
    const now = Date.now();
    if (bytes - lastBytes < 1_048_576 && now - lastAt < 1000 && bytes !== totalBytes) return;
    lastBytes = bytes;
    lastAt = now;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: bytes, ...(totalBytes !== undefined ? { total: totalBytes } : {}), message: "Downloading and hashing Yifangyun evidence" } }).catch(() => undefined);
  };
}

type MembershipStatus = "inside" | "outside" | "unavailable";

type MembershipAgentInterpretation = {
  may_claim_inside: boolean;
  may_claim_outside: boolean;
  may_capture: boolean;
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

function buildMembershipInterpretation(status: MembershipStatus, reason: string): MembershipAgentInterpretation {
  if (status === "inside") {
    return {
      may_claim_inside: true,
      may_claim_outside: false,
      may_capture: true,
      narrative: "The file is inside the configured workspace root (path or parent folder hit the root).",
      next_steps: ["You may call yfy_capture with this workspace and file ref.", "Release every content resource after use."]
    };
  }
  if (status === "outside") {
    return {
      may_claim_inside: false,
      may_claim_outside: true,
      may_capture: false,
      narrative: reason === "different_space_id"
        ? "The file belongs to a different storage space id than the workspace root."
        : "The file belongs to a different storage space type than the workspace root (for example personal vs department).",
      next_steps: [
        "Do not claim this file is inside the workspace.",
        "Do not call yfy_capture for this workspace with this file.",
        "Discover the file from the target workspace (browse/resolve) before capture."
      ]
    };
  }
  const narratives: Record<string, string> = {
    conflicting_membership_evidence: "Provider path and storage-space metadata conflict, so membership is unsafe to claim in either direction.",
    missing_ancestor_chain: "Provider metadata does not include a path that reaches the workspace root; membership is unproven. Do not treat this as outside or inside.",
    incomplete_space_metadata: "Space metadata is incomplete on the file and/or workspace root, so outside/inside cannot be decided.",
    same_space_path_inconclusive: "File and workspace appear to share a space, but the path does not prove the file is under the configured root."
  };
  return {
    may_claim_inside: false,
    may_claim_outside: false,
    may_capture: false,
    narrative: narratives[reason] ?? "Workspace membership could not be proven from Provider metadata. Do not claim inside or outside.",
    next_steps: [
      "Do not claim the file is inside or outside the workspace.",
      "Resolve the file via a path under the workspace root, or browse from the workspace to obtain a path-backed ref.",
      "Retry after the Provider exposes a complete ancestry chain or space metadata."
    ]
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
    const reason = "conflicting_membership_evidence";
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
      may_capture: interpretation.may_capture,
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

/** Inline preview cap for structuredContent — keep small so Hosts that inject structuredContent do not blow the model context. */
const PREVIEW_MAX_BYTES = 32 * 1024;
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

function isPreviewableMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/xml"
    || mediaType === "application/yaml"
    || mediaType === "image/svg+xml"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml");
}

async function tryInlineTextPreview(runtime: AppRuntime, resourceUri: string, sizeBytes: number, mediaType: string, delivery: string): Promise<{ preview_bytes: number; preview_complete: true; preview_text: string } | undefined> {
  if (delivery !== "mcp_resource") return undefined;
  if (sizeBytes > PREVIEW_MAX_BYTES) return undefined;
  if (!isPreviewableMediaType(mediaType)) return undefined;
  const verified = await runtime.evidence.readTextPreview(resourceUri, PREVIEW_MAX_BYTES);
  return verified ? { preview_bytes: verified.bytes, preview_complete: true, preview_text: verified.text } : undefined;
}

function buildContentDelivery(resource: JsonObject, hasInlinePreview: boolean, previewRequested: boolean): JsonObject {
  const mediaType = typeof resource.media_type === "string" ? resource.media_type : "application/octet-stream";
  if (resource.delivery === "multipart_resource") {
    return {
      mode: "multipart_manifest_only",
      resource_fetch_required: true,
      embedded_resource_in_tool_result: false,
      host_auto_fetch_not_guaranteed: true,
      still_must_release: true,
      next_step: "Read the multipart manifest at resource.resource_uri, fetch each part URI, then call yfy_resource_release.",
      reason: "multipart_resources_never_inline"
    };
  }
  if (hasInlinePreview) {
    return {
      mode: "inline_preview",
      resource_fetch_required: false,
      embedded_resource_in_tool_result: true,
      host_auto_fetch_not_guaranteed: true,
      still_must_release: true,
      next_step: "Use the embedded text resource or resource.preview_text; still call yfy_resource_release when finished.",
      preview_kind: mediaType,
      preview_bytes: resource.preview_bytes,
      preview_complete: true,
      preview_charset: "utf-8"
    };
  }
  if (isPreviewableMediaType(mediaType)) {
    return {
      mode: "resource_link_only",
      resource_fetch_required: true,
      embedded_resource_in_tool_result: false,
      host_auto_fetch_not_guaranteed: true,
      still_must_release: true,
      next_step: "Host may not auto-read resource_link. Call resources/read on resource.resource_uri, then yfy_resource_release.",
      reason: previewRequested ? "preview_unavailable_use_resource_link" : "preview_disabled_by_request"
    };
  }
  return {
    mode: "binary_no_preview",
    resource_fetch_required: true,
    embedded_resource_in_tool_result: false,
    host_auto_fetch_not_guaranteed: true,
    still_must_release: true,
    next_step: "Call resources/read on resource.resource_uri for verified bytes, then yfy_resource_release. Binary rendering depends on client attachment support.",
    reason: "binary_or_non_previewable_media_type"
  };
}

function assertContentDeliveryConsistency(resource: JsonObject, delivery: JsonObject): void {
  const mode = delivery.mode;
  const hasPreview = typeof resource.preview_text === "string" && resource.preview_complete === true;
  const valid = mode === "inline_preview"
    ? resource.delivery === "mcp_resource" && hasPreview && delivery.embedded_resource_in_tool_result === true && delivery.resource_fetch_required === false
    : mode === "multipart_manifest_only"
      ? resource.delivery === "multipart_resource" && !hasPreview
      : (mode === "resource_link_only" || mode === "binary_no_preview")
        ? resource.delivery === "mcp_resource" && !hasPreview && delivery.resource_fetch_required === true
        : false;
  if (!valid) {
    throw new YifangyunError("Content delivery state is internally inconsistent.", {
      code: "YFY_TOOL_OUTPUT_INVALID",
      phase: "content_delivery",
      suggestedAction: "Upgrade or fix the MCP server before using this content."
    });
  }
}

async function removeEvidenceTemp(tempPath: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(tempPath, { force: true });
      return;
    } catch (error) {
      const retryable = Boolean(error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EBUSY"));
      if (!retryable || attempt === 2) {
        throw new YifangyunError("Validated evidence could not be removed from temporary storage.", {
          code: "YFY_EVIDENCE_CLEANUP_FAILED",
          phase: "evidence_cleanup",
          retryable
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function canTryAnotherHistoricalSelector(error: unknown): boolean {
  return error instanceof YifangyunError
    && (error.code === "YFY_DOWNLOAD_TICKET_INVALID"
      || (error.code === "YFY_PROVIDER_HTTP_ERROR" && [400, 404, 422].includes(error.statusCode ?? 0)));
}

async function attachEvidenceArtifact(runtime: AppRuntime, evidence: JsonObject): Promise<JsonObject> {
  const sizeBytes = typeof evidence.size_bytes === "number" ? evidence.size_bytes : Number.MAX_SAFE_INTEGER;
  const maxResourceBytes = runtime.config.maxEvidenceResourceBytes ?? 16777216;
  const resolved = resolveMediaType(evidence.content_type, evidence.detected_content_type, evidence.file_name);
  const mediaType = resolved.media_type;
  const detectedMediaType = normalizeSingleMediaType(evidence.detected_content_type);
  const common: JsonObject = {
    file: String(evidence.file_ref),
    file_name: String(evidence.file_name),
    sha1: String(evidence.sha1),
    sha256: String(evidence.sha256),
    size_bytes: sizeBytes,
    media_type: mediaType,
    media_type_source: resolved.media_type_source,
    ...(detectedMediaType ? { detected_media_type: detectedMediaType } : {})
  };
  if (sizeBytes > maxResourceBytes) {
    const baseUri = await runtime.evidence.register({
      path: String(evidence.temp_path),
      name: String(evidence.file_name),
      expectedSize: sizeBytes,
      expectedSha256: String(evidence.sha256),
      mimeType: mediaType
    });
    return {
      ...common,
      delivery: "multipart_resource",
      resource_uri: `${baseUri}/manifest`,
      part_count: Math.ceil(sizeBytes / maxResourceBytes),
      part_size_bytes: maxResourceBytes,
      expires_at: new Date(Date.now() + (runtime.config.tempFileTtlSeconds ?? 86400) * 1000).toISOString()
    };
  }
  const resourceUri = await runtime.evidence.register({
    path: String(evidence.temp_path),
    name: String(evidence.file_name),
    expectedSize: sizeBytes,
    expectedSha256: String(evidence.sha256),
    mimeType: mediaType
  });
  return {
    ...common,
    delivery: "mcp_resource",
    resource_uri: resourceUri,
    expires_at: new Date(Date.now() + (runtime.config.tempFileTtlSeconds ?? 86400) * 1000).toISOString()
  };
}

function assertEvidenceAnchors(file: JsonObject, requireAncestry: boolean): void {
  const missing: string[] = [];
  if (typeof file.size_bytes !== "number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) missing.push("size_bytes");
  if (typeof file.modified_at_unix !== "number" || !Number.isSafeInteger(file.modified_at_unix) || file.modified_at_unix < 0) missing.push("modified_at_unix");
  if (typeof file.file_version_key !== "string" || file.file_version_key.length === 0) missing.push("file_version_key");
  if (requireAncestry && (!Array.isArray(file.provider_path_chain) || file.provider_path_chain.length === 0) && typeof file.parent_folder_id !== "string") missing.push("ancestry");
  if (missing.length > 0) {
    throw new YifangyunError("Provider metadata is incomplete for drift-safe evidence.", {
      code: "YFY_EVIDENCE_METADATA_INCOMPLETE",
      agentDetails: { missing_fields: missing },
      phase: "evidence_metadata",
      suggestedAction: "Retry after the Provider exposes version, modified time, size and ancestry metadata."
    });
  }
}

async function getScopedFile(runtime: AppRuntime, fileRef: string, workspaceRef: string, signal?: AbortSignal) {
  const item = parseItemRef(fileRef);
  if (item.type !== "file") throw new YifangyunError("A file ref is required.", { code: "YFY_INPUT_INVALID", phase: "workspace_membership" });
  const scope = runtime.access.resolveWorkspaceRef(workspaceRef);
  if (item.accessContextId !== scope.context.id || item.identityRef !== scope.identityRef) {
    throw new YifangyunError("File and workspace refs belong to different access identities.", {
      code: "YFY_REF_CONTEXT_CONFLICT",
      phase: "workspace_membership",
      suggestedAction: "Discover the file from the same workspace before checking or capturing it."
    });
  }
  const fileId = item.id;
  const [response, rootResponse] = await Promise.all([
    runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/info_v2`, scope.context.id, scope.context.externalEnterpriseId
      ? { external_enterprise_id: scope.context.externalEnterpriseId }
      : {}, signal),
    runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(scope.scope.rootFolderId)}/info`, scope.context.id, {}, signal)
  ]);
  const file = projectItem(response.data, "evidence");
  const rootFolder = projectItem(rootResponse.data, "evidence");
  const membership = workspaceMembershipProof(file, rootFolder, scope.scope.rootFolderId);
  return { file, fileId, fileRef, membership, response, rootResponse, scope };
}

async function observeVersions(runtime: AppRuntime, fileId: string, accessContext: string, signal?: AbortSignal) {
  const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/versions`, accessContext, {}, signal);
  return { ...normalizeFileVersions(response.data), response };
}

async function downloadAttempt(runtime: AppRuntime, input: { accessContext: string; downloadSelector: number | string; externalEnterpriseId?: string; file: JsonObject; fileId: string; fileRef: string; identityRef: string; onProgress?: (bytes: number, totalBytes?: number) => void; signal?: AbortSignal; strategy: EvidenceDownloadStrategy }) {
  const ticket = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/download_v2`, input.accessContext, {
    version: input.downloadSelector,
    external_enterprise_id: input.externalEnterpriseId
  }, input.signal);
  const ticketData = objectValue(ticket.data);
  if (!ticketData || typeof ticketData.download_url !== "string") {
    throw new YifangyunError("Download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "evidence_download" });
  }
  const downloaded = await runtime.client.downloadFromUrlToTemp(ticketData.download_url, {
    fileNameHint: typeof input.file.name === "string" ? input.file.name : `${input.fileId}.bin`,
    namespace: input.identityRef,
    onProgress: input.onProgress,
    retry: true,
    signal: input.signal
  });
  return {
    evidence: {
      file_id: input.fileId,
      file_ref: input.fileRef,
      file_name: downloaded.fileName,
      temp_path: downloaded.tempPath,
      sha1: downloaded.sha1,
      sha256: downloaded.sha256,
      size_bytes: downloaded.sizeBytes,
      ...(downloaded.contentType ? { content_type: downloaded.contentType } : {}),
      ...(downloaded.detectedContentType ? { detected_content_type: downloaded.detectedContentType } : {})
    } as JsonObject,
    observations: [provenance(ticket.meta, input.accessContext, "download_ticket"), provenance(downloaded.meta, input.accessContext, "content_download")],
    strategy: input.strategy
  };
}

async function downloadSelectedVersion(runtime: AppRuntime, input: {
  accessContext: string;
  externalEnterpriseId?: string;
  file: JsonObject;
  fileId: string;
  fileRef: string;
  identityRef: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  selected: FileVersion;
  selector: VersionSelector;
  signal?: AbortSignal;
  versions: FileVersion[];
}) {
  const candidates: Array<{ selector: number | string; strategy: EvidenceDownloadStrategy }> = input.selector.kind === "current"
    ? [{ selector: 0, strategy: "current_ordinal" as const }]
    : [
      { selector: input.versions.length - input.selected.generation, strategy: "historical_reverse_ordinal" as const },
      { selector: input.selected.generation, strategy: "historical_ordinal" as const },
      { selector: input.selected.provider_version_id!, strategy: "historical_version_id" as const }
    ].filter((candidate, index, values) => values.findIndex((value) => String(value.selector) === String(candidate.selector)) === index);
  const attempts: JsonObject[] = [];
  for (const candidate of candidates) {
    let downloaded: Awaited<ReturnType<typeof downloadAttempt>> | undefined;
    try {
      downloaded = await downloadAttempt(runtime, {
        accessContext: input.accessContext,
        downloadSelector: candidate.selector,
        externalEnterpriseId: input.externalEnterpriseId,
        file: input.file,
        fileId: input.fileId,
        fileRef: input.fileRef,
        identityRef: input.identityRef,
        onProgress: input.onProgress,
        signal: input.signal,
        strategy: candidate.strategy
      });
      if (downloaded.evidence.sha1 === input.selected.sha1 && downloaded.evidence.size_bytes === input.selected.size_bytes) return downloaded;
      const matchingVersions = input.versions.filter((version) => version.sha1 === downloaded!.evidence.sha1 && version.size_bytes === downloaded!.evidence.size_bytes);
      attempts.push({
        strategy: candidate.strategy,
        actual_sha1: String(downloaded.evidence.sha1),
        actual_size_bytes: Number(downloaded.evidence.size_bytes),
        matched_version_ids: matchingVersions.flatMap((version) => version.provider_version_id ? [version.provider_version_id] : []),
        returned_current: matchingVersions.some((version) => version.current)
      });
    } catch (error) {
      if (input.selector.kind === "current" || !canTryAnotherHistoricalSelector(error)) throw error;
      attempts.push({ strategy: candidate.strategy, error_code: error instanceof YifangyunError ? error.code : "YFY_UNEXPECTED_ERROR" });
    } finally {
      if (downloaded && (downloaded.evidence.sha1 !== input.selected.sha1 || downloaded.evidence.size_bytes !== input.selected.size_bytes)) {
        await removeEvidenceTemp(String(downloaded.evidence.temp_path));
      }
    }
  }
  if (input.selector.kind === "historical") {
    throw new YifangyunError("The Provider could not return content matching the selected historical version metadata.", {
      code: "YFY_HISTORICAL_CAPTURE_UNAVAILABLE",
      phase: "evidence_download_validation",
      agentDetails: {
        expected_sha1: input.selected.sha1 ?? null,
        expected_size_bytes: input.selected.size_bytes ?? null,
        provider_version_id: input.selected.provider_version_id ?? null,
        attempts
      },
      suggestedAction: "Do not substitute another version. Refresh yfy_versions and retry, or report that the historical original is unavailable from the Provider."
    });
  }
  throw new YifangyunError("The Provider returned current content that does not match the version metadata.", {
    code: "YFY_EVIDENCE_CONTENT_MISMATCH",
    phase: "evidence_download_validation",
    agentDetails: { expected_sha1: input.selected.sha1 ?? null, expected_size_bytes: input.selected.size_bytes ?? null, attempts },
    suggestedAction: "Refresh file metadata and yfy_versions before retrying. Do not use the downloaded content."
  });
}

export function registerWorkspaceContentTools(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("workspace")) {
    registerAuthorityTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("drive")) {
    registerOpenTool(server, runtime);
  }
  if (runtime.config.toolsets.includes("evidence")) {
    registerEvidenceTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("drive") || runtime.config.toolsets.includes("evidence")) {
    registerArtifactTools(server, runtime);
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
    const folder = projectItem(folderResponse.data, "evidence");
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
        may_capture: z.boolean(),
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
        suggestedAction: result.membership.status === "unavailable"
          ? "Do not claim inside or outside. Resolve via workspace path or wait for complete Provider ancestry/space metadata."
          : "Do not claim this file is inside the workspace."
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

async function captureVersionContent(runtime: AppRuntime, input: {
  expected?: Record<string, unknown>;
  fileRef: string;
  includeTextPreview: boolean;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  selector: VersionSelector;
  signal?: AbortSignal;
  workspaceRef?: string;
}) {
  const item = parseItemRef(input.fileRef);
  if (item.type !== "file") throw new YifangyunError("A file ref is required.", { code: "YFY_INPUT_INVALID", phase: "content_capture" });
  const scopedBefore = input.workspaceRef ? await getScopedFile(runtime, input.fileRef, input.workspaceRef, input.signal) : undefined;
  const access = scopedBefore?.scope ?? runtime.gateway.context(item.accessContextId);
  if (access.identityRef !== item.identityRef) throw new YifangyunError("File reference belongs to a different configured identity.", { code: "YFY_REF_IDENTITY_MISMATCH", phase: "content_capture" });
  const beforeResponse = scopedBefore?.response ?? await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/info_v2`, access.context.id, access.context.externalEnterpriseId ? { external_enterprise_id: access.context.externalEnterpriseId } : {}, input.signal);
  const before = scopedBefore?.file ?? projectItem(beforeResponse.data, "evidence");
  assertEvidenceAnchors(before, Boolean(input.workspaceRef));
  if (scopedBefore && scopedBefore.membership.status !== "inside") {
    throw new YifangyunError(scopedBefore.membership.status === "outside" ? "The file is outside the configured workspace." : "Workspace membership could not be proven from Provider metadata.", {
      code: scopedBefore.membership.status === "outside" ? "YFY_WORKSPACE_MEMBERSHIP_FAILED" : "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE",
      phase: "workspace_membership",
      agentDetails: membershipDiagnostics(scopedBefore.membership, {
        file_ref: input.fileRef,
        workspace: input.workspaceRef!,
        root_folder_id: scopedBefore.scope.scope.rootFolderId,
        membership: scopedBefore.membership.status
      }),
      suggestedAction: scopedBefore.membership.status === "unavailable"
        ? "Do not claim inside or outside. Resolve via workspace path or wait for complete Provider ancestry/space metadata."
        : "Do not claim this file is inside the workspace."
    });
  }
  const versionsBefore = await observeVersions(runtime, item.id, access.context.id, input.signal);
  const selected = selectFileVersion(versionsBefore.versions, input.selector);
  if (input.selector.kind === "historical") {
    const duplicateContentVersions = versionsBefore.versions.filter((version) => version.generation !== selected.generation && version.sha1 === selected.sha1 && version.size_bytes === selected.size_bytes);
    if (duplicateContentVersions.length > 0) {
      throw new YifangyunError("The selected historical version has the same content identity as another version.", {
        code: "YFY_VERSION_CONTENT_IDENTITY_AMBIGUOUS",
        phase: "version_selection",
        agentDetails: { provider_version_id: selected.provider_version_id ?? null, indistinguishable_version_ids: duplicateContentVersions.flatMap((version) => version.provider_version_id ? [version.provider_version_id] : []) },
        suggestedAction: "Select a version with a distinct SHA-1 or size. Never claim identical bytes prove a specific generation."
      });
    }
  }
  const observations: JsonObject[] = [
    provenance(beforeResponse.meta, access.context.id, "file_metadata_before"),
    ...(scopedBefore ? [provenance(scopedBefore.rootResponse.meta, access.context.id, "workspace_root_metadata_before")] : []),
    provenance(versionsBefore.response.meta, access.context.id, "version_history_before")
  ];
  const downloaded = await downloadSelectedVersion(runtime, {
    accessContext: access.context.id,
    externalEnterpriseId: access.context.externalEnterpriseId,
    file: before,
    fileId: item.id,
    fileRef: input.fileRef,
    identityRef: access.identityRef,
    onProgress: input.onProgress,
    selected,
    selector: input.selector,
    signal: input.signal,
    versions: versionsBefore.versions
  });
  observations.push(...downloaded.observations);
  try {
    const versionsAfter = await observeVersions(runtime, item.id, access.context.id, input.signal);
    observations.push(provenance(versionsAfter.response.meta, access.context.id, "version_history_after"));
    if (versionsBefore.fingerprint !== versionsAfter.fingerprint) {
      throw new YifangyunError("File version history changed while content was being captured.", { code: "YFY_EVIDENCE_DRIFT", phase: "version_recheck", retryable: true, suggestedAction: "Restart the operation from yfy_versions." });
    }
    const scopedAfter = input.workspaceRef ? await getScopedFile(runtime, input.fileRef, input.workspaceRef, input.signal) : undefined;
    const afterResponse = scopedAfter?.response ?? await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/info_v2`, access.context.id, access.context.externalEnterpriseId ? { external_enterprise_id: access.context.externalEnterpriseId } : {}, input.signal);
    const after = scopedAfter?.file ?? projectItem(afterResponse.data, "evidence");
    assertEvidenceAnchors(after, Boolean(input.workspaceRef));
    observations.push(provenance(afterResponse.meta, access.context.id, "file_metadata_after"));
    if (scopedAfter) observations.push(provenance(scopedAfter.rootResponse.meta, access.context.id, "workspace_root_metadata_after"));
    const beforeSha1 = typeof before.sha1 === "string" && /^[a-f\d]{40}$/i.test(before.sha1) ? before.sha1.toLowerCase() : undefined;
    const afterSha1 = typeof after.sha1 === "string" && /^[a-f\d]{40}$/i.test(after.sha1) ? after.sha1.toLowerCase() : undefined;
    const stable = {
      file_version_key: before.file_version_key === after.file_version_key,
      modified_at: before.modified_at_unix === after.modified_at_unix,
      size: before.size_bytes === after.size_bytes,
      metadata_sha1: beforeSha1 === undefined || afterSha1 === undefined || beforeSha1 === afterSha1,
      path: JSON.stringify(before.provider_path_chain) === JSON.stringify(after.provider_path_chain),
      workspace_membership: !input.workspaceRef || scopedAfter?.membership.status === "inside",
      current_metadata_size: input.selector.kind === "historical" || (before.size_bytes === selected.size_bytes && after.size_bytes === selected.size_bytes),
      current_metadata_sha1: input.selector.kind === "historical" || [beforeSha1, afterSha1].filter((value): value is string => value !== undefined).every((value) => value === selected.sha1)
    };
    if (!Object.values(stable).every(Boolean)) {
      throw new YifangyunError("File metadata or workspace membership changed while content was being captured.", {
        code: "YFY_EVIDENCE_DRIFT",
        phase: "content_recheck",
        retryable: true,
        agentDetails: stable,
        suggestedAction: "Restart the operation and do not use this content."
      });
    }
    const expected = input.expected ?? {};
    const expectationChecks: Record<string, boolean> = {};
    const actual: JsonObject = {};
    if (typeof expected.sha1 === "string") { actual.sha1 = downloaded.evidence.sha1; expectationChecks.sha1 = actual.sha1 === expected.sha1.toLowerCase(); }
    if (typeof expected.sha256 === "string") { actual.sha256 = downloaded.evidence.sha256; expectationChecks.sha256 = actual.sha256 === expected.sha256.toLowerCase(); }
    if (typeof expected.size_bytes === "number") { actual.size_bytes = downloaded.evidence.size_bytes; expectationChecks.size_bytes = actual.size_bytes === expected.size_bytes; }
    if (typeof expected.modified_at_unix === "number") { actual.modified_at_unix = selected.modified_at_unix ?? null; expectationChecks.modified_at_unix = actual.modified_at_unix === expected.modified_at_unix; }
    if (typeof expected.file_version_key === "string") { actual.file_version_key = before.file_version_key ?? null; expectationChecks.file_version_key = actual.file_version_key === expected.file_version_key; }
    const mismatches = Object.entries(expectationChecks).filter(([, matched]) => !matched).map(([field]) => field);
    if (mismatches.length > 0) {
      throw new YifangyunError("Captured content does not match the requested expectations.", {
        code: "YFY_EXPECTATION_MISMATCH",
        phase: "expectation_validation",
        agentDetails: { actual, expected: expected as JsonObject, mismatches },
        suggestedAction: "Review the current metadata and version list. No artifact was retained."
      });
    }
    const checks: JsonObject = {
      content_sha1: "pass",
      content_size: "pass",
      version_history: "pass",
      file_metadata_stability: "pass",
      metadata_sha1_stability: beforeSha1 === undefined || afterSha1 === undefined ? "unavailable" : "pass",
      current_metadata_match: input.selector.kind === "historical" ? "not_applicable" : "pass",
      workspace_membership: input.workspaceRef ? "pass" : "not_applicable"
    };
    const resource = await attachEvidenceArtifact(runtime, downloaded.evidence);
    const inlinePreview = input.includeTextPreview && typeof resource.resource_uri === "string"
      ? await tryInlineTextPreview(
        runtime,
        String(resource.resource_uri),
        typeof resource.size_bytes === "number" ? resource.size_bytes : Number.MAX_SAFE_INTEGER,
        typeof resource.media_type === "string" ? resource.media_type : "application/octet-stream",
        String(resource.delivery)
      )
      : undefined;
    const resourceWithDelivery: JsonObject = {
      ...resource,
      must_release: true,
      ...(inlinePreview ?? {})
    };
    const contentDelivery = buildContentDelivery(resourceWithDelivery, Boolean(inlinePreview), input.includeTextPreview);
    assertContentDeliveryConsistency(resourceWithDelivery, contentDelivery);
    // must_release 置顶：序列化时优先提醒 Agent 释放资源
    return {
      must_release: true,
      content_delivery: contentDelivery,
      file: { ...after, ref: input.fileRef },
      version: { ...selected, ...(!selected.current ? { ref: formatVersionRef(input.fileRef, selected.provider_version_id!) } : {}) },
      selection: versionSelectionProof(selected, input.selector, downloaded.strategy),
      assurance: { level: input.workspaceRef ? "workspace_bound" : "content_integrity", verdict: "verified", checks },
      ...(input.workspaceRef && scopedAfter ? { workspace: { ref: input.workspaceRef, root: formatItemRef("folder", scopedAfter.scope.scope.rootFolderId, scopedAfter.scope.context.id, scopedAfter.scope.identityRef), ancestor_folders: scopedAfter.membership.ancestorIds.map((id) => formatItemRef("folder", id, scopedAfter.scope.context.id, scopedAfter.scope.identityRef)), relative_ancestor_chain: workspaceRelativeAncestors(after, scopedAfter.scope.scope.rootFolderId), path_basis: "configured_workspace_root", membership: "inside" } } : {}),
      expectation: { verdict: Object.keys(expectationChecks).length > 0 ? "matched" : "not_provided", checks: expectationChecks },
      resource: resourceWithDelivery,
      provenance: observations
    };
  } catch (error) {
    if (typeof downloaded.evidence.temp_path === "string") await removeEvidenceTemp(downloaded.evidence.temp_path);
    throw error;
  }
}

const EvidenceArtifactBaseShape = {
  file: FileRefSchema,
  file_name: z.string(),
  sha1: z.string().regex(/^[a-f\d]{40}$/i),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
  size_bytes: z.number().int().nonnegative(),
  media_type: z.string(),
  media_type_source: z.enum(["content_type", "magic_sniff", "file_extension", "octet_stream"]),
  detected_media_type: z.string().optional(),
  must_release: z.literal(true),
  preview_text: z.string().optional(),
  preview_bytes: z.number().int().nonnegative().optional(),
  preview_complete: z.literal(true).optional()
};
const EvidenceResourceUriSchema = z.string().regex(/^yfy:\/\/evidence\/[a-f0-9]{48}$/);
const EvidenceManifestUriSchema = z.string().regex(/^yfy:\/\/evidence\/[a-f0-9]{48}\/manifest$/);
const ContentResourceSchema = z.discriminatedUnion("delivery", [
  z.object({ ...EvidenceArtifactBaseShape, delivery: z.literal("mcp_resource"), resource_uri: EvidenceResourceUriSchema, expires_at: z.string() }),
  z.object({ ...EvidenceArtifactBaseShape, delivery: z.literal("multipart_resource"), resource_uri: EvidenceManifestUriSchema, part_count: z.number().int().positive(), part_size_bytes: z.number().int().positive(), expires_at: z.string() })
]);

const ExpectationSchema = z.object({
  verdict: z.enum(["matched", "not_provided"]),
  checks: z.record(z.boolean())
});

const ContentDeliverySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("inline_preview"),
    resource_fetch_required: z.literal(false),
    embedded_resource_in_tool_result: z.literal(true),
    host_auto_fetch_not_guaranteed: z.literal(true),
    still_must_release: z.literal(true),
    next_step: z.string(),
    preview_kind: z.string(),
    preview_bytes: z.number().int().nonnegative(),
    preview_complete: z.literal(true),
    preview_charset: z.literal("utf-8")
  }).strict(),
  z.object({
    mode: z.literal("resource_link_only"),
    resource_fetch_required: z.literal(true),
    embedded_resource_in_tool_result: z.literal(false),
    host_auto_fetch_not_guaranteed: z.literal(true),
    still_must_release: z.literal(true),
    next_step: z.string(),
    reason: z.enum(["preview_unavailable_use_resource_link", "preview_disabled_by_request"])
  }).strict(),
  z.object({
    mode: z.literal("multipart_manifest_only"),
    resource_fetch_required: z.literal(true),
    embedded_resource_in_tool_result: z.literal(false),
    host_auto_fetch_not_guaranteed: z.literal(true),
    still_must_release: z.literal(true),
    next_step: z.string(),
    reason: z.literal("multipart_resources_never_inline")
  }).strict(),
  z.object({
    mode: z.literal("binary_no_preview"),
    resource_fetch_required: z.literal(true),
    embedded_resource_in_tool_result: z.literal(false),
    host_auto_fetch_not_guaranteed: z.literal(true),
    still_must_release: z.literal(true),
    next_step: z.string(),
    reason: z.literal("binary_or_non_previewable_media_type")
  }).strict()
]);

const ContentResultSchema = z.object({
  must_release: z.literal(true),
  content_delivery: ContentDeliverySchema,
  file: ItemSchema.extend({ ref: FileRefSchema }),
  version: FileVersionSchema.extend({ ref: VersionRefSchema.optional() }),
  selection: VersionSelectionProofSchema,
  assurance: z.object({
    level: z.enum(["content_integrity", "workspace_bound"]),
    verdict: z.literal("verified"),
    checks: z.object({
      content_sha1: VerificationStatusSchema,
      content_size: VerificationStatusSchema,
      version_history: VerificationStatusSchema,
      file_metadata_stability: VerificationStatusSchema,
      metadata_sha1_stability: VerificationStatusSchema,
      current_metadata_match: VerificationStatusSchema,
      workspace_membership: VerificationStatusSchema
    })
  }),
  workspace: z.object({ ref: WorkspaceRefSchema, root: FolderRefSchema, ancestor_folders: z.array(FolderRefSchema), relative_ancestor_chain: z.array(PathEntrySchema), path_basis: z.literal("configured_workspace_root"), membership: z.literal("inside") }).strict().optional(),
  expectation: ExpectationSchema,
  resource: ContentResourceSchema,
  provenance: z.array(ProvenanceSchema)
});

async function rollbackResource(runtime: AppRuntime, result: Record<string, unknown>): Promise<void> {
  const resource = result.resource && typeof result.resource === "object" && !Array.isArray(result.resource) ? result.resource as Record<string, unknown> : undefined;
  if (typeof resource?.resource_uri === "string") await runtime.evidence.release(resource.resource_uri);
}

function selectorFor(fileRef: string, versionRef: unknown): VersionSelector {
  if (versionRef === undefined) return { kind: "current" };
  const version = parseVersionRef(String(versionRef), fileRef);
  return { kind: "historical", version_id: version.providerVersionId };
}

function registerArtifactTools(server: McpServer, runtime: AppRuntime): void {
  server.registerResource(
    "yfy_content_resource",
    new ResourceTemplate("yfy://evidence/{token}", { list: undefined }),
    { title: "Yifangyun Content Resource", description: "Short-lived integrity-protected bytes produced by yfy_open or yfy_capture. Binary rendering depends on client attachment support.", mimeType: "application/octet-stream" },
    async (uri, variables) => {
      const resource = await runtime.evidence.read(String(variables.token));
      return { contents: [{ uri: uri.href, ...(resource.kind === "text" ? { text: resource.text } : { blob: resource.blob }), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) }] };
    }
  );

  server.registerResource(
    "yfy_content_manifest",
    new ResourceTemplate("yfy://evidence/{token}/manifest", { list: undefined }),
    { title: "Yifangyun Multipart Content Manifest", description: "Manifest for a verified content resource split into bounded parts.", mimeType: "application/json" },
    async (uri, variables) => {
      const token = String(variables.token);
      const manifest = await runtime.evidence.manifest(token);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ name: manifest.name, media_type: manifest.mimeType ?? "application/octet-stream", size_bytes: manifest.sizeBytes, part_size_bytes: manifest.partSizeBytes, parts: Array.from({ length: manifest.partCount }, (_, part) => ({ part, uri: `yfy://evidence/${token}/part/${part}` })) }) }] };
    }
  );

  server.registerResource(
    "yfy_content_part",
    new ResourceTemplate("yfy://evidence/{token}/part/{part}", { list: undefined }),
    { title: "Yifangyun Multipart Content Part", description: "One verified bounded part of a larger content resource. Binary rendering depends on client attachment support.", mimeType: "application/octet-stream" },
    async (uri, variables) => {
      const part = await runtime.evidence.readPart(String(variables.token), Number(variables.part));
      return { contents: [{ uri: uri.href, blob: part.blob, mimeType: part.mimeType ?? "application/octet-stream" }] };
    }
  );

  registerTool(server, "yfy_resource_release", {
    title: "Release Yifangyun Content Resource",
    description: "Delete a short-lived content resource and invalidate its URI. This operation is idempotent.",
    inputSchema: { resource_uri: z.union([EvidenceResourceUriSchema, EvidenceManifestUriSchema]) },
    outputSchema: { status: z.enum(["released", "already_unavailable"]), resource_uri: z.union([EvidenceResourceUriSchema, EvidenceManifestUriSchema]) }
  }, { readOnly: false, idempotent: true }, async ({ resource_uri }) => ({ status: await runtime.evidence.release(String(resource_uri)) ? "released" : "already_unavailable", resource_uri: String(resource_uri) }));
}

function registerOpenTool(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_open", {
    title: "Open Yifangyun File Content",
    description: "Open verified current or historical file bytes. Omit version for current content; copy a historical version ref from yfy_versions when needed. include_text_preview defaults true and may add a standard embedded MCP text resource. Inspect content_delivery and always release the returned resource.",
    inputSchema: { file: FileRefSchema, version: VersionRefSchema.optional(), include_text_preview: z.boolean().default(true) },
    outputSchema: ContentResultSchema
  }, { readOnly: true, idempotent: false, onInvalidOutput: (result) => rollbackResource(runtime, result) }, async ({ file, version, include_text_preview }, extra) => {
    const fileRef = String(file);
    const selector = selectorFor(fileRef, version);
    return captureVersionContent(runtime, {
      fileRef,
      includeTextPreview: include_text_preview !== false,
      onProgress: progressReporter(extra),
      selector,
      signal: extra.signal
    });
  });
}

function registerEvidenceTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_capture", {
    title: "Capture Yifangyun Workspace Content",
    description: "Capture verified current or historical bytes inside a configured workspace. Membership is checked before and after download. include_text_preview defaults true and may add a standard embedded MCP text resource. Inspect content_delivery and always release the returned resource.",
    inputSchema: {
      workspace: WorkspaceRefSchema,
      file: FileRefSchema,
      version: VersionRefSchema.optional(),
      include_text_preview: z.boolean().default(true),
      expected: z.object({
        sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional(),
        sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional(),
        size_bytes: z.number().int().nonnegative().optional(),
        modified_at_unix: z.number().int().nonnegative().optional(),
        file_version_key: z.string().trim().min(1).optional()
      }).optional()
    },
    outputSchema: ContentResultSchema
  }, { readOnly: true, idempotent: false, onInvalidOutput: (result) => rollbackResource(runtime, result) }, async (args, extra) => {
    const fileRef = String(args.file);
    const selector = selectorFor(fileRef, args.version);
    const expected = args.expected && typeof args.expected === "object" && !Array.isArray(args.expected) ? args.expected as Record<string, unknown> : undefined;
    if (selector.kind === "historical" && expected?.file_version_key !== undefined) {
      throw new YifangyunError("The current file version key cannot verify historical content.", {
        code: "YFY_INPUT_INVALID",
        phase: "content_capture",
        suggestedAction: "For historical content, use SHA-1, SHA-256, size, or modified time."
      });
    }
    return captureVersionContent(runtime, {
      expected,
      fileRef,
      includeTextPreview: args.include_text_preview !== false,
      onProgress: progressReporter(extra),
      selector,
      signal: extra.signal,
      workspaceRef: String(args.workspace)
    });
  });
}
