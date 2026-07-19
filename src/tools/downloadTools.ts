import { promises as fs } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YifangyunError } from "../client.js";
import { normalizeFileVersions, selectFileVersion, type DownloadStrategy, type FileVersion, type VersionSelector } from "../domain/fileVersions.js";
import { objectValue, projectItem } from "../domain/projectors.js";
import { formatVersionRef, parseItemRef, parseVersionRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import type { JsonObject } from "../types.js";
import { FileRefSchema, FileVersionSchema, ItemSchema, VersionRefSchema, WorkspaceRefSchema } from "./schemas.js";
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

const DownloadResultSchema = z.object({
  status: z.literal("ready"),
  file: ItemSchema.extend({ ref: FileRefSchema }),
  version: FileVersionSchema.extend({ ref: VersionRefSchema.optional() }),
  download: z.object({
    download_id: DownloadIdSchema,
    local_path: z.string().min(1).nullable().describe("Absolute server path for co-located stdio Hosts; null for remote HTTP by default."),
    fetch_url: HttpUrlSchema.nullable().describe("Authenticated staged HTTP URL for remote Hosts; null in stdio mode."),
    media_type: z.string(),
    media_type_source: z.enum(["content_type", "magic_sniff", "file_extension", "octet_stream"]),
    sha256: z.string().regex(/^[a-f\d]{64}$/i),
    sha1: z.string().regex(/^[a-f\d]{40}$/i),
    size_bytes: z.number().int().nonnegative(),
    expires_at: z.string().datetime()
  }).strict(),
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
  cleanup: z.object({
    mode: z.literal("ttl"),
    ttl_seconds: z.number().int().positive(),
    release_tool: z.literal("yfy_download_release"),
    release_args: z.object({ download_id: DownloadIdSchema }).strict()
  }).strict(),
  agent_hint: z.string()
}).strict();

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
      expected: z.object({
        sha1: z.string().trim().regex(/^[a-f\d]{40}$/i).optional().describe("Optional expected SHA-1 assertion."),
        sha256: z.string().trim().regex(/^[a-f\d]{64}$/i).optional().describe("Optional expected SHA-256 assertion."),
        size_bytes: z.number().int().nonnegative().optional().describe("Optional expected byte-size assertion.")
      }).strict().optional()
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
    const versionsResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, access.context.id, {}, extra.signal);
    const versionsBefore = normalizeFileVersions(versionsResponse.data);
    const selector = selectorFor(fileRef, version);
    const selected = selectFileVersion(versionsBefore.versions, selector);

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
    try {
      // Light drift check: version history fingerprint must stay stable during download.
      const versionsAfterResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, access.context.id, {}, extra.signal);
      const versionsAfter = normalizeFileVersions(versionsAfterResponse.data);
      if (versionsBefore.fingerprint !== versionsAfter.fingerprint) {
        throw new YifangyunError("File version history changed while content was being downloaded.", {
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

      const expectedObj = expected && typeof expected === "object" ? expected as Record<string, unknown> : {};
      const mismatches: string[] = [];
      if (typeof expectedObj.sha1 === "string" && String(downloaded.artifact.sha1).toLowerCase() !== expectedObj.sha1.toLowerCase()) mismatches.push("sha1");
      if (typeof expectedObj.sha256 === "string" && String(downloaded.artifact.sha256).toLowerCase() !== expectedObj.sha256.toLowerCase()) mismatches.push("sha256");
      if (typeof expectedObj.size_bytes === "number" && Number(downloaded.artifact.size_bytes) !== expectedObj.size_bytes) mismatches.push("size_bytes");
      if (mismatches.length > 0) {
        throw new YifangyunError("Downloaded content does not match the requested expectations.", {
          code: "YFY_EXPECTATION_MISMATCH",
          phase: "expectation_validation",
          agentDetails: { mismatches, actual: { sha1: downloaded.artifact.sha1, sha256: downloaded.artifact.sha256, size_bytes: downloaded.artifact.size_bytes } },
          suggestedAction: "Review metadata and retry. No file was retained."
        });
      }

      const media = resolveMediaType(downloaded.artifact.content_type, downloaded.artifact.detected_content_type, downloaded.artifact.file_name);
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
      else if (typeof downloaded.artifact.temp_path === "string") await removeTemp(runtime, downloaded.artifact.temp_path, Number(downloaded.artifact.size_bytes));
      throw error;
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
