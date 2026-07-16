import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ApiJsonResponse,
  ApiResponseMeta,
  AppConfig,
  DownloadedFile,
  IdLike,
  JsonObject,
  JsonValue,
  RateLimitMeta,
  TokenRecord,
  TokenResponse,
  TokenSubjectType,
  UploadDeliveryResult
} from "./types.js";
import { metrics } from "./observability.js";

interface ApiTokenRequest {
  subjectType: TokenSubjectType;
  subjectId: IdLike;
}

interface RequestJsonOptions {
  body?: JsonValue;
  method: "GET" | "POST";
  params?: Record<string, string | number | boolean | undefined>;
  retry?: boolean;
  signal?: AbortSignal;
  token: string;
}

interface RawRequestResult {
  abort: (reason?: unknown) => void;
  cleanup: () => void;
  meta: ApiResponseMeta;
  response: Response;
  signal: AbortSignal;
}

interface DownloadOptions {
  fileNameHint: string;
  namespace?: string;
  retry?: boolean;
}

export class YifangyunError extends Error {
  readonly code: string;
  readonly details?: JsonObject;
  readonly phase?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly scanId?: string;
  readonly statusCode?: number;
  readonly suggestedAction?: string;

  constructor(
    message: string,
    options: {
      details?: JsonObject;
      code?: string;
      phase?: string;
      retryAfterMs?: number;
      retryable?: boolean;
      scanId?: string;
      statusCode?: number;
      suggestedAction?: string;
    } = {}
  ) {
    super(message);
    this.name = "YifangyunError";
    this.code = options.code ?? "YFY_UNEXPECTED_ERROR";
    this.details = options.details;
    this.phase = options.phase;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.scanId = options.scanId;
    this.statusCode = options.statusCode;
    this.suggestedAction = options.suggestedAction;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const output: JsonObject = {};
    for (const [key, field] of Object.entries(value)) {
      output[key] = asJsonValue(field);
    }
    return output;
  }
  return String(value);
}

function getString(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getNumber(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function getBoolean(value: JsonObject, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function parseJson(text: string): unknown {
  return text ? JSON.parse(text) : null;
}

function summarizeText(text: string): string {
  return redactSensitiveText(text.replace(/\s+/g, " ").trim()).slice(0, 300);
}

function summarizeShape(value: JsonValue): JsonObject {
  if (Array.isArray(value)) {
    return { type: "array", count: value.length };
  }
  if (isJsonObject(value)) {
    const output: JsonObject = { type: "object", keys: Object.keys(value).slice(0, 20) };
    const message = getString(value, "message") ?? getString(value, "msg") ?? getString(value, "error");
    const code = getString(value, "code") ?? getNumber(value, "code");
    if (message) {
      output.message = redactSensitiveText(message);
    }
    if (code !== undefined) {
      output.code = code;
    }
    return output;
  }
  return { type: value === null ? "null" : typeof value };
}

function normalizeHeaderMap(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = value;
  });
  return output;
}

function parseRateLimit(headers: Headers): RateLimitMeta | undefined {
  const limit = headers.get("x-rate-limit-limit");
  const remaining = headers.get("x-rate-limit-remaining");
  const reset = headers.get("x-rate-limit-reset");
  const output: RateLimitMeta = {};
  if (limit && Number.isFinite(Number(limit))) {
    output.limit = Number(limit);
  }
  if (remaining && Number.isFinite(Number(remaining))) {
    output.remaining = Number(remaining);
  }
  if (reset && Number.isFinite(Number(reset))) {
    output.resetSeconds = Number(reset);
  }
  return Object.keys(output).length ? output : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "download.bin";
}

function isPrivateAddress(value: string): boolean {
  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || parts[0] === 0;
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }
  return false;
}

function detectContentType(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip";
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  return undefined;
}

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return quotedMatch[1];
  }
  const plainMatch = value.match(/filename=([^;]+)/i);
  if (plainMatch) {
    return plainMatch[1].trim();
  }
  return undefined;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, "Bearer ***redacted***")
    .replace(/(access_token|refresh_token|client_secret|download_url|presign_url)(['\"\s:=]+)([^'\"\s,}]+)/gi, "$1$2***redacted***")
    .replace(/([?&](?:sign|token|access_token|authorization)=)[^&\s]+/gi, "$1***redacted***");
}

export class YifangyunClient {
  private lastTempPruneAt = 0;
  private readonly bucketSemaphores = new Map<string, Semaphore>();
  private readonly requestSemaphore: Semaphore;
  private readonly tokenCache = new Map<string, TokenRecord>();
  private readonly tokenInflight = new Map<string, Promise<TokenRecord>>();

  constructor(private readonly config: AppConfig) {
    this.requestSemaphore = new Semaphore(Math.max(1, config.maxConcurrentProviderRequests ?? 4));
    const cleanupTimer = setInterval(() => void this.pruneExpiredTempFiles(), 60000);
    cleanupTimer.unref();
  }

  async getEnterpriseToken(): Promise<string> {
    return this.getToken({ subjectType: "enterprise", subjectId: this.config.enterpriseId });
  }

  async getUserToken(userId?: IdLike): Promise<string> {
    return this.getToken({ subjectType: "user", subjectId: userId ?? this.config.defaultUserId });
  }

  resolveFileAccessUser(userId?: IdLike): IdLike {
    if (userId !== undefined) {
      return userId;
    }
    if (this.config.fileAccessUserStrategy === "explicit") {
      throw new YifangyunError("This server requires an explicit user_id for file access tools.", {
        details: { suggestion: "Pass user_id, or change YFY_FILE_ACCESS_USER_STRATEGY to default/admin." }
      });
    }
    if (this.config.fileAccessUserStrategy === "admin") {
      if (this.config.adminUserId === undefined) {
        throw new YifangyunError("Admin file access strategy is enabled but YFY_ADMIN_USER_ID is not configured.");
      }
      return this.config.adminUserId;
    }
    return this.config.defaultUserId;
  }

  resolveAccessIdentityRef(userId?: IdLike, externalEnterpriseId?: IdLike): string {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return crypto
      .createHmac("sha256", this.config.clientSecret)
      .update([String(this.config.enterpriseId), String(resolvedUserId), String(externalEnterpriseId ?? ""), this.config.apiBaseUrl].join(":"))
      .digest("hex")
      .slice(0, 24);
  }

  async getEnterprise(pathname: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<ApiJsonResponse> {
    return this.apiJsonRequest(pathname, {
      method: "GET",
      params,
      retry: true,
      token: await this.getEnterpriseToken()
    });
  }

  async postEnterprise(
    pathname: string,
    body: JsonValue,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<ApiJsonResponse> {
    return this.apiJsonRequest(pathname, {
      body,
      method: "POST",
      params,
      retry: false,
      token: await this.getEnterpriseToken()
    });
  }

  async getAsUser(
    pathname: string,
    userId?: IdLike,
    params: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal
  ): Promise<ApiJsonResponse> {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return this.apiJsonRequest(pathname, {
      method: "GET",
      params,
      retry: true,
      signal,
      token: await this.getUserToken(resolvedUserId)
    });
  }

  async postAsUser(
    pathname: string,
    userId: IdLike | undefined,
    body: JsonValue,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<ApiJsonResponse> {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return this.apiJsonRequest(pathname, {
      body,
      method: "POST",
      params,
      retry: false,
      token: await this.getUserToken(resolvedUserId)
    });
  }

  async downloadFromUrlToTemp(url: string, options: DownloadOptions): Promise<DownloadedFile> {
    const downloadStartedAt = Date.now();
    await this.validateTransferUrl(url);
    await this.pruneExpiredTempFiles();
    const targetDir = await this.ensureTempDir(options.namespace);
    const result = await this.rawRequest(url, { method: "GET" }, {
      retry: options.retry ?? true,
      timeoutMs: this.config.downloadWallTimeoutMs ?? 300000
    });
    const contentLength = Number(result.response.headers.get("content-length") ?? "0");
    if (contentLength > 0 && contentLength > this.config.maxDownloadBytes) {
      await result.response.body?.cancel().catch(() => undefined);
      result.cleanup();
      throw new YifangyunError("Download exceeds YFY_MAX_DOWNLOAD_BYTES.", {
        code: "YFY_DOWNLOAD_TOO_LARGE",
        details: { content_length: contentLength, max_download_bytes: this.config.maxDownloadBytes }
      });
    }
    try {
      await this.ensureTempCapacity(contentLength > 0 ? contentLength : 0);
    } catch (error) {
      await result.response.body?.cancel().catch(() => undefined);
      result.cleanup();
      throw error;
    }

    const suggestedName =
      parseContentDispositionFileName(result.response.headers.get("content-disposition")) ?? sanitizeFileName(options.fileNameHint);
    const targetName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${sanitizeFileName(suggestedName)}`;
    const tempPath = path.join(targetDir, targetName);
    const sha1 = crypto.createHash("sha1");
    const hash = crypto.createHash("sha256");
    const sniffChunks: Buffer[] = [];
    let sniffedBytes = 0;
    let sizeBytes = 0;
    const writable = fs.createWriteStream(tempPath, { mode: 0o600 });
    const idleTimeoutMs = this.config.downloadIdleTimeoutMs ?? 30000;
    let idleTimeout: NodeJS.Timeout | undefined;
    const resetIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => result.abort(new Error("Download idle timeout.")), idleTimeoutMs);
    };
    const transform = new Transform({
      transform: (chunk, _encoding, callback) => {
        resetIdleTimeout();
        sizeBytes += chunk.length;
        if (sizeBytes > this.config.maxDownloadBytes) {
          callback(new YifangyunError("Download exceeds YFY_MAX_DOWNLOAD_BYTES while streaming.", {
            details: { max_download_bytes: this.config.maxDownloadBytes }
          }));
          return;
        }
        hash.update(chunk);
        sha1.update(chunk);
        if (sniffedBytes < 512) {
          const buffer = Buffer.from(chunk);
          const selected = buffer.subarray(0, 512 - sniffedBytes);
          sniffChunks.push(selected);
          sniffedBytes += selected.length;
        }
        callback(null, chunk);
      }
    });

    try {
      if (!result.response.body) {
        throw new YifangyunError("Download response did not include a response body.");
      }
      resetIdleTimeout();
      await pipeline(Readable.fromWeb(result.response.body as globalThis.ReadableStream<Uint8Array>), transform, writable, { signal: result.signal });
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof YifangyunError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new YifangyunError(redactSensitiveText(`Failed to download file content: ${message}`), {
        code: "YFY_DOWNLOAD_STREAM_FAILED",
        phase: "download_stream",
        retryable: true
      });
    } finally {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      result.cleanup();
    }

    metrics.increment("download_bytes_total", {}, sizeBytes);
    metrics.observe("download_hash_latency_ms", Date.now() - downloadStartedAt);
    return {
      contentType: result.response.headers.get("content-type") ?? undefined,
      detectedContentType: detectContentType(Buffer.concat(sniffChunks)),
      fileName: suggestedName,
      meta: result.meta,
      sha1: sha1.digest("hex"),
      sha256: hash.digest("hex"),
      sizeBytes,
      tempPath
    };
  }

  async uploadLocalFileToPresignedUrl(presignUrl: string, localPath: string, fileName: string): Promise<UploadDeliveryResult> {
    await this.validateTransferUrl(presignUrl);
    const stat = await fsp.stat(localPath);
    if (!stat.isFile()) {
      throw new YifangyunError("local_path must point to a file.", { details: { local_path: localPath } });
    }

    if (stat.size > this.config.maxDownloadBytes) {
      throw new YifangyunError("Upload exceeds YFY_MAX_DOWNLOAD_BYTES safeguard.", {
        details: { file_size: stat.size, max_allowed_bytes: this.config.maxDownloadBytes }
      });
    }

    let response = await this.fetchTransfer(presignUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": "application/octet-stream"
      },
      body: fs.createReadStream(localPath) as unknown as RequestInit["body"],
      duplex: "half"
    } as RequestInit);

    let deliveryMethod = "PUT_BINARY";
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (stat.size > 16 * 1024 * 1024) {
        throw new YifangyunError("Binary upload failed and multipart fallback is disabled for files larger than 16 MiB.", {
          code: "YFY_UPLOAD_FALLBACK_TOO_LARGE",
          details: { file_size: stat.size, upload_method_attempted: "PUT_BINARY" },
          phase: "upload_delivery",
          suggestedAction: "Check the presigned upload contract instead of buffering the file in memory."
        });
      }
      const fileBuffer = await fsp.readFile(localPath);
      const form = new FormData();
      form.append("file", new Blob([fileBuffer]), fileName);
      response = await this.fetchTransfer(presignUrl, {
        method: "POST",
        body: form
      });
      deliveryMethod = "POST_MULTIPART";
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new YifangyunError(`Presigned upload failed with HTTP ${response.status}.`, {
        details: {
          response_preview: summarizeText(text),
          status_code: response.status,
          upload_method_attempted: deliveryMethod
        },
        retryable: false,
        statusCode: response.status
      });
    }
    await response.body?.cancel().catch(() => undefined);

    return {
      deliveryMethod,
      fileName,
      localPath,
      remoteStatusCode: response.status,
      sizeBytes: stat.size
    };
  }

  private async getToken(request: ApiTokenRequest): Promise<string> {
    const cacheKey = `${request.subjectType}:${String(request.subjectId)}`;
    const cached = this.tokenCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs - this.config.tokenRefreshSkewSeconds * 1000 > now) {
      return cached.accessToken;
    }

    let inflight = this.tokenInflight.get(cacheKey);
    if (!inflight) {
      inflight = this.requestToken(request);
      this.tokenInflight.set(cacheKey, inflight);
    }
    try {
      const token = await inflight;
      this.tokenCache.set(cacheKey, token);
      return token.accessToken;
    } finally {
      this.tokenInflight.delete(cacheKey);
    }
  }

  private async requestToken(request: ApiTokenRequest): Promise<TokenRecord> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      yifangyun_sub_type: request.subjectType,
      sub: request.subjectId,
      exp: nowSeconds + 60,
      iat: nowSeconds,
      jti: crypto.createHash("md5").update(crypto.randomBytes(16)).digest("hex")
    };
    const assertion = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    const url = new URL(`${this.config.oauthBaseUrl}/oauth/token`);
    url.searchParams.set("grant_type", "jwt_simple");
    url.searchParams.set("assertion", assertion);

    const response = await this.jsonRequest(url.toString(), {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}` }
    }, false);

    if (!isJsonObject(response.data) || typeof response.data.access_token !== "string") {
      throw new YifangyunError("OAuth token response did not include access_token.", {
        details: { response_shape: summarizeShape(asJsonValue(response.data)) }
      });
    }

    const tokenData = response.data as unknown as TokenResponse;
    const expiresIn = typeof tokenData.expires_in === "number" && tokenData.expires_in > 0 ? tokenData.expires_in : 21600;
    return {
      accessToken: tokenData.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000
    };
  }

  private async apiJsonRequest(pathname: string, options: RequestJsonOptions): Promise<ApiJsonResponse> {
    const url = new URL(`${this.config.apiBaseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return this.jsonRequest(
      url.toString(),
      {
        method: options.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.token}`,
          ...(options.method === "POST" ? { "Content-Type": "application/json" } : {})
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
      },
      options.retry ?? true,
      options.signal
    );
  }

  private async jsonRequest(url: string, init: RequestInit, retry: boolean, signal?: AbortSignal): Promise<ApiJsonResponse> {
    try {
      const result = await this.rawRequest(url, init, { retry, signal, timeoutMs: this.config.requestTimeoutMs });
      try {
        const text = await result.response.text();
        let parsed: unknown;
        try {
          parsed = parseJson(text);
        } catch (error) {
          throw this.invalidJsonError(result.response, text, url, error);
        }

        const data = asJsonValue(parsed);
        if (!result.response.ok) {
          throw this.httpError(result.response, data, url);
        }

        return {
          data,
          meta: this.buildMeta(result.response, url, data)
        };
      } finally {
        result.cleanup();
      }
    } catch (error) {
      throw error;
    }
  }

  private async rawRequest(url: string, init: RequestInit, options: { retry: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<RawRequestResult> {
    let lastError: unknown;
    const attempts = options.retry ? Math.max(1, this.config.retryMaxAttempts) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const attemptStartedAt = Date.now();
      const controller = new AbortController();
      const cancelFromCaller = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
      if (options.signal?.aborted) {
        cancelFromCaller();
      }
      const timeout = setTimeout(() => controller.abort(new Error("Request wall timeout.")), options.timeoutMs ?? this.config.requestTimeoutMs);
      const release = await this.requestSemaphore.acquire();
      const bucketKey = this.requestBucket(url, init);
      let bucket = this.bucketSemaphores.get(bucketKey);
      if (!bucket) {
        bucket = new Semaphore(Math.max(1, this.config.maxConcurrentRequestsPerIdentity ?? 2));
        this.bucketSemaphores.set(bucketKey, bucket);
      }
      const releaseBucket = await bucket.acquire();
      let returned = false;
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancelFromCaller);
        if (!returned) {
          returned = true;
          releaseBucket();
          release();
        }
      };
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        metrics.observe("provider_request_latency_ms", Date.now() - attemptStartedAt, { endpoint: new URL(url).pathname, status: String(response.status) });
        if (!response.ok && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          metrics.increment("provider_retry_total", { reason: response.status === 429 ? "rate_limit" : "server_error" });
          const delayMs = this.calculateRetryDelay(response.headers, attempt);
          await response.body?.cancel().catch(() => undefined);
          cleanup();
          await sleep(delayMs);
          continue;
        }
        return {
          abort: (reason?: unknown) => controller.abort(reason),
          cleanup,
          meta: this.buildMeta(response, url),
          response,
          signal: controller.signal
        };
      } catch (error) {
        metrics.observe("provider_request_latency_ms", Date.now() - attemptStartedAt, { endpoint: new URL(url).pathname, status: "network_error" });
        cleanup();
        lastError = error;
        const aborted = controller.signal.aborted;
        if (!aborted && attempt + 1 < attempts) {
          metrics.increment("provider_retry_total", { reason: "network_error" });
          await sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt));
          continue;
        }
        if (aborted) {
          const cancelled = options.signal?.aborted === true;
          throw new YifangyunError(cancelled ? "Yifangyun request was cancelled." : "Yifangyun request timed out.", {
            code: cancelled ? "YFY_REQUEST_CANCELLED" : "YFY_PROVIDER_TIMEOUT",
            phase: "provider_request",
            retryable: !cancelled
          });
        }
        break;
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new YifangyunError(redactSensitiveText(`Yifangyun request failed: ${message}`), { code: "YFY_PROVIDER_NETWORK_ERROR", phase: "provider_request", retryable: true });
  }

  private buildMeta(response: Response, url: string, data?: JsonValue): ApiResponseMeta {
    const pathname = new URL(url).pathname;
    const now = Date.now();
    let requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
    if (!requestId && isJsonObject(data)) {
      requestId = getString(data, "request_id");
    }
    const sourceApiVersion = pathname.match(/\/v\d+\//)?.[0]?.replaceAll("/", "") ?? "unknown";
    return {
      endpoint: pathname,
      fetchedAtIso: new Date(now).toISOString(),
      fetchedAtUnix: Math.floor(now / 1000),
      ...(requestId ? { requestId } : {}),
      ...(parseRateLimit(response.headers) ? { rateLimit: parseRateLimit(response.headers) } : {}),
      sourceApiVersion,
      statusCode: response.status
    };
  }

  private calculateRetryDelay(headers: Headers, attempt: number): number {
    const retryAfter = headers.get("retry-after");
    if (retryAfter && Number.isFinite(Number(retryAfter))) {
      return Math.min(this.config.maxRetryDelayMs ?? 30000, Math.max(1000, Number(retryAfter) * 1000));
    }
    if (retryAfter) {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) {
        return Math.min(this.config.maxRetryDelayMs ?? 30000, Math.max(1000, retryAt - Date.now()));
      }
    }
    const rateLimit = parseRateLimit(headers);
    if (rateLimit?.resetSeconds !== undefined) {
      const resetMs = rateLimit.resetSeconds > Math.floor(Date.now() / 1000)
        ? rateLimit.resetSeconds * 1000 - Date.now()
        : rateLimit.resetSeconds * 1000;
      return Math.min(this.config.maxRetryDelayMs ?? 30000, Math.max(1000, resetMs));
    }
    const base = this.config.retryBaseDelayMs * Math.pow(2, attempt);
    const jittered = base * (0.75 + Math.random() * 0.5);
    return Math.min(this.config.maxRetryDelayMs ?? 30000, Math.round(jittered));
  }

  private httpError(response: Response, responseBody: JsonValue, url: string): YifangyunError {
    const endpoint = new URL(url).pathname;
    const retryable = response.status === 429 || response.status >= 500;
    const rateLimit = parseRateLimit(response.headers);
    const details: JsonObject = {
      endpoint,
      response_shape: summarizeShape(responseBody),
      status_code: response.status
    };
    if (rateLimit) {
      details.rate_limit = asJsonValue(rateLimit);
    }

    let message = `Yifangyun API request failed with HTTP ${response.status}.`;
    if (isJsonObject(responseBody)) {
      const errors = responseBody.errors;
      if (Array.isArray(errors) && errors.length > 0 && isJsonObject(errors[0])) {
        const apiCode = getString(errors[0], "code");
        const apiMessage = getString(errors[0], "msg") ?? getString(errors[0], "message");
        if (apiCode) {
          details.api_code = apiCode;
        }
        if (apiMessage) {
          details.api_message = redactSensitiveText(apiMessage);
          message = apiMessage;
        }
      }
      const requestId = getString(responseBody, "request_id");
      if (requestId) {
        details.request_id = requestId;
      }
    }

    if (response.status === 401) {
      message = "Authentication failed. Check client credentials, enterprise_id, user_id, and OAuth base URL.";
    } else if (response.status === 403) {
      message = "Permission denied. Use a user_id that has access to the requested cloud-drive resource.";
    } else if (response.status === 404) {
      message = "Resource not found. Check the department, folder, file, group, or user id.";
    }

    const code = response.status === 401 ? "YFY_AUTHENTICATION_FAILED"
      : response.status === 403 ? "YFY_PERMISSION_DENIED"
        : response.status === 404 ? "YFY_RESOURCE_NOT_FOUND"
          : response.status === 429 ? "YFY_RATE_LIMITED"
            : response.status >= 500 ? "YFY_PROVIDER_SERVER_ERROR" : "YFY_PROVIDER_HTTP_ERROR";
    return new YifangyunError(redactSensitiveText(message), {
      code,
      details,
      phase: "provider_request",
      retryAfterMs: this.calculateRetryDelay(response.headers, 0),
      retryable,
      statusCode: response.status
    });
  }

  private invalidJsonError(response: Response, text: string, url: string, error: unknown): YifangyunError {
    const endpoint = new URL(url).pathname;
    const reason = error instanceof Error ? error.message : String(error);
    return new YifangyunError("Yifangyun response was not valid JSON. Check base URL, reverse proxy, and credentials.", {
      code: "YFY_PROVIDER_INVALID_JSON",
      details: {
        content_type: response.headers.get("content-type") ?? "",
        endpoint,
        parse_error: redactSensitiveText(reason),
        response_preview: summarizeText(text),
        status_code: response.status
      },
      phase: "provider_response_parse",
      retryable: response.status === 429 || response.status >= 500,
      statusCode: response.status
    });
  }

  private async ensureTempDir(namespace?: string): Promise<string> {
    await fsp.mkdir(this.config.tempDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.config.tempDir, 0o700).catch(() => undefined);
    const safeNamespace = (namespace ?? "shared").replace(/[^a-zA-Z0-9_-]/g, "_");
    const targetDir = path.join(this.config.tempDir, "artifacts", safeNamespace);
    await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(targetDir, 0o700).catch(() => undefined);
    return targetDir;
  }

  private async ensureTempCapacity(incomingBytes: number): Promise<void> {
    const maxTempBytes = this.config.maxTempBytes ?? 1073741824;
    const usedBytes = await this.directoryFileBytes(this.config.tempDir);
    if (usedBytes + incomingBytes > maxTempBytes) {
      throw new YifangyunError("Local temporary storage quota would be exceeded.", {
        code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
        details: { incoming_bytes: incomingBytes, max_temp_bytes: maxTempBytes, used_bytes: usedBytes },
        phase: "temp_storage"
      });
    }
  }

  private async validateTransferUrl(value: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new YifangyunError("Provider transfer URL is invalid.", { code: "YFY_TRANSFER_URL_INVALID", phase: "transfer_url_validation" });
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new YifangyunError("Provider transfer URL must use HTTPS and must not contain userinfo.", {
        code: "YFY_TRANSFER_URL_REJECTED",
        phase: "transfer_url_validation"
      });
    }
    if (this.config.allowPrivateTransferUrls) {
      return;
    }
    const addresses = await dns.promises.lookup(parsed.hostname, { all: true }).catch(() => []);
    if (parsed.hostname === "localhost" || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new YifangyunError("Provider transfer URL resolves to a private network address.", {
        code: "YFY_TRANSFER_URL_PRIVATE_ADDRESS",
        phase: "transfer_url_validation",
        suggestedAction: "Set YFY_ALLOW_PRIVATE_TRANSFER_URLS=enabled only for a trusted private deployment."
      });
    }
  }

  private async pruneExpiredTempFiles(): Promise<void> {
    if (Date.now() - this.lastTempPruneAt < 60000) {
      return;
    }
    this.lastTempPruneAt = Date.now();
    if (this.config.tempFileTtlSeconds <= 0) {
      return;
    }
    const cutoffMs = Date.now() - this.config.tempFileTtlSeconds * 1000;
    await this.pruneDirectory(this.config.tempDir, cutoffMs);
  }

  private async directoryFileBytes(directory: string): Promise<number> {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await this.directoryFileBytes(entryPath);
      } else if (entry.isFile()) {
        total += (await fsp.stat(entryPath).catch(() => undefined))?.size ?? 0;
      }
    }
    return total;
  }

  private async pruneDirectory(directory: string, cutoffMs: number): Promise<void> {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.pruneDirectory(entryPath, cutoffMs);
        const remaining = await fsp.readdir(entryPath).catch(() => []);
        if (remaining.length === 0) {
          await fsp.rmdir(entryPath).catch(() => undefined);
        }
      } else if (entry.isFile()) {
        const stat = await fsp.stat(entryPath).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoffMs) {
          await fsp.rm(entryPath, { force: true }).catch(() => undefined);
        }
      }
    }
  }

  private async fetchTransfer(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Transfer wall timeout.")), this.config.downloadWallTimeoutMs ?? 300000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestBucket(url: string, init: RequestInit): string {
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization") ?? "anonymous";
    const identity = crypto.createHash("sha256").update(authorization).digest("hex").slice(0, 16);
    const pathname = new URL(url).pathname.split("/").slice(0, 5).join("/");
    return `${identity}:${pathname}`;
  }
}
