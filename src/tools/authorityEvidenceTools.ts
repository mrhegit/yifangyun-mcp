import { promises as fs } from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, versionSelectionProof, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { arrayValue, idValue, objectValue, projectDepartment, projectItem, projectPath, provenance } from "../domain/projectors.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";
import { VersionSelectorSchema } from "./schemas.js";

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

async function attachEvidenceResource(runtime: AppRuntime, evidence: JsonObject): Promise<void> {
  const sizeBytes = typeof evidence.size_bytes === "number" ? evidence.size_bytes : Number.MAX_SAFE_INTEGER;
  const maxResourceBytes = runtime.config.maxEvidenceResourceBytes ?? 16777216;
  if (sizeBytes > maxResourceBytes) {
    evidence.resource_omitted = { code: "YFY_EVIDENCE_RESOURCE_TOO_LARGE", max_resource_bytes: maxResourceBytes, size_bytes: sizeBytes };
    if (runtime.config.transport === "http") {
      try {
        await fs.rm(String(evidence.temp_path), { force: true });
      } catch {
        await runtime.evidence.register({
          path: String(evidence.temp_path), name: String(evidence.file_name), expectedSize: sizeBytes,
          expectedSha256: String(evidence.sha256), mimeType: "application/octet-stream"
        });
        evidence.__registry_owned = true;
        throw new YifangyunError("Validated evidence could not be removed from temporary storage.", { code: "YFY_EVIDENCE_CLEANUP_FAILED", phase: "evidence_cleanup", retryable: true });
      }
      evidence.artifact_disposition = "deleted_after_validation";
    }
  } else {
    evidence.resource_uri = await runtime.evidence.register({
      path: String(evidence.temp_path),
      name: String(evidence.file_name),
      expectedSize: sizeBytes,
      expectedSha256: String(evidence.sha256),
      mimeType: "application/octet-stream"
    });
  }
  if (runtime.config.transport === "http") delete evidence.temp_path;
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

function assertVerificationAnchors(file: JsonObject): void {
  const missing: string[] = [];
  if (typeof file.size_bytes !== "number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) missing.push("size_bytes");
  if (typeof file.modified_at_unix !== "number" || !Number.isSafeInteger(file.modified_at_unix) || file.modified_at_unix < 0) missing.push("modified_at_unix");
  if (typeof file.file_version_key !== "string" || file.file_version_key.length === 0) missing.push("file_version_key");
  if (missing.length > 0) {
    throw new YifangyunError("Provider metadata is incomplete for content verification.", {
      code: "YFY_EVIDENCE_METADATA_INCOMPLETE",
      details: { missing_fields: missing },
      phase: "evidence_metadata",
      suggestedAction: "Retry after the Provider exposes version, modified time and size metadata."
    });
  }
}

async function download(runtime: AppRuntime, input: { accessContext: string; downloadVersion: number; externalEnterpriseId?: string; file: JsonObject; fileId: string; identityRef: string; onProgress?: (bytes: number, totalBytes?: number) => void; signal?: AbortSignal }) {
  const ticket = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/download_v2`, input.accessContext, {
    version: input.downloadVersion,
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
      provider_download_version: input.downloadVersion,
      file_name: downloaded.fileName,
      temp_path: downloaded.tempPath,
      sha1: downloaded.sha1,
      sha256: downloaded.sha256,
      size_bytes: downloaded.sizeBytes,
      ...(downloaded.contentType ? { content_type: downloaded.contentType } : {}),
      ...(downloaded.detectedContentType ? { detected_content_type: downloaded.detectedContentType } : {})
    } as JsonObject,
    observations: [provenance(ticket.meta, input.accessContext), provenance(downloaded.meta, input.accessContext)]
  };
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
  accessContext: string;
  externalEnterpriseId?: string;
  fileId: string;
  identityRef: string;
  lockScopeId?: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  selector: VersionSelector;
  signal?: AbortSignal;
}) {
  const infoResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/info_v2`, input.accessContext, input.externalEnterpriseId
    ? { external_enterprise_id: input.externalEnterpriseId }
    : {}, input.signal);
  const before = projectItem(infoResponse.data, "evidence");
  const versionsBefore = await observeVersions(runtime, input.fileId, input.accessContext, input.signal);
  const selected = selectFileVersion(versionsBefore.versions, input.selector);
  if (input.selector.kind === "history") {
    const duplicateContentVersions = versionsBefore.versions.filter((version) => version.download_version !== selected.download_version && version.sha1 === selected.sha1 && version.size_bytes === selected.size_bytes);
    if (duplicateContentVersions.length > 0) {
      throw new YifangyunError("The requested historical generation cannot be distinguished from another version by content metadata.", {
        code: "YFY_VERSION_CONTENT_IDENTITY_AMBIGUOUS",
        phase: "version_selection",
        details: { provider_download_version: selected.download_version, indistinguishable_download_versions: duplicateContentVersions.map((version) => version.download_version) },
        suggestedAction: "Use the current version when only the bytes are required, or choose a historical generation with distinct SHA-1 and size metadata."
      });
    }
  }
  const observations: JsonObject[] = [provenance(infoResponse.meta, input.accessContext), provenance(versionsBefore.response.meta, input.accessContext)];
  let scopeProof: JsonObject | undefined;
  if (input.lockScopeId) {
    assertEvidenceAnchors(before);
    const scope = runtime.access.resolveScope(input.lockScopeId);
    const membership = inScope(before, scope.scope.rootFolderId);
    if (!membership.matched) throw new YifangyunError("File is outside the configured authority scope.", { code: "YFY_SCOPE_ASSERTION_FAILED", phase: "evidence_scope" });
    scopeProof = { scope_id: scope.scope.id, root_folder_id: scope.scope.rootFolderId, ancestor_folder_ids: membership.ancestorIds, in_scope: true };
  }
  const downloaded = await download(runtime, {
    accessContext: input.accessContext,
    downloadVersion: selected.download_version,
    externalEnterpriseId: input.externalEnterpriseId,
    file: before,
    fileId: input.fileId,
    identityRef: input.identityRef,
    onProgress: input.onProgress,
    signal: input.signal
  });
  observations.push(...downloaded.observations);
  try {
    if (downloaded.evidence.sha1 !== selected.sha1 || downloaded.evidence.size_bytes !== selected.size_bytes) {
      const current = versionsBefore.versions[0]!;
      const fallbackToCurrent = input.selector.kind === "history" && downloaded.evidence.sha1 === current.sha1 && downloaded.evidence.size_bytes === current.size_bytes;
      throw new YifangyunError(fallbackToCurrent ? "Provider silently returned the current file instead of the requested historical version." : "Downloaded content does not match the selected file version.", {
        code: fallbackToCurrent ? "YFY_DOWNLOAD_VERSION_FALLBACK_DETECTED" : "YFY_EVIDENCE_CONTENT_MISMATCH",
        phase: "evidence_download_validation",
        details: { expected_sha1: selected.sha1!, actual_sha1: String(downloaded.evidence.sha1), expected_size_bytes: selected.size_bytes!, actual_size_bytes: Number(downloaded.evidence.size_bytes), provider_download_version: selected.download_version }
      });
    }
    const versionsAfter = await observeVersions(runtime, input.fileId, input.accessContext, input.signal);
    observations.push(provenance(versionsAfter.response.meta, input.accessContext));
    if (versionsBefore.fingerprint !== versionsAfter.fingerprint) {
      throw new YifangyunError("File version history changed while evidence was being captured.", { code: "YFY_EVIDENCE_DRIFT", phase: "evidence_version_recheck", retryable: true });
    }
    let file = before;
    let driftChecks: JsonObject | undefined;
    if (input.selector.kind === "current" || input.lockScopeId) {
      const finalResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/info_v2`, input.accessContext, input.externalEnterpriseId
        ? { external_enterprise_id: input.externalEnterpriseId }
        : {}, input.signal);
      const after = projectItem(finalResponse.data, "evidence");
      observations.push(provenance(finalResponse.meta, input.accessContext));
      if (input.lockScopeId) assertEvidenceAnchors(after); else assertVerificationAnchors(after);
      driftChecks = {
        version_history: true,
        file_version_key: before.file_version_key === after.file_version_key,
        modified_at_unix: before.modified_at_unix === after.modified_at_unix,
        size_bytes: before.size_bytes === after.size_bytes && after.size_bytes === downloaded.evidence.size_bytes,
        ...(input.lockScopeId ? { path_chain: JSON.stringify(before.path_chain) === JSON.stringify(after.path_chain), scope_unchanged: inScope(after, runtime.access.resolveScope(input.lockScopeId).scope.rootFolderId).matched } : {})
      };
      if (!Object.values(driftChecks).every((value) => value === true)) throw new YifangyunError("File changed while evidence was being captured.", { code: "YFY_EVIDENCE_DRIFT", phase: "evidence_recheck", retryable: true, details: driftChecks });
      file = after;
    }
    const selection = versionSelectionProof(selected, input.selector, "content_and_metadata");
    downloaded.evidence.selection = selection;
    await attachEvidenceResource(runtime, downloaded.evidence);
    return { file, version: selected as unknown as JsonObject, selection, evidence: downloaded.evidence, ...(scopeProof ? { scope_proof: scopeProof } : {}), ...(driftChecks ? { drift_checks: driftChecks } : {}), provenance: observations };
  } catch (error) {
    if (downloaded.evidence.__registry_owned !== true && typeof downloaded.evidence.temp_path === "string") await fs.rm(downloaded.evidence.temp_path, { force: true }).catch(() => undefined);
    throw error;
  }
}

function registerEvidenceTools(server: McpServer, runtime: AppRuntime): void {
  server.registerResource(
    "yfy_evidence_artifact",
    new ResourceTemplate("yfy://evidence/{token}", { list: undefined }),
    { title: "Yifangyun Evidence Artifact", description: "Short-lived downloaded evidence bytes referenced by evidence tools.", mimeType: "application/octet-stream" },
    async (uri, variables) => {
      const artifact = await runtime.evidence.read(String(variables.token));
      return { contents: [{ uri: uri.href, blob: artifact.blob, ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}) }] };
    }
  );

  registerTool(server, "yfy_evidence_download", {
    title: "Download Yifangyun Evidence",
    description: "Download a validated current or historical version using an unambiguous relative version selector.",
    inputSchema: { file_id: IdSchema, version: VersionSelectorSchema.default({ kind: "current" }), access_context: z.string().trim().min(1).optional() },
    outputSchema: { file: z.record(z.unknown()), version: z.record(z.unknown()), selection: z.record(z.unknown()), evidence: z.record(z.unknown()), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: false, idempotent: false }, async ({ file_id, version, access_context }, extra) => {
    const resolved = runtime.access.resolveContext(typeof access_context === "string" ? access_context : undefined);
    const selector = (version ?? { kind: "current" }) as VersionSelector;
    return captureVersionEvidence(runtime, { accessContext: resolved.context.id, externalEnterpriseId: resolved.context.externalEnterpriseId, fileId: String(file_id), identityRef: resolved.identityRef, onProgress: progressReporter(extra), selector, signal: extra.signal });
  });

  registerTool(server, "yfy_evidence_lock_current", {
    title: "Lock Current Yifangyun Evidence",
    description: "Prove scope membership, download provider version 0 and reject metadata or version-history drift.",
    inputSchema: { file_id: IdSchema, scope_id: z.string().trim().min(1) },
    outputSchema: { file: z.record(z.unknown()), version: z.record(z.unknown()), selection: z.record(z.unknown()), evidence: z.record(z.unknown()), scope_proof: z.record(z.unknown()), drift_checks: z.record(z.unknown()), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: false, idempotent: false }, async ({ file_id, scope_id }, extra) => {
    const resolved = runtime.access.resolveScope(String(scope_id));
    return captureVersionEvidence(runtime, { accessContext: resolved.context.id, externalEnterpriseId: resolved.context.externalEnterpriseId, fileId: String(file_id), identityRef: resolved.identityRef, lockScopeId: String(scope_id), onProgress: progressReporter(extra), selector: { kind: "current" }, signal: extra.signal });
  });

  registerTool(server, "yfy_evidence_verify", {
    title: "Verify Yifangyun File Evidence",
    description: "Verify current metadata and optionally downloaded content against expected evidence fields.",
    inputSchema: {
      file_id: IdSchema,
      version: VersionSelectorSchema.default({ kind: "current" }),
      access_context: z.string().trim().min(1).optional(),
      expected_sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional(),
      expected_sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional(),
      expected_size_bytes: z.number().int().nonnegative().optional(),
      expected_modified_at_unix: z.number().int().nonnegative().optional(),
      expected_file_version_key: z.string().trim().min(1).optional()
    },
    outputSchema: { file: z.record(z.unknown()), version: z.record(z.unknown()), selection: z.record(z.unknown()), checks: z.record(z.unknown()), matches: z.boolean(), evidence: z.record(z.unknown()), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: false, idempotent: false }, async (args, extra) => {
    const selector = (args.version ?? { kind: "current" }) as VersionSelector;
    const expectedStrings = [args.expected_sha1, args.expected_sha256, args.expected_file_version_key];
    if (expectedStrings.some((value) => typeof value === "string" && value.trim().length === 0)) {
      throw new YifangyunError("Expected evidence string fields must not be empty.", { code: "YFY_INPUT_INVALID", phase: "evidence_verify" });
    }
    const hasExpectedValue = [args.expected_sha1, args.expected_sha256, args.expected_size_bytes, args.expected_modified_at_unix, args.expected_file_version_key]
      .some((value) => value !== undefined);
    if (!hasExpectedValue) {
      throw new YifangyunError("At least one expected evidence field is required.", { code: "YFY_INPUT_INVALID", phase: "evidence_verify", suggestedAction: "Use yfy_evidence_download to collect evidence without comparing expected values." });
    }
    if (selector.kind === "history" && args.expected_file_version_key !== undefined) {
      throw new YifangyunError("A current file version key cannot verify a historical generation.", {
        code: "YFY_INPUT_INVALID",
        phase: "evidence_verify",
        suggestedAction: "Verify historical content with SHA-1, SHA-256, size or modified time instead."
      });
    }
    const resolved = runtime.access.resolveContext(typeof args.access_context === "string" ? args.access_context : undefined);
    const captured = await captureVersionEvidence(runtime, { accessContext: resolved.context.id, externalEnterpriseId: resolved.context.externalEnterpriseId, fileId: String(args.file_id), identityRef: resolved.identityRef, onProgress: progressReporter(extra), selector, signal: extra.signal });
    const file = captured.file as JsonObject;
    const version = captured.version as unknown as FileVersion;
    const evidence = captured.evidence as JsonObject;
    const checks: JsonObject = {};
    if (typeof args.expected_sha1 === "string") checks.sha1 = evidence.sha1 === args.expected_sha1.toLowerCase();
    if (typeof args.expected_sha256 === "string") checks.sha256 = evidence.sha256 === args.expected_sha256.toLowerCase();
    if (args.expected_size_bytes !== undefined) checks.size_bytes = evidence.size_bytes === args.expected_size_bytes;
    if (args.expected_modified_at_unix !== undefined) checks.modified_at_unix = version.modified_at_unix === args.expected_modified_at_unix;
    if (args.expected_file_version_key !== undefined) checks.file_version_key = file.file_version_key === args.expected_file_version_key;
    return { file, version: captured.version, selection: captured.selection, checks, matches: Object.values(checks).every((value) => value === true), evidence, provenance: captured.provenance };
  });

  registerTool(server, "yfy_evidence_release", {
    title: "Release Yifangyun Evidence",
    description: "Delete one short-lived local evidence artifact and invalidate its resource URI.",
    inputSchema: { resource_uri: z.string().regex(/^yfy:\/\/evidence\/[a-f0-9]{48}$/) },
    outputSchema: { released: z.boolean(), resource_uri: z.string() }
  }, { readOnly: false, idempotent: true }, async ({ resource_uri }) => ({ released: await runtime.evidence.release(String(resource_uri)), resource_uri: String(resource_uri) }));
}
