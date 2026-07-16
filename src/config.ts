import os from "node:os";
import path from "node:path";
import type { AppConfig, FileAccessUserStrategy, IdLike } from "./types.js";

const PUBLIC_BASE_URL = "https://open.fangcloud.com";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseCsv(name: string): string[] | undefined {
  const raw = optionalEnv(name);
  if (!raw) {
    return undefined;
  }
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function parseId(name: string, value: string): IdLike {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric id.`);
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
}

function parsePositiveInt(name: string, defaultValue: number): number {
  const raw = optionalEnv(name);
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseNonNegativeInt(name: string, defaultValue: number): number {
  const raw = optionalEnv(name);
  if (!raw) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function parseEnabled(name: string, defaultValue: boolean): boolean {
  const raw = optionalEnv(name);
  if (!raw) {
    return defaultValue;
  }
  if (["enabled", "true", "1", "yes"].includes(raw.toLowerCase())) {
    return true;
  }
  if (["disabled", "false", "0", "no"].includes(raw.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be enabled or disabled.`);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeApiBaseUrl(): string {
  const apiBase = optionalEnv("YFY_API_BASE_URL");
  if (apiBase) {
    return validateUrl("YFY_API_BASE_URL", trimTrailingSlash(apiBase));
  }

  const openapiBase = validateUrl("YFY_OPENAPI_BASE_URL", trimTrailingSlash(optionalEnv("YFY_OPENAPI_BASE_URL") ?? PUBLIC_BASE_URL));
  return openapiBase.endsWith("/api") ? openapiBase : `${openapiBase}/api`;
}

function validateUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`${name} must use HTTPS unless it points to localhost.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain URL userinfo credentials.`);
  }
  return value;
}

function parseStrategy(): FileAccessUserStrategy {
  const value = optionalEnv("YFY_FILE_ACCESS_USER_STRATEGY") ?? "default";
  if (value === "default" || value === "admin" || value === "explicit") {
    return value;
  }
  throw new Error("YFY_FILE_ACCESS_USER_STRATEGY must be default, admin, or explicit.");
}

export function loadConfig(): AppConfig {
  const adminUserIdRaw = optionalEnv("YFY_ADMIN_USER_ID");
  const fileAccessUserStrategy = parseStrategy();
  const adminUserId = adminUserIdRaw ? parseId("YFY_ADMIN_USER_ID", adminUserIdRaw) : undefined;

  if (fileAccessUserStrategy === "admin" && adminUserId === undefined) {
    throw new Error("YFY_ADMIN_USER_ID is required when YFY_FILE_ACCESS_USER_STRATEGY=admin.");
  }

  const tempDir = path.resolve(optionalEnv("YFY_TEMP_DIR") ?? path.join(os.tmpdir(), "yifangyun-mcp"));
  const authorityRootFolderIdRaw = optionalEnv("YFY_AUTHORITY_ROOT_FOLDER_ID");
  const transport = optionalEnv("YFY_TRANSPORT") ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("YFY_TRANSPORT must be stdio or http.");
  }

  return {
    apiBaseUrl: normalizeApiBaseUrl(),
    allowDownloadUrl: parseEnabled("YFY_ALLOW_DOWNLOAD_URL", false),
    adminUserId,
    oauthBaseUrl: validateUrl("YFY_OAUTH_BASE_URL", trimTrailingSlash(optionalEnv("YFY_OAUTH_BASE_URL") ?? PUBLIC_BASE_URL)),
    clientId: requireEnv("YFY_CLIENT_ID"),
    clientSecret: requireEnv("YFY_CLIENT_SECRET"),
    enterpriseId: parseId("YFY_ENTERPRISE_ID", requireEnv("YFY_ENTERPRISE_ID")),
    defaultUserId: parseId("YFY_DEFAULT_USER_ID", requireEnv("YFY_DEFAULT_USER_ID")),
    enableAdminTools: parseEnabled("YFY_ENABLE_ADMIN_TOOLS", false),
    enableMutationTools: parseEnabled("YFY_ENABLE_MUTATION_TOOLS", false),
    enableRawResponse: parseEnabled("YFY_ENABLE_RAW_RESPONSE", false),
    fileAccessUserStrategy,
    logLevel: optionalEnv("YFY_LOG_LEVEL") ?? "info",
    allowPrivateTransferUrls: parseEnabled("YFY_ALLOW_PRIVATE_TRANSFER_URLS", false),
    authorityRootFolderId: authorityRootFolderIdRaw ? parseId("YFY_AUTHORITY_ROOT_FOLDER_ID", authorityRootFolderIdRaw) : undefined,
    downloadIdleTimeoutMs: parsePositiveInt("YFY_DOWNLOAD_IDLE_TIMEOUT_MS", 30000),
    downloadWallTimeoutMs: parsePositiveInt("YFY_DOWNLOAD_WALL_TIMEOUT_MS", 300000),
    httpAllowedHosts: parseCsv("YFY_HTTP_ALLOWED_HOSTS"),
    httpAllowedOrigins: parseCsv("YFY_HTTP_ALLOWED_ORIGINS"),
    httpBearerToken: optionalEnv("YFY_HTTP_BEARER_TOKEN"),
    httpHost: optionalEnv("YFY_HTTP_HOST") ?? "127.0.0.1",
    httpPort: parsePositiveInt("YFY_HTTP_PORT", 3000),
    maxConcurrentProviderRequests: parsePositiveInt("YFY_MAX_CONCURRENT_PROVIDER_REQUESTS", 4),
    maxConcurrentRequestsPerIdentity: parsePositiveInt("YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY", 2),
    maxDownloadBytes: parsePositiveInt("YFY_MAX_DOWNLOAD_BYTES", 268435456),
    maxPageCapacity: parsePositiveInt("YFY_MAX_PAGE_CAPACITY", 500),
    maxRetryDelayMs: parsePositiveInt("YFY_MAX_RETRY_DELAY_MS", 30000),
    maxScanBytes: parsePositiveInt("YFY_MAX_SCAN_BYTES", 2147483648),
    maxTempBytes: parsePositiveInt("YFY_MAX_TEMP_BYTES", 1073741824),
    requestTimeoutMs: parsePositiveInt("YFY_REQUEST_TIMEOUT_MS", 30000),
    retryBaseDelayMs: parsePositiveInt("YFY_RETRY_BASE_DELAY_MS", 500),
    retryMaxAttempts: parsePositiveInt("YFY_RETRY_MAX_ATTEMPTS", 3),
    scanDir: path.resolve(optionalEnv("YFY_SCAN_DIR") ?? path.join(tempDir, "scans")),
    scanTtlSeconds: parsePositiveInt("YFY_SCAN_TTL_SECONDS", 604800),
    tempDir,
    tempFileTtlSeconds: parseNonNegativeInt("YFY_TEMP_FILE_TTL_SECONDS", 86400),
    tokenRefreshSkewSeconds: parsePositiveInt("YFY_TOKEN_REFRESH_SKEW_SECONDS", 300),
    transport,
  };
}

export function getConfigSummary(config: AppConfig): Record<string, string | number | boolean> {
  return {
    api_base_url: config.apiBaseUrl,
    oauth_base_url: config.oauthBaseUrl,
    enterprise_id: String(config.enterpriseId),
    default_user_id: String(config.defaultUserId),
    admin_user_configured: config.adminUserId !== undefined,
    file_access_user_strategy: config.fileAccessUserStrategy,
    request_timeout_ms: config.requestTimeoutMs,
    retry_max_attempts: config.retryMaxAttempts,
    retry_base_delay_ms: config.retryBaseDelayMs,
    max_page_capacity: config.maxPageCapacity,
    max_download_bytes: config.maxDownloadBytes,
    temp_dir: config.tempDir,
    temp_file_ttl_seconds: config.tempFileTtlSeconds,
    allow_download_url: config.allowDownloadUrl,
    enable_mutation_tools: config.enableMutationTools,
    enable_admin_tools: config.enableAdminTools,
    enable_raw_response: config.enableRawResponse,
    transport: config.transport ?? "stdio",
    scan_dir: config.scanDir ?? path.join(config.tempDir, "scans"),
    scan_ttl_seconds: config.scanTtlSeconds ?? 604800,
    max_concurrent_provider_requests: config.maxConcurrentProviderRequests ?? 4,
    max_concurrent_requests_per_identity: config.maxConcurrentRequestsPerIdentity ?? 2,
    max_scan_bytes: config.maxScanBytes ?? 2147483648,
    authority_root_configured: config.authorityRootFolderId !== undefined,
    http_auth_configured: Boolean(config.httpBearerToken)
  };
}
