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

  return {
    apiBaseUrl: normalizeApiBaseUrl(),
    oauthBaseUrl: validateUrl("YFY_OAUTH_BASE_URL", trimTrailingSlash(optionalEnv("YFY_OAUTH_BASE_URL") ?? PUBLIC_BASE_URL)),
    clientId: requireEnv("YFY_CLIENT_ID"),
    clientSecret: requireEnv("YFY_CLIENT_SECRET"),
    enterpriseId: parseId("YFY_ENTERPRISE_ID", requireEnv("YFY_ENTERPRISE_ID")),
    defaultUserId: parseId("YFY_DEFAULT_USER_ID", requireEnv("YFY_DEFAULT_USER_ID")),
    adminUserId,
    fileAccessUserStrategy,
    requestTimeoutMs: parsePositiveInt("YFY_REQUEST_TIMEOUT_MS", 30000),
    tokenRefreshSkewSeconds: parsePositiveInt("YFY_TOKEN_REFRESH_SKEW_SECONDS", 300),
    maxPageCapacity: parsePositiveInt("YFY_MAX_PAGE_CAPACITY", 500),
    allowDownloadUrl: parseEnabled("YFY_ALLOW_DOWNLOAD_URL", true),
    logLevel: optionalEnv("YFY_LOG_LEVEL") ?? "info"
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
    max_page_capacity: config.maxPageCapacity,
    allow_download_url: config.allowDownloadUrl
  };
}
