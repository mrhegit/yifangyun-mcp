import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openPromise as openZip } from "yauzl";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, type DownloadStrategy, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { objectValue, projectItem } from "../domain/projectors.js";
import { formatVersionRef, parseItemRef, parseVersionRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { FileRefSchema, FileVersionSchema, ItemRefSchema, ItemSchema, VersionRefSchema, WorkspaceRefSchema } from "./schemas.js";
import { registerTool } from "./tooling.js";
import { resolveMediaType, workspaceMembershipProof } from "./workspaceTools.js";

const PREVIEWABLE = new Set([
  "text/plain", "text/markdown", "text/csv", "text/html", "text/css", "text/javascript", "text/tab-separated-values",
  "application/json", "application/xml", "application/yaml", "image/svg+xml"
]);

function progressReporter(extra: { _meta?: { progressToken?: string | number }; sendNotification: (notification: unknown) => Promise<void>; signal: AbortSignal }) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let lastBytes = 0;
  let lastAt = 0;
  return (bytes: number, totalBytes?: number) => {
    if (extra.signal.aborted) return;
    if (bytes < lastBytes) return;
    const now = Date.now();
    if (bytes - lastBytes < 1_048_576 && now - lastAt < 1000 && bytes !== totalBytes) return;
    lastBytes = bytes;
    lastAt = now;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: bytes, ...(totalBytes !== undefined ? { total: totalBytes } : {}), message: "Downloading Yifangyun file" }
    }).catch(() => undefined);
  };
}

async function removeTemp(runtime: AppRuntime, tempPath: string, sizeBytes: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(tempPath, { force: true });
      await runtime.tempStorage.releaseUsed(sizeBytes);
      return;
    } catch (error) {
      const retryable = Boolean(error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EBUSY"));
      if (!retryable || attempt === 2) {
        throw new YifangyunError("Temporary download candidate could not be removed.", {
          code: "YFY_DOWNLOAD_CLEANUP_FAILED",
          phase: "download_cleanup",
          retryable
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function isPreviewableMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/") || PREVIEWABLE.has(mediaType) || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

async function tryTextPreview(runtime: AppRuntime, downloadId: string, sizeBytes: number, mediaType: string, maxBytes: number): Promise<JsonObject | null> {
  if (sizeBytes > maxBytes || !isPreviewableMediaType(mediaType)) return null;
  try {
    const bytes = await runtime.downloads.readVerifiedBytes(downloadId, maxBytes);
    if (!bytes) return null;
    if (bytes.includes(0)) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { kind: "utf8_text", complete: true, charset: "utf-8", bytes: Buffer.byteLength(text, "utf8"), text };
  } catch (error) {
    if (error instanceof YifangyunError) throw error;
    return null;
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
      suggestedAction: "Discover the file from the same workspace before downloading."
    });
  }
  const [response, rootResponse] = await Promise.all([
    runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/info_v2`, scope.context.id, scope.context.externalEnterpriseId
      ? { external_enterprise_id: scope.context.externalEnterpriseId }
      : {}, signal),
    runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(scope.scope.rootFolderId)}/info`, scope.context.id, {}, signal)
  ]);
  const file = projectItem(response.data, "verification");
  const rootFolder = projectItem(rootResponse.data, "verification");
  const membership = workspaceMembershipProof(file, rootFolder, scope.scope.rootFolderId);
  return { file, fileId: item.id, membership, response, rootResponse, scope };
}

async function downloadAttempt(runtime: AppRuntime, input: {
  accessContext: string;
  downloadSelector: number | string;
  externalEnterpriseId?: string;
  file: JsonObject;
  fileId: string;
  fileRef: string;
  identityRef: string;
  onProgress?: (bytes: number, totalBytes?: number) => void;
  signal?: AbortSignal;
  strategy: DownloadStrategy;
  timeoutMs: number;
}) {
  const ticket = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(input.fileId)}/download_v2`, input.accessContext, {
    version: input.downloadSelector,
    external_enterprise_id: input.externalEnterpriseId
  }, input.signal);
  const ticketData = objectValue(ticket.data);
  if (!ticketData || typeof ticketData.download_url !== "string") {
    throw new YifangyunError("Download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "download" });
  }
  const downloaded = await runtime.client.downloadFromUrlToTemp(ticketData.download_url, {
    fileNameHint: typeof input.file.name === "string" ? input.file.name : `${input.fileId}.bin`,
    namespace: input.identityRef,
    onProgress: input.onProgress,
    retry: true,
    signal: input.signal,
    timeoutMs: input.timeoutMs
  });
  return {
    artifact: {
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
  }) {
  const strategy: DownloadStrategy = input.selector.kind === "current" ? "current" : "historical_version_id";
  const downloadSelector = input.selector.kind === "current" ? 0 : input.selected.provider_version_id!;
  const wallTimeoutMs = runtime.config.downloadWallTimeoutMs ?? 300_000;
  const deadlineAt = Date.now() + wallTimeoutMs;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Download wall timeout exceeded.")), wallTimeoutMs);
  const operationSignal = input.signal ? AbortSignal.any([input.signal, deadlineController.signal]) : deadlineController.signal;
  let downloaded: Awaited<ReturnType<typeof downloadAttempt>> | undefined;
  try {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw downloadWallTimeoutError(wallTimeoutMs);
        try {
          downloaded = await downloadAttempt(runtime, {
            accessContext: input.accessContext,
            downloadSelector,
            externalEnterpriseId: input.externalEnterpriseId,
            file: input.file,
            fileId: input.fileId,
            fileRef: input.fileRef,
            identityRef: input.identityRef,
            onProgress: input.onProgress,
            signal: operationSignal,
            strategy,
            timeoutMs: remainingMs
          });
          break;
        } catch (error) {
          if (input.signal?.aborted) throw error;
          if (deadlineController.signal.aborted || Date.now() >= deadlineAt) throw downloadWallTimeoutError(wallTimeoutMs);
          if (input.selector.kind === "historical" && isProviderVersionMissing(error)) {
            const providerError = error as YifangyunError;
            throw new YifangyunError("The Provider rejected the historical version ID returned by its version listing.", {
              code: "YFY_HISTORICAL_DOWNLOAD_UNAVAILABLE",
              details: providerError.details,
              phase: "historical_download_ticket",
              agentDetails: { provider_version_id: input.selected.provider_version_id ?? null },
              suggestedAction: "Treat historical download support as unavailable for this Provider deployment; current-version download remains supported."
            });
          }
          const retryStream = error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_STREAM_FAILED" && error.retryable;
          if (!retryStream || attempt === 1) throw error;
        }
      }
      if (!downloaded) {
        throw new YifangyunError("Download did not produce a staged file.", { code: "YFY_DOWNLOAD_STREAM_FAILED", phase: "download_stream", retryable: true });
      }
      if (downloaded.artifact.sha1 === input.selected.sha1 && downloaded.artifact.size_bytes === input.selected.size_bytes) return downloaded;
    } finally {
      if (downloaded && (downloaded.artifact.sha1 !== input.selected.sha1 || downloaded.artifact.size_bytes !== input.selected.size_bytes)) {
        await removeTemp(runtime, String(downloaded.artifact.temp_path), Number(downloaded.artifact.size_bytes));
      }
    }
    const actual: JsonObject = downloaded
      ? { strategy, actual_sha1: String(downloaded.artifact.sha1), actual_size_bytes: Number(downloaded.artifact.size_bytes) }
      : { strategy };
    if (input.selector.kind === "historical") {
      throw new YifangyunError("The Provider could not return content matching the selected historical version metadata.", {
        code: "YFY_HISTORICAL_DOWNLOAD_UNAVAILABLE",
        phase: "download_validation",
        agentDetails: {
          expected_sha1: input.selected.sha1 ?? null,
          expected_size_bytes: input.selected.size_bytes ?? null,
          provider_version_id: input.selected.provider_version_id ?? null,
          attempt: actual
        },
        suggestedAction: "Refresh yfy_versions and retry, or report that the historical original is unavailable."
      });
    }
    throw new YifangyunError("The Provider returned current content that does not match the version metadata.", {
      code: "YFY_DOWNLOAD_CONTENT_MISMATCH",
      phase: "download_validation",
      agentDetails: { expected_sha1: input.selected.sha1 ?? null, expected_size_bytes: input.selected.size_bytes ?? null, attempt: actual },
      suggestedAction: "Refresh file metadata and yfy_versions before retrying."
    });
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function isProviderVersionMissing(error: unknown): boolean {
  return error instanceof YifangyunError
    && typeof error.details?.api_code === "string"
    && error.details.api_code.toLowerCase().includes("file_version_not_found");
}

function downloadWallTimeoutError(wallTimeoutMs: number): YifangyunError {
  return new YifangyunError("Download exceeded the configured wall timeout.", {
    code: "YFY_PROVIDER_TIMEOUT",
    details: { wall_timeout_ms: wallTimeoutMs },
    phase: "download",
    retryable: true,
    suggestedAction: "Retry the download or increase YFY_DOWNLOAD_WALL_TIMEOUT_MS for trusted large files."
  });
}

function shouldExposeLocalPath(runtime: AppRuntime): boolean {
  if (runtime.config.downloadExposeLocalPath !== undefined) return runtime.config.downloadExposeLocalPath;
  return (runtime.config.transport ?? "stdio") === "stdio";
}

function shouldExposeFetchUrl(runtime: AppRuntime): boolean {
  if (runtime.config.downloadStagedHttpEnabled !== undefined) return runtime.config.downloadStagedHttpEnabled;
  return (runtime.config.transport ?? "stdio") === "http";
}

function stagedPublicBaseUrl(runtime: AppRuntime): string {
  if (runtime.config.downloadStagedPublicBaseUrl) return runtime.config.downloadStagedPublicBaseUrl;
  const host = runtime.config.httpHost ?? "127.0.0.1";
  const port = runtime.config.httpPort ?? 3000;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${urlHost}:${port}`).toString().replace(/\/$/, "");
}

function buildFetchUrl(runtime: AppRuntime, downloadId: string, fileName: string): string {
  const encodedName = encodeURIComponent(fileName);
  return new URL(`staged/v1/${downloadId}/${encodedName}`, `${stagedPublicBaseUrl(runtime)}/`).toString();
}

function agentHint(hasPath: boolean, hasUrl: boolean): string {
  if (hasPath && hasUrl) {
    return "Prefer download.local_path on the same machine; otherwise GET download.fetch_url. Optional yfy_download_release frees disk sooner; TTL also cleans up.";
  }
  if (hasPath) {
    return "Open download.local_path with a host parser skill (xlsx/pdf/docx/text). Optional yfy_download_release frees disk sooner; TTL also cleans up.";
  }
  return "GET download.fetch_url to retrieve bytes (same auth as MCP HTTP if configured). Parse with host tools. Optional yfy_download_release frees disk sooner; TTL also cleans up.";
}

function batchAgentHint(hasPath: boolean, hasUrl: boolean): string {
  const safeguard = "Review verification.uncompressed_size_bytes and available Host disk before extraction.";
  if (hasPath && hasUrl) return `Prefer download.local_path when co-located; otherwise GET download.fetch_url. ${safeguard} Extract the ZIP before parsing its files, then call yfy_download_release.`;
  if (hasPath) return `${safeguard} Extract the ZIP at download.local_path before parsing its files, then call yfy_download_release.`;
  return `GET download.fetch_url. ${safeguard} Extract the ZIP before parsing its files, then call yfy_download_release.`;
}

async function validateZipArchive(filePath: string, signal?: AbortSignal): Promise<{ entryCount: number; uncompressedSizeBytes: number }> {
  let archive: Awaited<ReturnType<typeof openZip>> | undefined;
  try {
    archive = await openZip(filePath, { autoClose: true, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    let entryCount = 0;
    let uncompressedSizeBytes = 0;
    for await (const entry of archive.eachEntry()) {
      if (signal?.aborted) throw new YifangyunError("ZIP validation was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "batch_download_validation" });
      entryCount += 1;
      if (entryCount > 100_000) throw new Error("ZIP entry limit exceeded.");
      if (entry.isEncrypted()) throw new Error("Encrypted ZIP entries are not supported.");
      const segments = entry.fileName.split("/").filter(Boolean);
      if (entry.fileName.includes("\0") || entry.fileName.startsWith("/") || /^[a-zA-Z]:/.test(entry.fileName) || segments.includes("..")) {
        throw new Error("ZIP entry path is unsafe.");
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new Error("ZIP entry size is unsafe.");
      uncompressedSizeBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(uncompressedSizeBytes)) throw new Error("ZIP expanded size is unsafe.");
      await archive.readLocalFileHeaderPromise(entry, { minimal: true });
    }
    if (entryCount !== archive.entryCount) throw new Error("ZIP central directory entry count is inconsistent.");
    return { entryCount, uncompressedSizeBytes };
  } catch (error) {
    if (error instanceof YifangyunError) throw error;
    throw new YifangyunError("Provider batch download did not produce a structurally valid ZIP archive.", {
      code: "YFY_PACK_DOWNLOAD_INVALID",
      phase: "batch_download_validation",
      suggestedAction: "Retry once; if the Provider repeats this response, report pack_download as unavailable."
    });
  } finally {
    if (archive?.isOpen) archive.close();
  }
}

function batchDeadline(parentSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Batch download wall timeout exceeded."));
  }, timeoutMs);
  return {
    dispose: () => clearTimeout(timer),
    remainingMs: () => Math.max(1, timeoutMs - Math.max(0, Date.now() - startedAt)),
    signal: AbortSignal.any([parentSignal, controller.signal]),
    timedOut: () => timedOut
  };
}

function selectorFor(fileRef: string, versionRef: unknown): VersionSelector {
  if (versionRef === undefined) return { kind: "current" };
  const version = parseVersionRef(String(versionRef), fileRef);
  return { kind: "historical", version_id: version.providerVersionId };
}

const DownloadIdSchema = z.string().regex(/^dl_[a-f0-9]{32}$/).describe("Opaque temporary download id returned by yfy_download. Copy it exactly.");
const HttpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "fetch_url must use HTTP or HTTPS");

const ExpectedDownloadSchema = z.object({
  sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional().describe("Optional expected SHA-1 assertion."),
  sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional().describe("Optional expected SHA-256 assertion."),
  size_bytes: z.number().int().nonnegative().optional().describe("Optional expected byte-size assertion.")
}).strict();

const StagedDownloadSchema = z.object({
  download_id: DownloadIdSchema,
  local_path: z.string().min(1).nullable().describe("Absolute server path for co-located stdio Hosts; null for remote HTTP by default."),
  fetch_url: HttpUrlSchema.nullable().describe("Authenticated staged HTTP URL for remote Hosts; null in stdio mode."),
  media_type: z.string(),
  media_type_source: z.enum(["content_type", "magic_sniff", "file_extension", "octet_stream", "archive_validation"]),
  sha256: z.string().regex(/^[a-f\d]{64}$/i),
  sha1: z.string().regex(/^[a-f\d]{40}$/i),
  size_bytes: z.number().int().nonnegative(),
  expires_at: z.string().datetime()
}).strict();

const DownloadCleanupSchema = z.object({
  mode: z.literal("ttl"),
  ttl_seconds: z.number().int().positive(),
  release_tool: z.literal("yfy_download_release"),
  release_args: z.object({ download_id: DownloadIdSchema }).strict()
}).strict();

const DownloadResultSchema = z.object({
  status: z.literal("ready"),
  file: ItemSchema.extend({ ref: FileRefSchema }),
  version: FileVersionSchema.extend({ ref: VersionRefSchema.optional() }),
  download: StagedDownloadSchema,
  preview: z.union([
    z.null(),
    z.object({
      kind: z.literal("utf8_text"),
      complete: z.literal(true),
      charset: z.literal("utf-8"),
      bytes: z.number().int().nonnegative(),
      text: z.string()
    }).strict()
  ]),
  workspace: z.object({
    ref: WorkspaceRefSchema,
    membership: z.literal("inside")
  }).strict().nullable(),
  cleanup: DownloadCleanupSchema,
  agent_hint: z.string()
}).strict();

const BatchDownloadResultSchema = z.object({
  status: z.literal("ready"),
  format: z.literal("zip"),
  items: z.array(z.object({ ref: ItemRefSchema, id: z.string(), type: z.enum(["file", "folder"]) }).strict()).min(1).max(20),
  verification: z.object({
    scope: z.literal("zip_structure_and_archive_hashes"),
    entry_count: z.number().int().nonnegative().max(100_000),
    uncompressed_size_bytes: z.number().int().nonnegative()
  }).strict(),
  download: StagedDownloadSchema,
  workspace: z.object({ ref: WorkspaceRefSchema, membership: z.literal("inside") }).strict().nullable(),
  cleanup: DownloadCleanupSchema,
  agent_hint: z.string()
}).strict();

function expectedMismatches(expected: unknown, actual: { sha1: string; sha256: string; sizeBytes: number }): string[] {
  const value = expected && typeof expected === "object" ? expected as Record<string, unknown> : {};
  const mismatches: string[] = [];
  if (typeof value.sha1 === "string" && actual.sha1.toLowerCase() !== value.sha1.toLowerCase()) mismatches.push("sha1");
  if (typeof value.sha256 === "string" && actual.sha256.toLowerCase() !== value.sha256.toLowerCase()) mismatches.push("sha256");
  if (typeof value.size_bytes === "number" && actual.sizeBytes !== value.size_bytes) mismatches.push("size_bytes");
  return mismatches;
}

function currentVersionFromFile(file: JsonObject): FileVersion {
  const sha1 = typeof file.sha1 === "string" && /^[a-f\d]{40}$/i.test(file.sha1) ? file.sha1.toLowerCase() : undefined;
  const size = typeof file.size_bytes === "number" && Number.isSafeInteger(file.size_bytes) && file.size_bytes >= 0 ? file.size_bytes : undefined;
  const modifiedAt = typeof file.modified_at_unix === "number" && Number.isSafeInteger(file.modified_at_unix) && file.modified_at_unix >= 0 ? file.modified_at_unix : undefined;
  const metadataComplete = sha1 !== undefined && size !== undefined;
  return {
    current: true,
    download_support: metadataComplete ? "supported" : "unsupported",
    generation: 0,
    metadata_complete: metadataComplete,
    ...(typeof file.name === "string" ? { name: file.name } : {}),
    ...(sha1 ? { sha1 } : {}),
    ...(size !== undefined ? { size_bytes: size } : {}),
    ...(modifiedAt !== undefined ? { modified_at_unix: modifiedAt, modified_at_iso: new Date(modifiedAt * 1000).toISOString() } : {})
  };
}

function currentFileFingerprint(file: JsonObject): string {
  return JSON.stringify({
    file_version_key: file.file_version_key ?? null,
    modified_at_unix: file.modified_at_unix ?? null,
    sha1: file.sha1 ?? null,
    size_bytes: file.size_bytes ?? null
  });
}

async function assertBatchWorkspaceMembership(runtime: AppRuntime, refs: string[], workspaceRef: string, signal?: AbortSignal): Promise<void> {
  const scope = runtime.access.resolveWorkspaceRef(workspaceRef);
  const parsed = refs.map((ref) => ({ ref, item: parseItemRef(ref) }));
  for (const entry of parsed) {
    if (entry.item.accessContextId !== scope.context.id || entry.item.identityRef !== scope.identityRef) {
      throw new YifangyunError("Batch item and workspace refs belong to different access identities.", {
        code: "YFY_REF_CONTEXT_CONFLICT",
        phase: "batch_workspace_membership",
        suggestedAction: "Use only item refs discovered from the selected workspace."
      });
    }
  }
  const rootResponse = await runtime.gateway.getUser(`/v2/folder/${encodeURIComponent(scope.scope.rootFolderId)}/info`, scope.context.id, {}, signal);
  const rootFolder = projectItem(rootResponse.data, "verification");
  const siblingController = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, siblingController.signal]) : siblingController.signal;
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < parsed.length) {
      const { ref, item } = parsed[nextIndex++]!;
      if (item.type === "folder" && item.id === scope.scope.rootFolderId) continue;
      const endpoint = item.type === "file"
        ? `/v2/file/${encodeURIComponent(item.id)}/info_v2`
        : `/v2/folder/${encodeURIComponent(item.id)}/info`;
      const params = item.type === "file" && scope.context.externalEnterpriseId
        ? { external_enterprise_id: scope.context.externalEnterpriseId }
        : {};
      const response = await runtime.gateway.getUser(endpoint, scope.context.id, params, operationSignal);
      const membership = workspaceMembershipProof(projectItem(response.data, "verification"), rootFolder, scope.scope.rootFolderId);
      if (membership.status !== "inside") {
        throw new YifangyunError(membership.status === "outside" ? "A batch item is outside the configured workspace." : "Batch item workspace membership could not be proven.", {
          code: membership.status === "outside" ? "YFY_WORKSPACE_MEMBERSHIP_FAILED" : "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE",
          phase: "batch_workspace_membership",
          agentDetails: { item_ref: ref, membership: membership.status },
          suggestedAction: membership.agent_interpretation.next_steps[0]
        });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, parsed.length) }, () => worker()));
  } catch (error) {
    siblingController.abort(error);
    throw error;
  }
}

export function registerDownloadTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("drive")) return;

  registerTool(server, "yfy_download", {
    title: "Download Yifangyun File for Host Parsing",
    description: "Download current or historical file bytes for Host-side parsing. stdio returns a co-located local_path; HTTP returns an authenticated staged fetch_url. The server verifies version metadata, SHA-1, SHA-256 and size, but does not parse PDF/Office/OCR. Pass workspace to require membership before and after download. Omit version for current content. Text preview is opt-in and bounded. yfy_download_release is optional because TTL cleanup is automatic.",
    inputSchema: {
      file: FileRefSchema,
      version: VersionRefSchema.optional(),
      workspace: WorkspaceRefSchema.optional(),
      include_text_preview: z.boolean().default(false).describe("Opt in to a complete UTF-8 preview only when the file is text-like and within YFY_TEXT_PREVIEW_MAX_BYTES."),
      expected: ExpectedDownloadSchema.optional()
    },
    outputSchema: DownloadResultSchema
  }, {
    readOnly: false,
    idempotent: false,
    onInvalidOutput: async (result) => {
      const download = result.download && typeof result.download === "object" && !Array.isArray(result.download) ? result.download as Record<string, unknown> : undefined;
      if (typeof download?.download_id === "string") await runtime.downloads.release(download.download_id);
    }
  }, async ({ file, version, workspace, include_text_preview, expected }, extra) => {
    const exposePath = shouldExposeLocalPath(runtime);
    const exposeUrl = shouldExposeFetchUrl(runtime);
    if (!exposePath && !exposeUrl) {
      throw new YifangyunError("No download delivery channel is enabled (local_path and fetch_url both disabled).", {
        code: "YFY_DOWNLOAD_DELIVERY_CHANNEL_UNAVAILABLE",
        phase: "download_delivery",
        suggestedAction: "Enable YFY_DOWNLOAD_EXPOSE_LOCAL_PATH for co-located agents, or YFY_DOWNLOAD_STAGED_HTTP for HTTP staged URLs."
      });
    }

    const fileRef = String(file);
    const item = parseItemRef(fileRef);
    if (item.type !== "file") throw new YifangyunError("A file ref is required.", { code: "YFY_INPUT_INVALID", phase: "download" });

    const workspaceRef = workspace === undefined ? undefined : String(workspace);
    const scopedBefore = workspaceRef ? await getScopedFile(runtime, fileRef, workspaceRef, extra.signal) : undefined;
    const access = scopedBefore?.scope ?? runtime.gateway.context(item.accessContextId);
    if (access.identityRef !== item.identityRef) {
      throw new YifangyunError("File reference belongs to a different configured identity.", { code: "YFY_REF_IDENTITY_MISMATCH", phase: "download" });
    }
    if (scopedBefore && scopedBefore.membership.status !== "inside") {
      throw new YifangyunError(scopedBefore.membership.status === "outside" ? "The file is outside the configured workspace." : "Workspace membership could not be proven from Provider metadata.", {
        code: scopedBefore.membership.status === "outside" ? "YFY_WORKSPACE_MEMBERSHIP_FAILED" : "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE",
        phase: "workspace_membership",
        suggestedAction: scopedBefore.membership.agent_interpretation.next_steps[0]
      });
    }

    const beforeResponse = scopedBefore?.response ?? await runtime.gateway.getUser(
      `/v2/file/${encodeURIComponent(item.id)}/info_v2`,
      access.context.id,
      access.context.externalEnterpriseId ? { external_enterprise_id: access.context.externalEnterpriseId } : {},
      extra.signal
    );
    const before = scopedBefore?.file ?? projectItem(beforeResponse.data, "verification");
    const selector = selectorFor(fileRef, version);
    let selected: FileVersion;
    let versionsBeforeFingerprint: string;
    if (access.context.externalEnterpriseId) {
      if (selector.kind === "historical") {
        throw new YifangyunError("Provider OpenAPI does not declare historical versions for external enterprise contexts.", {
          code: "YFY_FILE_VERSIONS_EXTERNAL_IDENTITY_UNSUPPORTED",
          phase: "version_selection",
          suggestedAction: "Omit version to download the current external-enterprise file content."
        });
      }
      selected = selectFileVersion([currentVersionFromFile(before)], selector);
      versionsBeforeFingerprint = currentFileFingerprint(before);
    } else {
      const versionsResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, access.context.id, {}, extra.signal);
      const versionsBefore = normalizeFileVersions(versionsResponse.data);
      selected = selectFileVersion(versionsBefore.versions, selector);
      versionsBeforeFingerprint = versionsBefore.fingerprint;
    }

    const downloaded = await downloadSelectedVersion(runtime, {
      accessContext: access.context.id,
      externalEnterpriseId: access.context.externalEnterpriseId,
      file: before,
      fileId: item.id,
      fileRef,
      identityRef: access.identityRef,
      onProgress: progressReporter(extra),
      selected,
      selector,
      signal: extra.signal
    });

    let registeredDownloadId: string | undefined;
    let registrationAttempted = false;
    try {
      const versionsAfterFingerprint = access.context.externalEnterpriseId
        ? currentFileFingerprint(projectItem((await runtime.gateway.getUser(
          `/v2/file/${encodeURIComponent(item.id)}/info_v2`,
          access.context.id,
          { external_enterprise_id: access.context.externalEnterpriseId },
          extra.signal
        )).data, "verification"))
        : normalizeFileVersions((await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, access.context.id, {}, extra.signal)).data).fingerprint;
      if (versionsBeforeFingerprint !== versionsAfterFingerprint) {
        throw new YifangyunError("File version identity changed while content was being downloaded.", {
          code: "YFY_DOWNLOAD_DRIFT",
          phase: "version_recheck",
          retryable: true,
          suggestedAction: "Restart from yfy_versions / yfy_download."
        });
      }
      if (workspaceRef) {
        const scopedAfter = await getScopedFile(runtime, fileRef, workspaceRef, extra.signal);
        if (scopedAfter.membership.status !== "inside") {
          throw new YifangyunError("Workspace membership changed while content was being downloaded.", {
            code: "YFY_DOWNLOAD_DRIFT",
            phase: "workspace_recheck",
            retryable: true
          });
        }
      }

      const mismatches = expectedMismatches(expected, {
        sha1: String(downloaded.artifact.sha1),
        sha256: String(downloaded.artifact.sha256),
        sizeBytes: Number(downloaded.artifact.size_bytes)
      });
      if (mismatches.length > 0) {
        throw new YifangyunError("Downloaded content does not match the requested expectations.", {
          code: "YFY_EXPECTATION_MISMATCH",
          phase: "expectation_validation",
          agentDetails: { mismatches, actual: { sha1: downloaded.artifact.sha1, sha256: downloaded.artifact.sha256, size_bytes: downloaded.artifact.size_bytes } },
          suggestedAction: "Review metadata and retry. No file was retained."
        });
      }

      const media = resolveMediaType(downloaded.artifact.content_type, downloaded.artifact.detected_content_type, downloaded.artifact.file_name);
      registrationAttempted = true;
      const record = await runtime.downloads.register({
        fileName: String(downloaded.artifact.file_name),
        identityRef: access.identityRef,
        mediaType: media.media_type,
        sha1: String(downloaded.artifact.sha1),
        sha256: String(downloaded.artifact.sha256),
        sizeBytes: Number(downloaded.artifact.size_bytes),
        sourcePath: String(downloaded.artifact.temp_path)
      });
      registeredDownloadId = record.downloadId;

      const previewMax = runtime.config.textPreviewMaxBytes ?? 32 * 1024;
      const preview = include_text_preview === true
        ? await tryTextPreview(runtime, record.downloadId, record.sizeBytes, record.mediaType, previewMax)
        : null;
      const localPath = exposePath ? record.localPath : null;
      const fetchUrl = exposeUrl ? buildFetchUrl(runtime, record.downloadId, record.fileName) : null;

      return {
        status: "ready" as const,
        file: { ...before, ref: fileRef },
        version: {
          ...selected,
          ...(!selected.current && selected.provider_version_id
            ? { ref: formatVersionRef(fileRef, selected.provider_version_id) }
            : {})
        },
        download: {
          download_id: record.downloadId,
          local_path: localPath,
          fetch_url: fetchUrl,
          media_type: record.mediaType,
          media_type_source: media.media_type_source,
          sha256: record.sha256,
          sha1: record.sha1,
          size_bytes: record.sizeBytes,
          expires_at: new Date(record.expiresAtMs).toISOString()
        },
        preview,
        workspace: workspaceRef ? { ref: workspaceRef, membership: "inside" as const } : null,
        cleanup: {
          mode: "ttl" as const,
          ttl_seconds: runtime.config.tempFileTtlSeconds,
          release_tool: "yfy_download_release" as const,
          release_args: { download_id: record.downloadId }
        },
        agent_hint: agentHint(Boolean(localPath), Boolean(fetchUrl))
      };
    } catch (error) {
      if (registeredDownloadId) await runtime.downloads.release(registeredDownloadId).catch(() => undefined);
      else if (!registrationAttempted && typeof downloaded.artifact.temp_path === "string") await removeTemp(runtime, downloaded.artifact.temp_path, Number(downloaded.artifact.size_bytes));
      throw error;
    }
  });

  registerTool(server, "yfy_download_batch", {
    title: "Download Yifangyun Items as ZIP",
    description: "Package 1-20 current files or folders through Provider /v2/file/pack_download and stage one structurally validated ZIP. All refs must belong to the same non-external access identity. Historical versions are not supported. Pass workspace to verify every item before and after packaging.",
    inputSchema: {
      items: z.array(ItemRefSchema).min(1).max(20).describe("Context-bound file/folder refs to package. Duplicates and mixed identities are rejected."),
      workspace: WorkspaceRefSchema.optional(),
      expected: ExpectedDownloadSchema.optional()
    },
    outputSchema: BatchDownloadResultSchema
  }, {
    readOnly: false,
    idempotent: false,
    onInvalidOutput: async (result) => {
      const download = result.download && typeof result.download === "object" && !Array.isArray(result.download) ? result.download as Record<string, unknown> : undefined;
      if (typeof download?.download_id === "string") await runtime.downloads.release(download.download_id);
    }
  }, async ({ items, workspace, expected }, extra) => {
    const exposePath = shouldExposeLocalPath(runtime);
    const exposeUrl = shouldExposeFetchUrl(runtime);
    if (!exposePath && !exposeUrl) {
      throw new YifangyunError("No download delivery channel is enabled (local_path and fetch_url both disabled).", {
        code: "YFY_DOWNLOAD_DELIVERY_CHANNEL_UNAVAILABLE",
        phase: "batch_download_delivery",
        suggestedAction: "Enable YFY_DOWNLOAD_EXPOSE_LOCAL_PATH or YFY_DOWNLOAD_STAGED_HTTP."
      });
    }
    const refs = (items as string[]).map(String);
    if (new Set(refs).size !== refs.length) {
      throw new YifangyunError("Batch download items must be unique.", { code: "YFY_INPUT_INVALID", phase: "batch_download_input" });
    }
    const parsed = refs.map((ref) => ({ ref, item: parseItemRef(ref) }));
    const first = parsed[0]!.item;
    const access = runtime.gateway.context(first.accessContextId);
    if (access.identityRef !== first.identityRef) {
      throw new YifangyunError("Batch item reference belongs to a stale access identity.", { code: "YFY_REF_IDENTITY_MISMATCH", phase: "batch_download" });
    }
    for (const entry of parsed) {
      if (entry.item.accessContextId !== first.accessContextId || entry.item.identityRef !== first.identityRef) {
        throw new YifangyunError("All batch items must belong to the same access identity.", {
          code: "YFY_REF_CONTEXT_CONFLICT",
          phase: "batch_download_input",
          suggestedAction: "Split items by access context and call yfy_download_batch once per identity."
        });
      }
    }
    const workspaceRef = workspace === undefined ? undefined : String(workspace);
    if (access.context.externalEnterpriseId) {
      throw new YifangyunError("Provider pack_download does not declare external enterprise support.", {
        code: "YFY_PACK_DOWNLOAD_EXTERNAL_IDENTITY_UNSUPPORTED",
        phase: "batch_download_input",
        suggestedAction: "Use a non-external access context, or download the files individually through yfy_download."
      });
    }
    const wallTimeoutMs = runtime.config.downloadWallTimeoutMs ?? 300_000;
    const deadline = batchDeadline(extra.signal, wallTimeoutMs);
    let downloaded: Awaited<ReturnType<AppRuntime["client"]["downloadFromUrlToTemp"]>> | undefined;
    let registeredDownloadId: string | undefined;
    let registrationAttempted = false;
    try {
      if (workspaceRef) await assertBatchWorkspaceMembership(runtime, refs, workspaceRef, deadline.signal);
      const typedIds = parsed.map(({ item }) => `${item.type}_${item.id}`);
      const ticket = await runtime.gateway.postUser("/v2/file/pack_download", access.context.id, { item_typed_ids: typedIds }, {}, deadline.signal);
      const ticketData = objectValue(ticket.data);
      if (!ticketData || typeof ticketData.download_url !== "string") {
        throw new YifangyunError("Batch download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "batch_download_ticket" });
      }
      downloaded = await runtime.client.downloadFromUrlToTemp(ticketData.download_url, {
        fileNameHint: "yifangyun-batch.zip",
        namespace: access.identityRef,
        onProgress: progressReporter(extra),
        retry: true,
        signal: deadline.signal,
        timeoutMs: deadline.remainingMs()
      });
      const zipVerification = await validateZipArchive(downloaded.tempPath, deadline.signal);
      if (workspaceRef) await assertBatchWorkspaceMembership(runtime, refs, workspaceRef, deadline.signal);
      const mismatches = expectedMismatches(expected, downloaded);
      if (mismatches.length > 0) {
        throw new YifangyunError("Batch archive does not match the requested expectations.", {
          code: "YFY_EXPECTATION_MISMATCH",
          phase: "batch_expectation_validation",
          agentDetails: { mismatches, actual: { sha1: downloaded.sha1, sha256: downloaded.sha256, size_bytes: downloaded.sizeBytes } },
          suggestedAction: "Review the expected archive hash and retry. No archive was retained."
        });
      }
      registrationAttempted = true;
      const record = await runtime.downloads.register({
        fileName: downloaded.fileName.toLowerCase().endsWith(".zip") ? downloaded.fileName : `${downloaded.fileName}.zip`,
        identityRef: access.identityRef,
        mediaType: "application/zip",
        sha1: downloaded.sha1,
        sha256: downloaded.sha256,
        sizeBytes: downloaded.sizeBytes,
        sourcePath: downloaded.tempPath
      });
      registeredDownloadId = record.downloadId;
      const localPath = exposePath ? record.localPath : null;
      const fetchUrl = exposeUrl ? buildFetchUrl(runtime, record.downloadId, record.fileName) : null;
      return {
        status: "ready" as const,
        format: "zip" as const,
        items: parsed.map(({ ref, item }) => ({ ref, id: item.id, type: item.type })),
        verification: {
          scope: "zip_structure_and_archive_hashes" as const,
          entry_count: zipVerification.entryCount,
          uncompressed_size_bytes: zipVerification.uncompressedSizeBytes
        },
        download: {
          download_id: record.downloadId,
          local_path: localPath,
          fetch_url: fetchUrl,
          media_type: record.mediaType,
          media_type_source: "archive_validation" as const,
          sha256: record.sha256,
          sha1: record.sha1,
          size_bytes: record.sizeBytes,
          expires_at: new Date(record.expiresAtMs).toISOString()
        },
        workspace: workspaceRef ? { ref: workspaceRef, membership: "inside" as const } : null,
        cleanup: {
          mode: "ttl" as const,
          ttl_seconds: runtime.config.tempFileTtlSeconds,
          release_tool: "yfy_download_release" as const,
          release_args: { download_id: record.downloadId }
        },
        agent_hint: batchAgentHint(Boolean(localPath), Boolean(fetchUrl))
      };
    } catch (error) {
      if (registeredDownloadId) await runtime.downloads.release(registeredDownloadId).catch(() => undefined);
      else if (downloaded && !registrationAttempted) await removeTemp(runtime, downloaded.tempPath, downloaded.sizeBytes);
      if (deadline.timedOut() && !extra.signal.aborted) throw downloadWallTimeoutError(wallTimeoutMs);
      throw error;
    } finally {
      deadline.dispose();
    }
  });

  registerTool(server, "yfy_download_release", {
    title: "Release Downloaded Temp File",
    description: "Invalidate a temporary download by download_id and delete it as soon as active HTTP readers finish. Idempotent. This is optional because TTL cleanup is automatic; call it after parsing to free disk sooner.",
    inputSchema: { download_id: DownloadIdSchema },
    outputSchema: {
      status: z.enum(["released", "already_unavailable"]),
      download_id: DownloadIdSchema
    }
  }, { readOnly: false, destructive: true, idempotent: true, openWorld: false }, async ({ download_id }) => {
    const released = await runtime.downloads.release(String(download_id));
    return { status: released ? "released" as const : "already_unavailable" as const, download_id: String(download_id) };
  });
}
