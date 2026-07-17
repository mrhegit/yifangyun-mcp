import { promises as fs } from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, versionSelectionProof, type EvidenceDownloadStrategy, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { idValue, objectValue, projectDepartment, projectItem, provenance } from "../domain/projectors.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { FileVersionSchema, ItemSchema, ProvenanceSchema, VersionSelectionProofSchema, VersionSelectorSchema } from "./schemas.js";

const IdSchema = z.string().trim().regex(/^\d+$/);

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
  const chain = Array.isArray(file.path_chain) ? file.path_chain : [];
  const ancestorIds = chain.flatMap((entry) => {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && typeof entry.id === "string") {
      return [entry.id];
    }
    return [];
  });
  return { ancestorIds, matched: ancestorIds.includes(rootFolderId) || file.parent_folder_id === rootFolderId };
}

function normalizedMediaType(contentType: unknown, detectedContentType: unknown): string {
  const providerType = typeof contentType === "string" ? contentType.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (/^[\w.+-]+\/[\w.+-]+$/.test(providerType) && providerType !== "application/octet-stream") return providerType;
  const detectedType = typeof detectedContentType === "string" ? detectedContentType.split(";", 1)[0]!.trim().toLowerCase() : "";
  return /^[\w.+-]+\/[\w.+-]+$/.test(detectedType) ? detectedType : "application/octet-stream";
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
  const common: JsonObject = {
    file_id: String(evidence.file_id),
    file_name: String(evidence.file_name),
    sha1: String(evidence.sha1),
    sha256: String(evidence.sha256),
    size_bytes: sizeBytes,
    media_type: mediaType,
    ...(typeof evidence.detected_content_type === "string" ? { detected_media_type: String(evidence.detected_content_type).split(";", 1)[0]!.trim().toLowerCase() } : {})
  };
  if (sizeBytes > maxResourceBytes) {
    if (runtime.config.transport === "http") {
      await removeEvidenceTemp(String(evidence.temp_path));
      return { ...common, delivery: "omitted", omission: { code: "YFY_EVIDENCE_RESOURCE_TOO_LARGE", max_resource_bytes: maxResourceBytes } };
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
      delivery: "local_file",
      resource_uri: resourceUri,
      local_path: String(evidence.temp_path),
      expires_at: new Date(Date.now() + (runtime.config.tempFileTtlSeconds ?? 86400) * 1000).toISOString(),
      resource_limit_bytes: maxResourceBytes
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

function assertEvidenceAnchors(file: JsonObject): void {
  const missing: string[] = [];
  if (typeof file.size_bytes !== "number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) missing.push("size_bytes");
  if (typeof file.modified_at_unix !== "number" || !Number.isSafeInteger(file.modified_at_unix) || file.modified_at_unix < 0) missing.push("modified_at_unix");
  if (typeof file.file_version_key !== "string" || file.file_version_key.length === 0) missing.push("file_version_key");
  if (!Array.isArray(file.path_chain) || file.path_chain.length === 0) missing.push("path_chain");
  if (missing.length > 0) {
    throw new YifangyunError("Provider metadata is incomplete for drift-safe evidence.", {
      code: "YFY_EVIDENCE_METADATA_INCOMPLETE",
      details: { missing_fields: missing },
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
    observations: [provenance(ticket.meta, input.accessContext), provenance(downloaded.meta, input.accessContext)],
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
    throw new YifangyunError("Provider 无法返回与所选历史版本元数据一致的内容。", {
      code: "YFY_HISTORICAL_CAPTURE_UNAVAILABLE",
      phase: "evidence_download_validation",
      agentDetails: {
        expected_sha1: input.selected.sha1 ?? null,
        expected_size_bytes: input.selected.size_bytes ?? null,
        provider_version_id: input.selected.provider_version_id ?? null,
        attempts
      },
      suggestedAction: "不要使用其他版本替代。可重新读取版本列表后重试，或报告该历史原件当前无法由 Provider 可靠导出。"
    });
  }
  throw new YifangyunError("Provider 返回的当前文件内容与版本元数据不一致。", {
    code: "YFY_EVIDENCE_CONTENT_MISMATCH",
    phase: "evidence_download_validation",
    agentDetails: { expected_sha1: input.selected.sha1 ?? null, expected_size_bytes: input.selected.size_bytes ?? null, attempts },
    suggestedAction: "重新读取文件元数据和版本列表后重试；不要使用本次下载内容。"
  });
}

export function registerAuthorityEvidenceTools(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("authority")) {
    registerAuthorityTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("evidence")) {
    registerEvidenceTools(server, runtime);
  }
}

function registerAuthorityTools(server: McpServer, runtime: AppRuntime): void {
  registerTool(server, "yfy_authority_validate", {
    title: "Validate Yifangyun Authority Scope",
    description: "Validate one configured authority scope, its folder metadata, department ancestry and first/last page reachability.",
    inputSchema: { scope_id: z.string().trim().min(1), expected_path: z.array(z.string().trim().min(1)).optional() },
    outputSchema: { scope: z.record(z.unknown()), folder: z.record(z.unknown()), business_path: z.array(z.string()), department_chain: z.array(z.record(z.unknown())), checks: z.record(z.unknown()), valid: z.boolean(), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: true }, async ({ scope_id, expected_path }, extra) => {
    const resolved = runtime.access.resolveScope(String(scope_id));
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
      scope: { id: resolved.scope.id, root_folder_id: resolved.scope.rootFolderId, access_context: resolved.context.id, tags: resolved.scope.tags },
      folder,
      business_path: businessPath,
      department_chain: departments,
      checks,
      valid: Object.values(checks).every((value) => value === true),
      provenance: [provenance(folderResponse.meta, resolved.context.id), provenance(firstPage.meta, resolved.context.id)]
    };
  });

  registerTool(server, "yfy_scope_check", {
    title: "Check Yifangyun File Scope",
    description: "Check whether a file belongs to a configured authority scope. Assert mode returns a tool error when outside scope.",
    inputSchema: { file_id: IdSchema, scope_id: z.string().trim().min(1), mode: z.enum(["query", "assert"]).default("query") },
    outputSchema: { file: z.record(z.unknown()), scope: z.record(z.unknown()), in_scope: z.boolean(), ancestor_folder_ids: z.array(z.string()), provenance: z.record(z.unknown()) }
  }, { readOnly: true }, async ({ file_id, scope_id, mode }, extra) => {
    const result = await getScopedFile(runtime, String(file_id), String(scope_id), extra.signal);
    metrics.increment("scope_assertion_total", { outcome: result.membership.matched ? "inside_scope" : "outside_scope" });
    if (!result.membership.matched && mode === "assert") {
      throw new YifangyunError("File is outside the configured authority scope.", {
        code: "YFY_SCOPE_ASSERTION_FAILED",
        details: { file_id: String(file_id), scope_id: String(scope_id), root_folder_id: result.scope.scope.rootFolderId, ancestor_folder_ids: result.membership.ancestorIds },
        phase: "scope_assertion"
      });
    }
    return {
      file: result.file,
      scope: { id: result.scope.scope.id, root_folder_id: result.scope.scope.rootFolderId },
      in_scope: result.membership.matched,
      ancestor_folder_ids: result.membership.ancestorIds,
      provenance: provenance(result.response.meta, result.scope.context.id)
    };
  });
}

async function captureVersionEvidence(runtime: AppRuntime, input: {
  fileId: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  scopeId: string;
  selector: VersionSelector;
  signal?: AbortSignal;
}) {
  const scopedBefore = await getScopedFile(runtime, input.fileId, input.scopeId, input.signal);
  const before = scopedBefore.file;
  assertEvidenceAnchors(before);
  if (!scopedBefore.membership.matched) {
    throw new YifangyunError("文件不属于指定 Authority Scope。", {
      code: "YFY_SCOPE_ASSERTION_FAILED",
      phase: "evidence_scope",
      agentDetails: { file_id: input.fileId, scope_id: input.scopeId, ancestor_folder_ids: scopedBefore.membership.ancestorIds }
    });
  }
  const versionsBefore = await observeVersions(runtime, input.fileId, scopedBefore.scope.context.id, input.signal);
  const selected = selectFileVersion(versionsBefore.versions, input.selector);
  if (input.selector.kind === "historical") {
    const duplicateContentVersions = versionsBefore.versions.filter((version) => version.generation !== selected.generation && version.sha1 === selected.sha1 && version.size_bytes === selected.size_bytes);
    if (duplicateContentVersions.length > 0) {
      throw new YifangyunError("所选历史版本与其他版本具有相同的内容身份，无法仅凭字节证明具体代次。", {
        code: "YFY_VERSION_CONTENT_IDENTITY_AMBIGUOUS",
        phase: "version_selection",
        agentDetails: { provider_version_id: selected.provider_version_id ?? null, indistinguishable_version_ids: duplicateContentVersions.flatMap((version) => version.provider_version_id ? [version.provider_version_id] : []) },
        suggestedAction: "选择 SHA-1 或大小不同的历史版本；如果只需要字节，可捕获当前版，但不要声称它代表指定历史代次。"
      });
    }
  }
  const observations: JsonObject[] = [
    provenance(scopedBefore.response.meta, scopedBefore.scope.context.id),
    provenance(versionsBefore.response.meta, scopedBefore.scope.context.id)
  ];
  const downloaded = await downloadSelectedVersion(runtime, {
    accessContext: scopedBefore.scope.context.id,
    externalEnterpriseId: scopedBefore.scope.context.externalEnterpriseId,
    file: before,
    fileId: input.fileId,
    identityRef: scopedBefore.scope.identityRef,
    onProgress: input.onProgress,
    selected,
    selector: input.selector,
    signal: input.signal,
    versions: versionsBefore.versions
  });
  observations.push(...downloaded.observations);
  try {
    const versionsAfter = await observeVersions(runtime, input.fileId, scopedBefore.scope.context.id, input.signal);
    observations.push(provenance(versionsAfter.response.meta, scopedBefore.scope.context.id));
    if (versionsBefore.fingerprint !== versionsAfter.fingerprint) {
      throw new YifangyunError("取证期间文件版本历史发生变化。", { code: "YFY_EVIDENCE_DRIFT", phase: "evidence_version_recheck", retryable: true, suggestedAction: "重新读取版本列表并重新捕获。" });
    }
    const scopedAfter = await getScopedFile(runtime, input.fileId, input.scopeId, input.signal);
    assertEvidenceAnchors(scopedAfter.file);
    observations.push(provenance(scopedAfter.response.meta, scopedAfter.scope.context.id));
    const beforeSha1 = typeof before.sha1 === "string" && /^[a-f\d]{40}$/i.test(before.sha1) ? before.sha1.toLowerCase() : undefined;
    const afterSha1 = typeof scopedAfter.file.sha1 === "string" && /^[a-f\d]{40}$/i.test(scopedAfter.file.sha1) ? scopedAfter.file.sha1.toLowerCase() : undefined;
    const integrity: JsonObject = {
      content_sha1: true,
      content_size: true,
      version_history_stable: true,
      file_version_key_stable: before.file_version_key === scopedAfter.file.file_version_key,
      modified_at_stable: before.modified_at_unix === scopedAfter.file.modified_at_unix,
      size_stable: before.size_bytes === scopedAfter.file.size_bytes,
      metadata_sha1_stable: beforeSha1 === afterSha1,
      current_metadata_size_matches: input.selector.kind === "historical" || (before.size_bytes === selected.size_bytes && scopedAfter.file.size_bytes === selected.size_bytes),
      current_metadata_sha1_matches: input.selector.kind === "historical" || ([beforeSha1, afterSha1].filter((value): value is string => value !== undefined).every((value) => value === selected.sha1)),
      path_stable: JSON.stringify(before.path_chain) === JSON.stringify(scopedAfter.file.path_chain),
      scope_stable: scopedAfter.membership.matched
    };
    if (!Object.values(integrity).every((value) => value === true)) {
      throw new YifangyunError("取证期间文件元数据或 Authority Scope 发生变化。", {
        code: "YFY_EVIDENCE_DRIFT",
        phase: "evidence_recheck",
        retryable: true,
        agentDetails: integrity,
        suggestedAction: "重新解析文件路径并重新捕获；不要使用本次 Artifact。"
      });
    }
    const selection = versionSelectionProof(selected, input.selector, downloaded.strategy);
    const artifact = await attachEvidenceArtifact(runtime, downloaded.evidence);
    return {
      file: scopedAfter.file,
      version: selected as unknown as JsonObject,
      selection,
      authority: {
        scope_id: scopedAfter.scope.scope.id,
        root_folder_id: scopedAfter.scope.scope.rootFolderId,
        ancestor_folder_ids: scopedAfter.membership.ancestorIds,
        in_scope: true
      },
      integrity,
      artifact,
      provenance: observations
    };
  } catch (error) {
    if (typeof downloaded.evidence.temp_path === "string") {
      await removeEvidenceTemp(downloaded.evidence.temp_path);
    }
    throw error;
  }
}

const EvidenceArtifactBaseShape = {
  file_id: z.string(),
  file_name: z.string(),
  sha1: z.string().regex(/^[a-f\d]{40}$/i),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
  size_bytes: z.number().int().nonnegative(),
  media_type: z.string(),
  detected_media_type: z.string().optional()
};
const EvidenceResourceUriSchema = z.string().regex(/^yfy:\/\/evidence\/[a-f0-9]{48}$/);
const EvidenceArtifactSchema = z.discriminatedUnion("delivery", [
  z.object({ ...EvidenceArtifactBaseShape, delivery: z.literal("mcp_resource"), resource_uri: EvidenceResourceUriSchema, expires_at: z.string() }),
  z.object({ ...EvidenceArtifactBaseShape, delivery: z.literal("local_file"), resource_uri: EvidenceResourceUriSchema, local_path: z.string(), expires_at: z.string(), resource_limit_bytes: z.number().int().positive() }),
  z.object({ ...EvidenceArtifactBaseShape, delivery: z.literal("omitted"), omission: z.object({ code: z.literal("YFY_EVIDENCE_RESOURCE_TOO_LARGE"), max_resource_bytes: z.number().int().positive() }) })
]);

const ExpectationSchema = z.object({
  matches: z.boolean(),
  checks: z.record(z.boolean())
});

const EvidenceCaptureResultSchema = z.object({
  file: ItemSchema,
  version: FileVersionSchema,
  selection: VersionSelectionProofSchema,
  authority: z.object({ scope_id: z.string(), root_folder_id: z.string(), ancestor_folder_ids: z.array(z.string()), in_scope: z.literal(true) }),
  integrity: z.object({
    content_sha1: z.literal(true),
    content_size: z.literal(true),
    version_history_stable: z.literal(true),
    file_version_key_stable: z.literal(true),
    modified_at_stable: z.literal(true),
    size_stable: z.literal(true),
    metadata_sha1_stable: z.literal(true),
    current_metadata_size_matches: z.literal(true),
    current_metadata_sha1_matches: z.literal(true),
    path_stable: z.literal(true),
    scope_stable: z.literal(true)
  }),
  artifact: EvidenceArtifactSchema,
  expectation: ExpectationSchema.optional(),
  provenance: z.array(ProvenanceSchema)
});

async function rollbackArtifact(runtime: AppRuntime, result: Record<string, unknown>): Promise<void> {
  const artifact = result.artifact && typeof result.artifact === "object" && !Array.isArray(result.artifact) ? result.artifact as Record<string, unknown> : undefined;
  if (typeof artifact?.resource_uri === "string") {
    await runtime.evidence.release(artifact.resource_uri);
  } else if (typeof artifact?.local_path === "string") {
    await fs.rm(artifact.local_path, { force: true });
  }
}

function registerEvidenceTools(server: McpServer, runtime: AppRuntime): void {
  server.registerResource(
    "yfy_evidence_artifact",
    new ResourceTemplate("yfy://evidence/{token}", { list: undefined }),
    { title: "Yifangyun Evidence Artifact", description: "Short-lived integrity-protected bytes produced by yfy_evidence_capture.", mimeType: "application/octet-stream" },
    async (uri, variables) => {
      const artifact = await runtime.evidence.read(String(variables.token));
      return { contents: [{ uri: uri.href, blob: artifact.blob, ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}) }] };
    }
  );

  registerTool(server, "yfy_evidence_capture", {
    title: "Capture Yifangyun Evidence",
    description: "Capture current or exact historical bytes inside an Authority Scope. The tool validates scope membership, version history, metadata, SHA-1, and size, then returns a releasable artifact. Do not call it when metadata alone is sufficient.",
    inputSchema: {
      scope_id: z.string().trim().min(1).describe("Configured Authority Scope ID. Access identity is derived from this scope."),
      file_id: IdSchema.describe("Numeric string ID of the file to capture."),
      version: VersionSelectorSchema.default({ kind: "current" }),
      expected: z.object({
        sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional(),
        sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional(),
        size_bytes: z.number().int().nonnegative().optional(),
        modified_at_unix: z.number().int().nonnegative().optional(),
        file_version_key: z.string().trim().min(1).optional()
      }).optional().describe("Optional expected values. When provided, the result includes expectation.matches and per-field checks.")
    },
    outputSchema: EvidenceCaptureResultSchema
  }, { readOnly: false, idempotent: false, onInvalidOutput: (result) => rollbackArtifact(runtime, result) }, async (args, extra) => {
    const selector = (args.version ?? { kind: "current" }) as VersionSelector;
    const expected = args.expected && typeof args.expected === "object" && !Array.isArray(args.expected) ? args.expected as Record<string, unknown> : undefined;
    if (selector.kind === "historical" && expected?.file_version_key !== undefined) {
      throw new YifangyunError("当前文件版本键不能用于验证历史版本。", {
        code: "YFY_INPUT_INVALID",
        phase: "evidence_capture",
        suggestedAction: "历史版本请使用 SHA-1、SHA-256、大小或修改时间作为期望值。"
      });
    }
    const captured = await captureVersionEvidence(runtime, { fileId: String(args.file_id), onProgress: progressReporter(extra), scopeId: String(args.scope_id), selector, signal: extra.signal });
    if (!expected || Object.keys(expected).length === 0) return captured;
    const file = captured.file as JsonObject;
    const version = captured.version as unknown as FileVersion;
    const artifact = captured.artifact as JsonObject;
    const checks: JsonObject = {};
    if (typeof expected.sha1 === "string") checks.sha1 = artifact.sha1 === expected.sha1.toLowerCase();
    if (typeof expected.sha256 === "string") checks.sha256 = artifact.sha256 === expected.sha256.toLowerCase();
    if (expected.size_bytes !== undefined) checks.size_bytes = artifact.size_bytes === expected.size_bytes;
    if (expected.modified_at_unix !== undefined) checks.modified_at_unix = version.modified_at_unix === expected.modified_at_unix;
    if (expected.file_version_key !== undefined) checks.file_version_key = file.file_version_key === expected.file_version_key;
    return { ...captured, expectation: { checks, matches: Object.values(checks).every((value) => value === true) } };
  });

  registerTool(server, "yfy_evidence_release", {
    title: "Release Yifangyun Evidence",
    description: "Delete a short-lived artifact and invalidate its resource URI. This operation is idempotent; expired or previously released artifacts return already_unavailable.",
    inputSchema: { resource_uri: z.string().regex(/^yfy:\/\/evidence\/[a-f0-9]{48}$/) },
    outputSchema: { status: z.enum(["released", "already_unavailable"]), resource_uri: z.string() }
  }, { readOnly: false, idempotent: true }, async ({ resource_uri }) => ({ status: await runtime.evidence.release(String(resource_uri)) ? "released" : "already_unavailable", resource_uri: String(resource_uri) }));
}
