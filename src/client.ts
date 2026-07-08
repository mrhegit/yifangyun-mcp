import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
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

interface ApiTokenRequest {
  subjectType: TokenSubjectType;
  subjectId: IdLike;
}

interface RequestJsonOptions {
  body?: JsonValue;
  method: "GET" | "POST";
  params?: Record<string, string | number | boolean | undefined>;
  retry?: boolean;
  token: string;
}

interface RawRequestResult {
  meta: ApiResponseMeta;
  response: Response;
}

interface DownloadOptions {
  fileNameHint: string;
  retry?: boolean;
}

export class YifangyunError extends Error {
  readonly details?: JsonObject;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      details?: JsonObject;
      retryAfterMs?: number;
      retryable?: boolean;
      statusCode?: number;
    } = {}
  ) {
    super(message);
    this.name = "YifangyunError";
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
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

function parseContentDispositionFileName(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
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
  private readonly tokenCache = new Map<string, TokenRecord>();

  constructor(private readonly config: AppConfig) {}

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
      retry: true,
      token: await this.getEnterpriseToken()
    });
  }

  async getAsUser(
    pathname: string,
    userId?: IdLike,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<ApiJsonResponse> {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return this.apiJsonRequest(pathname, {
      method: "GET",
      params,
      retry: true,
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
      retry: true,
      token: await this.getUserToken(resolvedUserId)
    });
  }

  async downloadFromUrlToTemp(url: string, options: DownloadOptions): Promise<DownloadedFile> {
    await this.ensureTempDir();
    await this.pruneExpiredTempFiles();
    const result = await this.rawRequest(url, { method: "GET" }, { retry: options.retry ?? true });
    const contentLength = Number(result.response.headers.get("content-length") ?? "0");
    if (contentLength > 0 && contentLength > this.config.maxDownloadBytes) {
      throw new YifangyunError("Download exceeds YFY_MAX_DOWNLOAD_BYTES.", {
        details: { content_length: contentLength, max_download_bytes: this.config.maxDownloadBytes }
      });
    }

    const suggestedName =
      parseContentDispositionFileName(result.response.headers.get("content-disposition")) ?? sanitizeFileName(options.fileNameHint);
    const targetName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${sanitizeFileName(suggestedName)}`;
    const tempPath = path.join(this.config.tempDir, targetName);
    const hash = crypto.createHash("sha256");
    let sizeBytes = 0;
    const writable = fs.createWriteStream(tempPath);
    const transform = new Transform({
      transform: (chunk, _encoding, callback) => {
        sizeBytes += chunk.length;
        if (sizeBytes > this.config.maxDownloadBytes) {
          callback(new YifangyunError("Download exceeds YFY_MAX_DOWNLOAD_BYTES while streaming.", {
            details: { max_download_bytes: this.config.maxDownloadBytes }
          }));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      }
    });

    try {
      if (!result.response.body) {
        throw new YifangyunError("Download response did not include a response body.");
      }
      await pipeline(Readable.fromWeb(result.response.body as globalThis.ReadableStream<Uint8Array>), transform, writable);
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof YifangyunError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new YifangyunError(redactSensitiveText(`Failed to download file content: ${message}`), { retryable: true });
    }

    return {
      contentType: result.response.headers.get("content-type") ?? undefined,
      fileName: suggestedName,
      meta: result.meta,
      sha256: hash.digest("hex"),
      sizeBytes,
      tempPath
    };
  }

  async uploadLocalFileToPresignedUrl(presignUrl: string, localPath: string, fileName: string): Promise<UploadDeliveryResult> {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile()) {
      throw new YifangyunError("local_path must point to a file.", { details: { local_path: localPath } });
    }

    if (stat.size > this.config.maxDownloadBytes) {
      throw new YifangyunError("Upload exceeds YFY_MAX_DOWNLOAD_BYTES safeguard.", {
        details: { file_size: stat.size, max_allowed_bytes: this.config.maxDownloadBytes }
      });
    }

    let response = await fetch(presignUrl, {
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
      const fileBuffer = await fsp.readFile(localPath);
      const form = new FormData();
      form.append("file", new Blob([fileBuffer]), fileName);
      response = await fetch(presignUrl, {
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

    const token = await this.requestToken(request);
    this.tokenCache.set(cacheKey, token);
    return token.accessToken;
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
      options.retry ?? true
    );
  }

  private async jsonRequest(url: string, init: RequestInit, retry: boolean): Promise<ApiJsonResponse> {
    const result = await this.rawRequest(url, init, { retry });
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
  }

  private async rawRequest(url: string, init: RequestInit, options: { retry: boolean }): Promise<RawRequestResult> {
    let lastError: unknown;
    const attempts = options.retry ? Math.max(1, this.config.retryMaxAttempts) : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const delayMs = this.calculateRetryDelay(response.headers, attempt);
          await sleep(delayMs);
          continue;
        }
        return {
          meta: this.buildMeta(response, url),
          response
        };
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error && error.name === "AbortError") && attempt + 1 < attempts) {
          await sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt));
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new YifangyunError("Yifangyun request timed out.", { retryable: true });
        }
        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new YifangyunError(redactSensitiveText(`Yifangyun request failed: ${message}`), { retryable: true });
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
      return Math.max(1000, Number(retryAfter) * 1000);
    }
    const rateLimit = parseRateLimit(headers);
    if (rateLimit?.resetSeconds !== undefined) {
      return Math.max(1000, rateLimit.resetSeconds * 1000);
    }
    return this.config.retryBaseDelayMs * Math.pow(2, attempt);
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

    return new YifangyunError(redactSensitiveText(message), {
      details,
      retryAfterMs: this.calculateRetryDelay(response.headers, 0),
      retryable,
      statusCode: response.status
    });
  }

  private invalidJsonError(response: Response, text: string, url: string, error: unknown): YifangyunError {
    const endpoint = new URL(url).pathname;
    const reason = error instanceof Error ? error.message : String(error);
    return new YifangyunError("Yifangyun response was not valid JSON. Check base URL, reverse proxy, and credentials.", {
      details: {
        content_type: response.headers.get("content-type") ?? "",
        endpoint,
        parse_error: redactSensitiveText(reason),
        response_preview: summarizeText(text),
        status_code: response.status
      },
      retryable: response.status === 429 || response.status >= 500,
      statusCode: response.status
    });
  }

  private async ensureTempDir(): Promise<void> {
    await fsp.mkdir(this.config.tempDir, { recursive: true });
  }

  private async pruneExpiredTempFiles(): Promise<void> {
    if (this.config.tempFileTtlSeconds <= 0) {
      return;
    }
    const cutoffMs = Date.now() - this.config.tempFileTtlSeconds * 1000;
    const entries = await fsp.readdir(this.config.tempDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const entryPath = path.join(this.config.tempDir, entry.name);
        const stat = await fsp.stat(entryPath).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoffMs) {
          await fsp.rm(entryPath, { force: true }).catch(() => undefined);
        }
      })
    );
  }
}
