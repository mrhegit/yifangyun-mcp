import { promises as fs } from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { arrayValue, idValue, objectValue, projectDepartment, projectItem, projectPath, provenance } from "../domain/projectors.js";
import { metrics } from "../observability.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { registerTool } from "./tooling.js";

const IdSchema = z.string().trim().regex(/^\d+$/);

function progressReporter(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: unknown) => Promise<void> }) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let lastBytes = 0;
  let lastAt = 0;
  return (bytes: number, totalBytes?: number) => {
    const now = Date.now();
    if (bytes - lastBytes < 1_048_576 && now - lastAt < 1000 && bytes !== totalBytes) return;
    lastBytes = bytes;
    lastAt = now;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: bytes, ...(totalBytes !== undefined ? { total: totalBytes } : {}), message: "Downloading and hashing Yifangyun evidence" } });
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

function attachEvidenceResource(runtime: AppRuntime, evidence: JsonObject): void {
  const sizeBytes = typeof evidence.size_bytes === "number" ? evidence.size_bytes : Number.MAX_SAFE_INTEGER;
  const maxResourceBytes = runtime.config.maxEvidenceResourceBytes ?? 16777216;
  if (sizeBytes > maxResourceBytes) {
    evidence.resource_omitted = { code: "YFY_EVIDENCE_RESOURCE_TOO_LARGE", max_resource_bytes: maxResourceBytes, size_bytes: sizeBytes };
  } else {
    evidence.resource_uri = runtime.evidence.register({
      path: String(evidence.temp_path),
      name: String(evidence.file_name),
      ...(typeof evidence.content_type === "string" ? { mimeType: evidence.content_type } : {})
    });
  }
  if (runtime.config.transport === "http") delete evidence.temp_path;
}

function assertEvidenceAnchors(file: JsonObject): void {
  const missing: string[] = [];
  if (typeof file.sha1 !== "string" || !/^[a-f\d]{40}$/i.test(file.sha1)) missing.push("sha1");
  if (typeof file.size_bytes !== "number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0) missing.push("size_bytes");
  if (typeof file.modified_at_unix !== "number" || !Number.isSafeInteger(file.modified_at_unix) || file.modified_at_unix < 0) missing.push("modified_at_unix");
  if (typeof file.file_version_key !== "string" || file.file_version_key.length === 0) missing.push("file_version_key");
  if (!Array.isArray(file.path_chain) || file.path_chain.length === 0) missing.push("path_chain");
  if (missing.length > 0) {
    throw new YifangyunError("Provider metadata is incomplete for drift-safe evidence.", {
      code: "YFY_EVIDENCE_METADATA_INCOMPLETE",
      details: { missing_fields: missing },
      phase: "evidence_metadata",
      suggestedAction: "Retry after the Provider exposes SHA-1, version, modified time, size and ancestry metadata."
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

async function getCurrentVersion(runtime: AppRuntime, fileId: string, accessContext: string, signal?: AbortSignal): Promise<{ id: string; response: Awaited<ReturnType<AppRuntime["gateway"]["getUser"]>> }> {
  const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(fileId)}/versions`, accessContext, {}, signal);
  const source = objectValue(response.data) ?? {};
  const versions = [...arrayValue(source.file_versions), ...arrayValue(source.versions)];
  const current = versions.map(objectValue).find((value) => value?.current === true);
  const id = idValue(current?.id);
  if (!id) {
    throw new YifangyunError("Current file version could not be resolved.", { code: "YFY_CURRENT_VERSION_NOT_FOUND", phase: "evidence_version", suggestedAction: "Inspect yfy_file_versions and retry after the Provider exposes a current version id." });
  }
  return { id, response };
}

async function download(runtime: AppRuntime, input: { accessContext: string; externalEnterpriseId?: string; file: JsonObject; fileId: string; identityRef: string; onProgress?: (bytes: number, totalBytes?: number) => void; signal?: AbortSignal; versionId?: string }) {
  const ticket = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/download_v2`, input.accessContext, {
    version: input.versionId,
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
      ...(input.versionId ? { version_id: input.versionId } : {}),
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

  registerTool(server, "yfy_evidence_capture", {
    title: "Capture Yifangyun File Evidence",
    description: "Download and hash a file. current_locked mode also proves scope and rejects metadata drift during download.",
    inputSchema: {
      file_id: IdSchema,
      mode: z.enum(["download", "current_locked"]).default("current_locked"),
      scope_id: z.string().trim().min(1).optional(),
      version_id: IdSchema.optional(),
      access_context: z.string().trim().min(1).optional()
    },
    outputSchema: { file: z.record(z.unknown()), evidence: z.record(z.unknown()), scope_proof: z.record(z.unknown()).optional(), drift_checks: z.record(z.unknown()).optional(), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: false, idempotent: false }, async ({ file_id, mode, scope_id, version_id, access_context }, extra) => {
    if (mode === "current_locked" && !scope_id) {
      throw new YifangyunError("scope_id is required for current_locked evidence capture.", { code: "YFY_INPUT_INVALID", phase: "evidence_capture" });
    }
    const resolved = scope_id ? runtime.access.resolveScope(String(scope_id)) : runtime.access.resolveContext(typeof access_context === "string" ? access_context : undefined);
    const infoResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/info_v2`, resolved.context.id, resolved.context.externalEnterpriseId
      ? { external_enterprise_id: resolved.context.externalEnterpriseId }
      : {}, extra.signal);
    const before = projectItem(infoResponse.data, "evidence");
    let scopeProof: JsonObject | undefined;
    if (scope_id) {
      const scope = runtime.access.resolveScope(String(scope_id));
      const membership = inScope(before, scope.scope.rootFolderId);
      if (!membership.matched) {
        throw new YifangyunError("File is outside the configured authority scope.", { code: "YFY_SCOPE_ASSERTION_FAILED", phase: "evidence_scope" });
      }
      scopeProof = { scope_id: scope.scope.id, root_folder_id: scope.scope.rootFolderId, ancestor_folder_ids: membership.ancestorIds, in_scope: true };
    }
    let selectedVersion = typeof version_id === "string" ? version_id : undefined;
    const observations: JsonObject[] = [provenance(infoResponse.meta, resolved.context.id)];
    if (mode === "current_locked") {
      const current = await getCurrentVersion(runtime, String(file_id), resolved.context.id, extra.signal);
      assertEvidenceAnchors(before);
      if (selectedVersion && selectedVersion !== current.id) {
        throw new YifangyunError("version_id does not match the current file version.", { code: "YFY_INPUT_INVALID", phase: "evidence_version" });
      }
      selectedVersion = current.id;
      observations.push(provenance(current.response.meta, resolved.context.id));
    }
    const downloaded = await download(runtime, {
      accessContext: resolved.context.id,
      externalEnterpriseId: resolved.context.externalEnterpriseId,
      file: before,
      fileId: String(file_id),
      identityRef: resolved.identityRef,
      onProgress: progressReporter(extra),
      signal: extra.signal,
      versionId: selectedVersion
    });
    observations.push(...downloaded.observations);
    if (mode === "current_locked") {
      try {
        const finalResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/info_v2`, resolved.context.id, resolved.context.externalEnterpriseId
          ? { external_enterprise_id: resolved.context.externalEnterpriseId }
          : {}, extra.signal);
        const after = projectItem(finalResponse.data, "evidence");
        assertEvidenceAnchors(after);
        observations.push(provenance(finalResponse.meta, resolved.context.id));
        const finalVersion = await getCurrentVersion(runtime, String(file_id), resolved.context.id, extra.signal);
        observations.push(provenance(finalVersion.response.meta, resolved.context.id));
        const checks: JsonObject = {
          current_version_id: selectedVersion === finalVersion.id,
          file_version_key: before.file_version_key === after.file_version_key,
          modified_at_unix: before.modified_at_unix === after.modified_at_unix,
          path_chain: JSON.stringify(before.path_chain) === JSON.stringify(after.path_chain),
          sha1: before.sha1 === after.sha1 && after.sha1 === downloaded.evidence.sha1,
          size_bytes: before.size_bytes === after.size_bytes && after.size_bytes === downloaded.evidence.size_bytes
        };
        if (scope_id) {
          checks.scope_unchanged = inScope(after, runtime.access.resolveScope(String(scope_id)).scope.rootFolderId).matched;
        }
        if (!Object.values(checks).every((value) => value === true)) {
          throw new YifangyunError("File changed while evidence was being captured.", {
            code: "YFY_EVIDENCE_DRIFT",
            details: { checks, file_id: String(file_id), scope_id: String(scope_id) },
            phase: "evidence_recheck",
            retryable: true
          });
        }
        attachEvidenceResource(runtime, downloaded.evidence);
        return { file: after, evidence: downloaded.evidence, scope_proof: scopeProof ?? {}, drift_checks: checks, provenance: observations };
      } catch (error) {
        if (typeof downloaded.evidence.temp_path === "string") {
          await fs.rm(downloaded.evidence.temp_path, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    }
    attachEvidenceResource(runtime, downloaded.evidence);
    return { file: before, evidence: downloaded.evidence, provenance: observations };
  });

  registerTool(server, "yfy_evidence_verify", {
    title: "Verify Yifangyun File Evidence",
    description: "Verify current metadata and optionally downloaded content against expected evidence fields.",
    inputSchema: {
      file_id: IdSchema,
      access_context: z.string().trim().min(1).optional(),
      expected_sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional(),
      expected_sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional(),
      expected_size_bytes: z.number().int().nonnegative().optional(),
      expected_modified_at_unix: z.number().int().nonnegative().optional(),
      expected_file_version_key: z.string().trim().min(1).optional(),
      verify_content: z.boolean().default(false)
    },
    outputSchema: { file: z.record(z.unknown()), checks: z.record(z.unknown()), matches: z.boolean(), evidence: z.record(z.unknown()).optional(), provenance: z.array(z.record(z.unknown())) }
  }, { readOnly: false, idempotent: false }, async (args, extra) => {
    const expectedStrings = [args.expected_sha1, args.expected_sha256, args.expected_file_version_key];
    if (expectedStrings.some((value) => typeof value === "string" && value.trim().length === 0)) {
      throw new YifangyunError("Expected evidence string fields must not be empty.", { code: "YFY_INPUT_INVALID", phase: "evidence_verify" });
    }
    const hasExpectedValue = [args.expected_sha1, args.expected_sha256, args.expected_size_bytes, args.expected_modified_at_unix, args.expected_file_version_key]
      .some((value) => value !== undefined);
    if (!hasExpectedValue) {
      throw new YifangyunError("At least one expected evidence field is required.", { code: "YFY_INPUT_INVALID", phase: "evidence_verify", suggestedAction: "Use yfy_evidence_capture to collect evidence without comparing expected values." });
    }
    const resolved = runtime.access.resolveContext(typeof args.access_context === "string" ? args.access_context : undefined);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(args.file_id))}/info_v2`, resolved.context.id, resolved.context.externalEnterpriseId
      ? { external_enterprise_id: resolved.context.externalEnterpriseId }
      : {}, extra.signal);
    const file = projectItem(response.data, "evidence");
    const observations: JsonObject[] = [provenance(response.meta, resolved.context.id)];
    const checks: JsonObject = {};
    if (args.expected_sha1 !== undefined) checks.sha1 = file.sha1 === args.expected_sha1;
    if (args.expected_size_bytes !== undefined) checks.size_bytes = file.size_bytes === args.expected_size_bytes;
    if (args.expected_modified_at_unix !== undefined) checks.modified_at_unix = file.modified_at_unix === args.expected_modified_at_unix;
    if (args.expected_file_version_key !== undefined) checks.file_version_key = file.file_version_key === args.expected_file_version_key;
    let evidence: JsonObject | undefined;
    if (args.verify_content === true || args.expected_sha256 !== undefined) {
      assertEvidenceAnchors(file);
      const current = await getCurrentVersion(runtime, String(args.file_id), resolved.context.id, extra.signal);
      observations.push(provenance(current.response.meta, resolved.context.id));
      const captured = await download(runtime, { accessContext: resolved.context.id, externalEnterpriseId: resolved.context.externalEnterpriseId, file, fileId: String(args.file_id), identityRef: resolved.identityRef, onProgress: progressReporter(extra), signal: extra.signal, versionId: current.id });
      observations.push(...captured.observations);
      evidence = captured.evidence;
      try {
        const finalResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(args.file_id))}/info_v2`, resolved.context.id, resolved.context.externalEnterpriseId
          ? { external_enterprise_id: resolved.context.externalEnterpriseId }
          : {}, extra.signal);
        const after = projectItem(finalResponse.data, "evidence");
        assertEvidenceAnchors(after);
        const finalVersion = await getCurrentVersion(runtime, String(args.file_id), resolved.context.id, extra.signal);
        observations.push(provenance(finalResponse.meta, resolved.context.id), provenance(finalVersion.response.meta, resolved.context.id));
        const stable = current.id === finalVersion.id
          && file.file_version_key === after.file_version_key
          && file.modified_at_unix === after.modified_at_unix
          && file.sha1 === after.sha1
          && after.sha1 === evidence.sha1
          && file.size_bytes === after.size_bytes
          && after.size_bytes === evidence.size_bytes
          && JSON.stringify(file.path_chain) === JSON.stringify(after.path_chain);
        if (!stable) {
          throw new YifangyunError("File changed while evidence was being verified.", { code: "YFY_EVIDENCE_DRIFT", phase: "evidence_verify", retryable: true });
        }
        attachEvidenceResource(runtime, evidence);
      } catch (error) {
        if (typeof evidence.temp_path === "string") await fs.rm(evidence.temp_path, { force: true }).catch(() => undefined);
        throw error;
      }
      if (args.expected_sha256 !== undefined) checks.sha256 = evidence.sha256 === args.expected_sha256;
      if (args.expected_sha1 !== undefined) checks.download_sha1 = evidence.sha1 === args.expected_sha1;
      if (args.expected_size_bytes !== undefined) checks.download_size = evidence.size_bytes === args.expected_size_bytes;
    }
    return { file, checks, matches: Object.values(checks).every((value) => value === true), ...(evidence ? { evidence } : {}), provenance: observations };
  });
}
