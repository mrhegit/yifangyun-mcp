import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import net from "node:net";
import type { LookupFunction } from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, fetch as undiciFetch } from "undici";
import type { RequestInit as UndiciRequestInit } from "undici";
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

type TransferFetch = (url: string, init: RequestInit & { dispatcher: Agent }) => Promise<Response>;
type DnsLookup = typeof dns.lookup;

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
  onProgress?: (bytes: number, totalBytes?: number) => void;
  retry?: boolean;
  signal?: AbortSignal;
}

export class YifangyunError extends Error {
  readonly agentDetails?: JsonObject;
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
      agentDetails?: JsonObject;
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
    this.agentDetails = options.agentDetails;
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

export function createTransferLookup(allowPrivateTransferUrls: boolean, lookup: DnsLookup = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, []);
        return;
      }
      if (!allowPrivateTransferUrls && addresses.some((entry) => isPrivateAddress(entry.address))) {
        const rejected = Object.assign(new Error("Provider transfer URL resolved to a private network address."), { code: "YFY_TRANSFER_URL_PRIVATE_ADDRESS" });
        callback(rejected, []);
        return;
      }
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const selected = addresses[0];
      if (!selected) {
        callback(Object.assign(new Error("Provider transfer hostname did not resolve."), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  };
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new YifangyunError("Yifangyun request was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_auth" }));
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new YifangyunError("Yifangyun request was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_auth" }));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ reject: (error: unknown) => void; resolve: (release: () => void) => void; signal?: AbortSignal }> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new YifangyunError("Yifangyun request was cancelled while waiting for concurrency capacity.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_queue" });
    }
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: { reject: (error: unknown) => void; resolve: (release: () => void) => void; signal?: AbortSignal };
      const cancel = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new YifangyunError("Yifangyun request was cancelled while waiting for concurrency capacity.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_queue" }));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      waiter = {
        reject,
        ...(signal ? { signal } : {}),
        resolve: (release) => {
          signal?.removeEventListener("abort", cancel);
          resolve(release);
        }
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(() => this.release());
    } else {
      this.active -= 1;
    }
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new YifangyunError("Yifangyun request was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_retry" }));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timeout);
      reject(new YifangyunError("Yifangyun request was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "provider_retry" }));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "download.bin";
}

function parseIpv6Words(value: string): number[] | undefined {
  const address = value.toLowerCase().split("%", 1)[0]!;
  let hextetSource = address;
  const dottedMatch = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch) {
    const octets = dottedMatch[2]!.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
    hextetSource = `${dottedMatch[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const compressed = hextetSource.split("::");
  if (compressed.length > 2) return undefined;
  const left = compressed[0] ? compressed[0].split(":") : [];
  const right = compressed.length === 2 && compressed[1] ? compressed[1].split(":") : [];
  if (compressed.length === 1 && left.length !== 8) return undefined;
  const fill = compressed.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 1 && compressed.length === 2) return undefined;
  const hextets = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
  if (hextets.length !== 8 || hextets.some((part) => !/^[a-f\d]{1,4}$/.test(part))) return undefined;
  return hextets.map((part) => Number.parseInt(part, 16));
}

function mappedIpv4Address(value: string): string | undefined {
  const words = parseIpv6Words(value);
  if (!words) return undefined;
  if (!words.slice(0, 5).every((part) => part === 0) || words[5] !== 0xffff) return undefined;
  return `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`;
}

function isPrivateAddress(value: string): boolean {
  const version = net.isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168 || (parts[1] === 88 && parts[2] === 99)))
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100)))
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || parts[0] === 0
      || parts[0]! >= 224;
  }
  if (version === 6) {
    const mapped = mappedIpv4Address(value);
    if (mapped) return isPrivateAddress(mapped);
    const words = parseIpv6Words(value);
    if (!words || (words[0]! & 0xe000) !== 0x2000) return true;
    return (words[0] === 0x2001 && words[1] === 0)
      || (words[0] === 0x2001 && words[1] === 2 && words[2] === 0)
      || (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0010)
      || (words[0] === 0x2001 && (words[1]! & 0xfff0) === 0x0020)
      || (words[0] === 0x2001 && words[1] === 0x0db8)
      || words[0] === 0x2002
      || (words[0] === 0x3fff && (words[1]! & 0xf000) === 0);
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
  // 仅识别明确 SVG 根元素；通用 XML/JSON 依赖响应头或扩展名，避免前缀误判后自动内联。
  if (buffer.length > 0 && !buffer.subarray(0, Math.min(buffer.length, 64)).includes(0)) {
    const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (/(?:^<svg[\s/>]|^<\?xml\b[\s\S]{0,256}<svg[\s/>]|^<!--[\s\S]{0,256}<svg[\s/>])/i.test(head)) return "image/svg+xml";
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
  private readonly cleanupTimer: NodeJS.Timeout;
  private lastTempPruneAt = 0;
  private readonly bucketSemaphores = new Map<string, Semaphore>();
  private readonly requestSemaphore: Semaphore;
  private readonly transferDispatcher: Agent;
  private readonly tempCapacitySemaphore = new Semaphore(1);
  private reservedTempBytes = 0;
  private readonly tokenCache = new Map<string, TokenRecord>();
  private readonly tokenInflight = new Map<string, Promise<TokenRecord>>();

  constructor(private readonly config: AppConfig, private readonly transferFetch: TransferFetch = (url, init) => undiciFetch(url, init as UndiciRequestInit) as unknown as Promise<Response>) {
    this.requestSemaphore = new Semaphore(Math.max(1, config.maxConcurrentProviderRequests ?? 4));
    this.transferDispatcher = new Agent({
      connect: { lookup: createTransferLookup(Boolean(config.allowPrivateTransferUrls)) }
    });
    this.cleanupTimer = setInterval(() => void this.pruneExpiredTempFiles(), 60000);
    this.cleanupTimer.unref();
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await this.transferDispatcher.close();
  }

  async getEnterpriseToken(signal?: AbortSignal): Promise<string> {
    return this.getToken({ subjectType: "enterprise", subjectId: this.config.enterpriseId }, signal);
  }

  async getUserToken(userId?: IdLike, signal?: AbortSignal): Promise<string> {
    return this.getToken({ subjectType: "user", subjectId: userId ?? this.config.defaultUserId }, signal);
  }

  resolveFileAccessUser(userId?: IdLike): IdLike {
    return userId ?? this.config.defaultUserId;
  }

  resolveAccessIdentityRef(userId?: IdLike, externalEnterpriseId?: IdLike): string {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return crypto
      .createHmac("sha256", this.config.clientSecret)
      .update([String(this.config.enterpriseId), String(resolvedUserId), String(externalEnterpriseId ?? ""), this.config.apiBaseUrl].join(":"))
      .digest("hex")
      .slice(0, 24);
  }

  async getEnterprise(pathname: string, params: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal): Promise<ApiJsonResponse> {
    return this.apiJsonRequest(pathname, {
      method: "GET",
      params,
      retry: true,
      signal,
      token: await this.getEnterpriseToken(signal)
    });
  }

  async postEnterprise(
    pathname: string,
    body: JsonValue,
    params: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal
  ): Promise<ApiJsonResponse> {
    return this.apiJsonRequest(pathname, {
      body,
      method: "POST",
      params,
      retry: false,
      signal,
      token: await this.getEnterpriseToken(signal)
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
      token: await this.getUserToken(resolvedUserId, signal)
    });
  }

  async postAsUser(
    pathname: string,
    userId: IdLike | undefined,
    body: JsonValue,
    params: Record<string, string | number | boolean | undefined> = {},
    signal?: AbortSignal
  ): Promise<ApiJsonResponse> {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    return this.apiJsonRequest(pathname, {
      body,
      method: "POST",
      params,
      retry: false,
      signal,
      token: await this.getUserToken(resolvedUserId, signal)
    });
  }

  async downloadFromUrlToTemp(url: string, options: DownloadOptions): Promise<DownloadedFile> {
    const downloadStartedAt = Date.now();
    await this.validateTransferUrl(url);
    const result = await this.rawRequest(url, { method: "GET" }, {
      retry: options.retry ?? true,
      signal: options.signal,
      timeoutMs: this.config.downloadWallTimeoutMs ?? 300000,
      transfer: true
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
    let reservation: { bytes: number; release: () => Promise<void> };
    try {
      reservation = await this.reserveTempCapacity(contentLength > 0 ? contentLength : undefined, options.signal);
    } catch (error) {
      await result.response.body?.cancel().catch(() => undefined);
      result.cleanup();
      throw error;
    }
    let targetDir: string;
    try {
      targetDir = await this.ensureTempDir(options.namespace);
    } catch (error) {
      await result.response.body?.cancel().catch(() => undefined);
      result.cleanup();
      await reservation.release();
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
        options.onProgress?.(sizeBytes, contentLength > 0 ? contentLength : undefined);
        if (sizeBytes > this.config.maxDownloadBytes) {
          callback(new YifangyunError("Download exceeds YFY_MAX_DOWNLOAD_BYTES while streaming.", {
            details: { max_download_bytes: this.config.maxDownloadBytes }
          }));
          return;
        }
        if (sizeBytes > reservation.bytes) {
          callback(new YifangyunError("Download exceeded its reserved temporary storage capacity.", {
            code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
            details: { reserved_bytes: reservation.bytes },
            phase: "temp_storage"
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
      await reservation.release();
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

  async uploadLocalFileToPresignedUrl(presignUrl: string, source: FileHandle, fileName: string, signal?: AbortSignal): Promise<UploadDeliveryResult> {
    await this.validateTransferUrl(presignUrl);
    const stat = await source.stat();
    if (!stat.isFile()) {
      throw new YifangyunError("local_path must point to a file.", { code: "YFY_UPLOAD_SOURCE_INVALID", phase: "upload_source" });
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
      body: source.createReadStream({ autoClose: false, start: 0 }) as unknown as RequestInit["body"],
      duplex: "half",
      signal
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
      const fileBuffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < fileBuffer.length) {
        if (signal?.aborted) throw signal.reason;
        const read = await source.read(fileBuffer, offset, fileBuffer.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      const form = new FormData();
      form.append("file", new Blob([fileBuffer.subarray(0, offset)]), fileName);
      response = await this.fetchTransfer(presignUrl, {
        method: "POST",
        body: form,
        signal
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
      remoteStatusCode: response.status,
      sizeBytes: stat.size
    };
  }

  private async getToken(request: ApiTokenRequest, signal?: AbortSignal): Promise<string> {
    const cacheKey = `${request.subjectType}:${String(request.subjectId)}`;
    const cached = this.tokenCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAtMs - this.config.tokenRefreshSkewSeconds * 1000 > now) {
      return cached.accessToken;
    }

    let inflight = this.tokenInflight.get(cacheKey);
    if (!inflight) {
      inflight = this.requestToken(request).then((token) => {
        this.tokenCache.set(cacheKey, token);
        return token;
      }).finally(() => {
        if (this.tokenInflight.get(cacheKey) === inflight) this.tokenInflight.delete(cacheKey);
      });
      this.tokenInflight.set(cacheKey, inflight);
    }
    return (await waitForSignal(inflight, signal)).accessToken;
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

  private async rawRequest(url: string, init: RequestInit, options: { retry: boolean; signal?: AbortSignal; timeoutMs?: number; transfer?: boolean }): Promise<RawRequestResult> {
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
      const bucketKey = this.requestBucket(url, init);
      let bucket = this.bucketSemaphores.get(bucketKey);
      if (!bucket) {
        bucket = new Semaphore(Math.max(1, this.config.maxConcurrentRequestsPerIdentity ?? 2));
        this.bucketSemaphores.set(bucketKey, bucket);
      }
      let releaseBucket: () => void;
      try {
        releaseBucket = await bucket.acquire(controller.signal);
      } catch (error) {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancelFromCaller);
        throw error;
      }
      let release: () => void;
      try {
        release = await this.requestSemaphore.acquire(controller.signal);
      } catch (error) {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", cancelFromCaller);
        releaseBucket();
        throw error;
      }
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
        const response = options.transfer
          ? await this.fetchTransfer(url, { ...init, signal: controller.signal })
          : await fetch(url, { ...init, signal: controller.signal });
        metrics.observe("provider_request_latency_ms", Date.now() - attemptStartedAt, { endpoint: new URL(url).pathname, status: String(response.status) });
        if (!response.ok && (response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          metrics.increment("provider_retry_total", { reason: response.status === 429 ? "rate_limit" : "server_error" });
          const delayMs = this.calculateRetryDelay(response.headers, attempt);
          await response.body?.cancel().catch(() => undefined);
          cleanup();
          await sleep(delayMs, options.signal);
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
        if (error instanceof YifangyunError) {
          cleanup();
          throw error;
        }
        metrics.observe("provider_request_latency_ms", Date.now() - attemptStartedAt, { endpoint: new URL(url).pathname, status: "network_error" });
        cleanup();
        lastError = error;
        const aborted = controller.signal.aborted;
        if (!aborted && attempt + 1 < attempts) {
          metrics.increment("provider_retry_total", { reason: "network_error" });
          await sleep(this.config.retryBaseDelayMs * Math.pow(2, attempt), options.signal);
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
      message = "Authentication failed. Check client credentials, enterprise id, access context, and OAuth base URL.";
    } else if (response.status === 403) {
      message = "Permission denied. Use an access context that can read the requested cloud-drive resource.";
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

  private async reserveTempCapacity(contentLength: number | undefined, signal?: AbortSignal): Promise<{ bytes: number; release: () => Promise<void> }> {
    const releaseLock = await this.tempCapacitySemaphore.acquire(signal);
    const reservationBytes = contentLength ?? this.config.maxDownloadBytes;
    try {
      await this.pruneExpiredTempFiles();
      const maxTempBytes = this.config.maxTempBytes ?? 1073741824;
      const usedBytes = await this.directoryFileBytes(path.join(this.config.tempDir, "artifacts"));
      if (usedBytes + this.reservedTempBytes + reservationBytes > maxTempBytes) {
        throw new YifangyunError("Local temporary storage quota would be exceeded.", {
          code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
          details: { incoming_bytes: reservationBytes, max_temp_bytes: maxTempBytes, reserved_bytes: this.reservedTempBytes, used_bytes: usedBytes },
          phase: "temp_storage"
        });
      }
      this.reservedTempBytes += reservationBytes;
    } finally {
      releaseLock();
    }
    let released = false;
    return {
      bytes: reservationBytes,
      release: async () => {
        if (released) return;
        const release = await this.tempCapacitySemaphore.acquire();
        try {
          if (released) return;
          released = true;
          this.reservedTempBytes = Math.max(0, this.reservedTempBytes - reservationBytes);
        } finally {
          release();
        }
      }
    };
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
    await this.pruneDirectory(path.join(this.config.tempDir, "artifacts"), cutoffMs);
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
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      let currentUrl = url;
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        await this.validateTransferUrl(currentUrl);
        let response: Response;
        try {
          response = await this.transferFetch(currentUrl, {
            ...init,
            redirect: "manual",
            signal,
            dispatcher: this.transferDispatcher
          } as RequestInit & { dispatcher: Agent });
        } catch (error) {
          if (this.errorChainHasCode(error, "YFY_TRANSFER_URL_PRIVATE_ADDRESS")) {
            throw new YifangyunError("Provider transfer URL resolves to a private network address.", {
              code: "YFY_TRANSFER_URL_PRIVATE_ADDRESS",
              phase: "transfer_url_validation",
              suggestedAction: "Set YFY_ALLOW_PRIVATE_TRANSFER_URLS=enabled only for a trusted private deployment."
            });
          }
          throw error;
        }
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new YifangyunError("Provider transfer redirect did not include a Location header.", { code: "YFY_TRANSFER_REDIRECT_INVALID", phase: "transfer_url_validation" });
        }
        const method = String(init.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          throw new YifangyunError("Provider upload redirect was rejected to avoid replaying credentials or request bodies.", { code: "YFY_TRANSFER_REDIRECT_REJECTED", phase: "transfer_url_validation" });
        }
        currentUrl = new URL(location, currentUrl).toString();
      }
      throw new YifangyunError("Provider transfer URL exceeded the redirect limit.", { code: "YFY_TRANSFER_REDIRECT_LIMIT", phase: "transfer_url_validation" });
    } finally {
      clearTimeout(timeout);
    }
  }

  private errorChainHasCode(error: unknown, code: string): boolean {
    let current = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
      if ("code" in current && current.code === code) return true;
      current = "cause" in current ? current.cause : undefined;
    }
    return false;
  }

  private requestBucket(url: string, init: RequestInit): string {
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization") ?? "anonymous";
    const identity = crypto.createHash("sha256").update(authorization).digest("hex").slice(0, 16);
    const pathname = new URL(url).pathname.split("/").slice(0, 5).join("/");
    return `${identity}:${pathname}`;
  }
}
