import { promises as fs } from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, versionSelectionProof, type EvidenceDownloadStrategy, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { idValue, objectValue, projectDepartment, projectItem, provenance } from "../domain/projectors.js";
import { parseItemRef, parseVersionRef } from "../domain/refs.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { FileRefSchema, FileVersionSchema, ItemSchema, PathEntrySchema, PlaceRefSchema, ProvenanceSchema, VerificationStatusSchema, VersionRefSchema, VersionSelectionProofSchema } from "./schemas.js";

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

function inScope(file: JsonObject, rootFolderId: string): { ancestorIds: string[]; matched: boolean } {
  const chain = Array.isArray(file.provider_path_chain) ? file.provider_path_chain : [];
  const ancestorIds = chain.flatMap((entry) => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry.id === "string") {
      return [entry.id];
    }
    return [];
  });
  return { ancestorIds, matched: ancestorIds.includes(rootFolderId) || file.parent_folder_id === rootFolderId };
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

function normalizeSingleMediaType(value: unknown): string | undefined {
  const mediaType = typeof value === "string" ? value.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) return undefined;
  return MEDIA_TYPE_ALIASES[mediaType] ?? mediaType;
}

export function normalizedMediaType(contentType: unknown, detectedContentType: unknown): string {
  const providerType = normalizeSingleMediaType(contentType);
  if (providerType && providerType !== "application/octet-stream") return providerType;
  return normalizeSingleMediaType(detectedContentType) ?? "application/octet-stream";
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
  const mediaType = normalizedMediaType(evidence.content_type, evidence.detected_content_type);
  const detectedMediaType = normalizeSingleMediaType(evidence.detected_content_type);
  const common: JsonObject = {
    file: `file:${String(evidence.file_id)}`,
    file_name: String(evidence.file_name),
    sha1: String(evidence.sha1),
    sha256: String(evidence.sha256),
    size_bytes: sizeBytes,
    media_type: mediaType,
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

async function getScopedFile(runtime: AppRuntime, fileId: string, scopeId: string, signal?: AbortSignal) {
  const scope = runtime.access.resolveScope(scopeId);
  const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/info_v2`, scope.context.id, scope.context.externalEnterpriseId
    ? { external_enterprise_id: scope.context.externalEnterpriseId }
    : {}, signal);
  const file = projectItem(response.data, "evidence");
  const membership = inScope(file, scope.scope.rootFolderId);
  return { file, membership, response, scope };
}

async function observeVersions(runtime: AppRuntime, fileId: string, accessContext: string, signal?: AbortSignal) {
  const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/versions`, accessContext, {}, signal);
  return { ...normalizeFileVersions(response.data), response };
}

async function downloadAttempt(runtime: AppRuntime, input: { accessContext: string; downloadSelector: number | string; externalEnterpriseId?: string; file: JsonObject; fileId: string; identityRef: string; onProgress?: (bytes: number, totalBytes?: number) => void; signal?: AbortSignal; strategy: EvidenceDownloadStrategy }) {
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
    description: "Validate one configured workspace, its folder metadata, business path and first/last page reachability.",
    inputSchema: { workspace: z.string().trim().min(1), expected_path: z.array(z.string().trim().min(1)).optional() },
    outputSchema: { workspace: z.object({ id: z.string(), ref: PlaceRefSchema, root_folder_id: z.string(), tags: z.array(z.string()) }), folder: ItemSchema.extend({ ref: z.string().regex(/^folder:\d+$/) }), business_path: z.array(z.string()), department_chain: z.array(z.record(z.unknown())), checks: z.record(z.unknown()), valid: z.boolean(), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: true }, async ({ workspace, expected_path }, extra) => {
    const resolved = runtime.access.resolveScope(String(workspace));
    const folderResponse = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/info`, resolved.context.id, {}, extra.signal);
    const folder = projectItem(folderResponse.data, "evidence");
    const source = objectValue(folderResponse.data) ?? {};
    const space = objectValue(source.space);
    const departments: JsonObject[] = [];
    const seen = new Set<string>();
    let departmentId = idValue(space?.id);
    while (departmentId && departmentId !== "0" && !seen.has(departmentId) && departments.length < 50) {
      seen.add(departmentId);
      const response = await runtime.gateway.getEnterprise(`/v2/admin/department/${encodeURIComponent(departmentId)}/info`, {}, extra.signal);
      const department = projectDepartment(response.data);
      departments.unshift(department);
      departmentId = typeof department.parent_id === "string" ? department.parent_id : undefined;
    }
    const firstPage = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/children`, resolved.context.id, { type: "all", page_id: 0, page_capacity: 1 }, extra.signal);
    const firstSource = objectValue(firstPage.data) ?? {};
    const pageCount = typeof firstSource.page_count === "number" ? firstSource.page_count : undefined;
    if (pageCount && pageCount > 1) {
      await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(resolved.scope.rootFolderId)}/children`, resolved.context.id, { type: "all", page_id: pageCount - 1, page_capacity: 1 }, extra.signal);
    }
    const businessPath = [...departments.map((entry) => String(entry.name ?? "")), String(folder.name ?? "")].filter(Boolean);
    const expected = Array.isArray(expected_path) ? expected_path.map(String) : undefined;
    const checks: JsonObject = {
      exists: typeof folder.id === "string",
      not_deleted: folder.is_deleted !== true && folder.in_trash !== true,
      first_page_reachable: true,
      last_page_reachable: true,
      expected_path_matches: !expected || JSON.stringify(businessPath.slice(-expected.length)) === JSON.stringify(expected)
    };
    return {
      workspace: { id: resolved.scope.id, ref: `workspace:${resolved.scope.id}`, root_folder_id: resolved.scope.rootFolderId, tags: resolved.scope.tags },
      folder: { ...folder, ref: `folder:${resolved.scope.rootFolderId}` },
      business_path: businessPath,
      department_chain: departments,
      checks,
      valid: Object.values(checks).every((value) => value === true),
      provenance: [provenance(folderResponse.meta, resolved.context.id), provenance(firstPage.meta, resolved.context.id)]
    };
  });

  registerTool(server, "yfy_membership_check", {
    title: "Check Yifangyun Workspace Membership",
    description: "Check whether a file belongs to a configured workspace. Assert mode returns a tool error when outside it.",
    inputSchema: { file: FileRefSchema, workspace: z.string().trim().min(1), mode: z.enum(["query", "assert"]).default("query") },
    outputSchema: { file: ItemSchema.extend({ ref: FileRefSchema }), workspace: z.object({ id: z.string(), ref: PlaceRefSchema, root_folder_id: z.string() }), in_workspace: z.boolean(), ancestor_folder_ids: z.array(z.string()), workspace_relative_ancestor_chain: z.array(PathEntrySchema), path_basis: z.literal("configured_workspace_root"), provenance: z.record(z.unknown()) }
  }, { readOnly: true }, async ({ file, workspace, mode }, extra) => {
    const item = parseItemRef(String(file));
    const result = await getScopedFile(runtime, item.id, String(workspace), extra.signal);
    metrics.increment("scope_assertion_total", { outcome: result.membership.matched ? "inside_scope" : "outside_scope" });
    if (!result.membership.matched && mode === "assert") {
      throw new YifangyunError("File is outside the configured workspace.", {
        code: "YFY_WORKSPACE_MEMBERSHIP_FAILED",
        agentDetails: { file_ref: String(file), file_id: item.id, workspace: String(workspace), root_folder_id: result.scope.scope.rootFolderId, observed_ancestor_folder_ids: result.membership.ancestorIds, reason: "outside_workspace" },
        phase: "workspace_membership"
      });
    }
    return {
      file: { ...result.file, ref: String(file) },
      workspace: { id: result.scope.scope.id, ref: `workspace:${result.scope.scope.id}`, root_folder_id: result.scope.scope.rootFolderId },
      in_workspace: result.membership.matched,
      ancestor_folder_ids: result.membership.ancestorIds,
      workspace_relative_ancestor_chain: workspaceRelativeAncestors(result.file, result.scope.scope.rootFolderId),
      path_basis: "configured_workspace_root",
      provenance: provenance(result.response.meta, result.scope.context.id)
    };
  });
}

async function captureVersionContent(runtime: AppRuntime, input: {
  accessContextId?: string;
  expected?: Record<string, unknown>;
  fileId: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  scopeId?: string;
  selector: VersionSelector;
  signal?: AbortSignal;
}) {
  const scopedBefore = input.scopeId ? await getScopedFile(runtime, input.fileId, input.scopeId, input.signal) : undefined;
  const access = scopedBefore?.scope ?? runtime.gateway.context(input.accessContextId);
  const beforeResponse = scopedBefore?.response ?? await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/info_v2`, access.context.id, access.context.externalEnterpriseId ? { external_enterprise_id: access.context.externalEnterpriseId } : {}, input.signal);
  const before = scopedBefore?.file ?? projectItem(beforeResponse.data, "evidence");
  assertEvidenceAnchors(before, Boolean(input.scopeId));
  if (scopedBefore && !scopedBefore.membership.matched) {
    throw new YifangyunError("The file is outside the configured workspace.", {
      code: "YFY_WORKSPACE_MEMBERSHIP_FAILED",
      phase: "workspace_membership",
      agentDetails: { file_ref: `file:${input.fileId}`, file_id: input.fileId, workspace: input.scopeId!, root_folder_id: scopedBefore.scope.scope.rootFolderId, observed_ancestor_folder_ids: scopedBefore.membership.ancestorIds, reason: "outside_workspace" }
    });
  }
  const versionsBefore = await observeVersions(runtime, input.fileId, access.context.id, input.signal);
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
  const observations: JsonObject[] = [provenance(beforeResponse.meta, access.context.id, "file_metadata_before"), provenance(versionsBefore.response.meta, access.context.id, "version_history_before")];
  const downloaded = await downloadSelectedVersion(runtime, {
    accessContext: access.context.id,
    externalEnterpriseId: access.context.externalEnterpriseId,
    file: before,
    fileId: input.fileId,
    identityRef: access.identityRef,
    onProgress: input.onProgress,
    selected,
    selector: input.selector,
    signal: input.signal,
    versions: versionsBefore.versions
  });
  observations.push(...downloaded.observations);
  try {
    const versionsAfter = await observeVersions(runtime, input.fileId, access.context.id, input.signal);
    observations.push(provenance(versionsAfter.response.meta, access.context.id, "version_history_after"));
    if (versionsBefore.fingerprint !== versionsAfter.fingerprint) {
      throw new YifangyunError("File version history changed while content was being captured.", { code: "YFY_EVIDENCE_DRIFT", phase: "version_recheck", retryable: true, suggestedAction: "Restart the operation from yfy_versions." });
    }
    const scopedAfter = input.scopeId ? await getScopedFile(runtime, input.fileId, input.scopeId, input.signal) : undefined;
    const afterResponse = scopedAfter?.response ?? await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/info_v2`, access.context.id, access.context.externalEnterpriseId ? { external_enterprise_id: access.context.externalEnterpriseId } : {}, input.signal);
    const after = scopedAfter?.file ?? projectItem(afterResponse.data, "evidence");
    assertEvidenceAnchors(after, Boolean(input.scopeId));
    observations.push(provenance(afterResponse.meta, access.context.id, "file_metadata_after"));
    const beforeSha1 = typeof before.sha1 === "string" && /^[a-f\d]{40}$/i.test(before.sha1) ? before.sha1.toLowerCase() : undefined;
    const afterSha1 = typeof after.sha1 === "string" && /^[a-f\d]{40}$/i.test(after.sha1) ? after.sha1.toLowerCase() : undefined;
    const stable = {
      file_version_key: before.file_version_key === after.file_version_key,
      modified_at: before.modified_at_unix === after.modified_at_unix,
      size: before.size_bytes === after.size_bytes,
      metadata_sha1: beforeSha1 === undefined || afterSha1 === undefined || beforeSha1 === afterSha1,
      path: JSON.stringify(before.provider_path_chain) === JSON.stringify(after.provider_path_chain),
      workspace_membership: !input.scopeId || scopedAfter?.membership.matched === true,
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
      workspace_membership: input.scopeId ? "pass" : "not_applicable"
    };
    const resource = await attachEvidenceArtifact(runtime, downloaded.evidence);
    return {
      file: { ...after, ref: `file:${input.fileId}` },
      version: { ...selected, ...(!selected.current ? { ref: `version:${input.fileId}:${selected.provider_version_id}` } : {}) },
      selection: versionSelectionProof(selected, input.selector, downloaded.strategy),
      assurance: { level: input.scopeId ? "workspace_bound" : "content_integrity", verdict: "verified", checks },
      ...(input.scopeId && scopedAfter ? { workspace: { id: input.scopeId, ref: `workspace:${input.scopeId}`, root_folder_id: scopedAfter.scope.scope.rootFolderId, ancestor_folder_ids: scopedAfter.membership.ancestorIds, relative_ancestor_chain: workspaceRelativeAncestors(after, scopedAfter.scope.scope.rootFolderId), path_basis: "configured_workspace_root", membership: "verified" } } : {}),
      expectation: { verdict: Object.keys(expectationChecks).length > 0 ? "matched" : "not_provided", checks: expectationChecks },
      resource,
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
  detected_media_type: z.string().optional()
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

const ContentResultSchema = z.object({
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
  workspace: z.object({ id: z.string(), ref: PlaceRefSchema, root_folder_id: z.string(), ancestor_folder_ids: z.array(z.string()), relative_ancestor_chain: z.array(PathEntrySchema), path_basis: z.literal("configured_workspace_root"), membership: z.literal("verified") }).optional(),
  expectation: ExpectationSchema,
  resource: ContentResourceSchema,
  provenance: z.array(ProvenanceSchema)
});

async function rollbackResource(runtime: AppRuntime, result: Record<string, unknown>): Promise<void> {
  const resource = result.resource && typeof result.resource === "object" && !Array.isArray(result.resource) ? result.resource as Record<string, unknown> : undefined;
  if (typeof resource?.resource_uri === "string") await runtime.evidence.release(resource.resource_uri);
}

function selectorFor(fileId: string, versionRef: unknown): VersionSelector {
  if (versionRef === undefined) return { kind: "current" };
  const version = parseVersionRef(String(versionRef), fileId);
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
    description: "Open verified current or historical file bytes. Omit version for current content; copy a historical version ref from yfy_versions when needed. Always release the returned resource after use.",
    inputSchema: { file: FileRefSchema, version: VersionRefSchema.optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: ContentResultSchema
  }, { readOnly: true, idempotent: false, onInvalidOutput: (result) => rollbackResource(runtime, result) }, async ({ file, version, access_context }, extra) => {
    const item = parseItemRef(String(file));
    const selector = selectorFor(item.id, version);
    return captureVersionContent(runtime, {
      accessContextId: typeof access_context === "string" ? access_context : undefined,
      fileId: item.id,
      onProgress: progressReporter(extra),
      selector,
      signal: extra.signal
    });
  });
}

function registerEvidenceTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_capture", {
    title: "Capture Yifangyun Workspace Content",
    description: "Capture verified current or historical bytes inside a configured workspace. Workspace membership is checked before and after download. Always release the returned resource after use.",
    inputSchema: {
      workspace: z.string().trim().min(1),
      file: FileRefSchema,
      version: VersionRefSchema.optional(),
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
    const item = parseItemRef(String(args.file));
    const selector = selectorFor(item.id, args.version);
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
      fileId: item.id,
      onProgress: progressReporter(extra),
      scopeId: String(args.workspace),
      selector,
      signal: extra.signal
    });
  });
}
