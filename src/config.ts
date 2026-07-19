import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { assertProfilesReady } from "./capabilities.js";
import type { AccessContext, AppConfig, AuthorityScope, Toolset, WorkflowProfile } from "./types.js";

const PUBLIC_BASE_URL = "https://open.fangcloud.com";
const PUBLIC_API_BASE_URL = `${PUBLIC_BASE_URL}/api`;
const ToolsetSchema = z.enum(["drive", "workspace", "inventory", "organization", "collaboration", "mutation", "admin", "transfer"]);
const WorkflowProfileSchema = z.enum(["tender"]);
const AccessContextSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  user_id: z.string().trim().regex(/^\d+$/),
  external_enterprise_id: z.string().trim().regex(/^\d+$/).optional()
});
const AuthorityScopeSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  root_folder_id: z.string().trim().regex(/^\d+$/),
  access_context: z.string().trim().min(1).default("default"),
  tags: z.array(z.string().trim().min(1)).default([])
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
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

function parseCsv(name: string): string[] | undefined {
  const raw = optionalEnv(name);
  return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : undefined;
}

function parseJsonArray<T>(name: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = optionalEnv(name);
  if (!raw) {
    return fallback;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.replace(/\/+$/, ""));
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${name} must use HTTPS unless it points to localhost.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain URL userinfo credentials.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function validateStagedPublicBase(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must be a valid URL.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must use HTTP or HTTPS.");
  if (parsed.username || parsed.password) throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must not contain URL userinfo credentials.");
  if (parsed.search || parsed.hash) throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must not contain a query string or fragment.");
  if (["0.0.0.0", "::", "[::]"].includes(parsed.hostname)) throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must not use a wildcard address.");
  if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL must use HTTPS unless it points to localhost.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function apiBaseUrl(): string {
  return validateUrl("YFY_API_BASE_URL", optionalEnv("YFY_API_BASE_URL") ?? PUBLIC_API_BASE_URL);
}

function parseAccessContexts(defaultUserId: string): AccessContext[] {
  const configured = parseJsonArray("YFY_ACCESS_CONTEXTS_JSON", z.array(AccessContextSchema), []);
  const contexts: AccessContext[] = [{ id: "default", userId: defaultUserId }, ...configured.map((value) => ({
    id: value.id,
    userId: value.user_id,
    ...(value.external_enterprise_id ? { externalEnterpriseId: value.external_enterprise_id } : {})
  }))];
  const ids = new Set<string>();
  for (const context of contexts) {
    if (ids.has(context.id)) {
      throw new Error(`Duplicate access context id: ${context.id}`);
    }
    ids.add(context.id);
  }
  return contexts;
}

function parseScopes(contexts: AccessContext[]): AuthorityScope[] {
  const configured = parseJsonArray("YFY_WORKSPACES_JSON", z.array(AuthorityScopeSchema), []);
  const contextIds = new Set(contexts.map((context) => context.id));
  const scopes: AuthorityScope[] = configured.map((value) => ({
    id: value.id,
    rootFolderId: value.root_folder_id,
    accessContext: value.access_context ?? "default",
    tags: value.tags ?? []
  }));
  const scopeIds = new Set<string>();
  for (const scope of scopes) {
    if (scopeIds.has(scope.id)) {
      throw new Error(`Duplicate workspace id: ${scope.id}`);
    }
    scopeIds.add(scope.id);
    if (!contextIds.has(scope.accessContext)) {
      throw new Error(`Workspace ${scope.id} references unknown access context ${scope.accessContext}.`);
    }
  }
  return scopes;
}

export function loadConfig(): AppConfig {
  const defaultUserId = requireEnv("YFY_DEFAULT_USER_ID");
  if (!/^\d+$/.test(defaultUserId)) {
    throw new Error("YFY_DEFAULT_USER_ID must contain digits only.");
  }
  const enterpriseId = requireEnv("YFY_ENTERPRISE_ID");
  if (!/^\d+$/.test(enterpriseId)) {
    throw new Error("YFY_ENTERPRISE_ID must contain digits only.");
  }
  const accessContexts = parseAccessContexts(defaultUserId);
  const toolsets = (parseCsv("YFY_TOOLSETS") ?? ["drive"])
    .map((value) => ToolsetSchema.parse(value)) as Toolset[];
  const tempDir = path.resolve(optionalEnv("YFY_TEMP_DIR") ?? path.join(os.tmpdir(), "yifangyun-mcp"));
  const stateDatabasePath = path.resolve(optionalEnv("YFY_STATE_DB") ?? path.join(tempDir, "state.sqlite"));
  const artifactRoot = path.resolve(tempDir, "artifacts");
  const downloadRoot = path.resolve(tempDir, "downloads");
  for (const managedRoot of [artifactRoot, downloadRoot]) {
    const relative = path.relative(managedRoot, stateDatabasePath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("YFY_STATE_DB must not be located inside YFY_TEMP_DIR/artifacts or YFY_TEMP_DIR/downloads.");
    }
  }
  const transport = optionalEnv("YFY_TRANSPORT") ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("YFY_TRANSPORT must be stdio or http.");
  }
  const defaultAccessContext = optionalEnv("YFY_DEFAULT_ACCESS_CONTEXT") ?? "default";
  if (!accessContexts.some((context) => context.id === defaultAccessContext)) {
    throw new Error(`YFY_DEFAULT_ACCESS_CONTEXT references unknown context ${defaultAccessContext}.`);
  }
  const snapshotConcurrency = parsePositiveInt("YFY_INVENTORY_CONCURRENCY", 2);
  if (snapshotConcurrency > 8) {
    throw new Error("YFY_INVENTORY_CONCURRENCY must be between 1 and 8.");
  }
  const maxDownloadBytes = parsePositiveInt("YFY_MAX_DOWNLOAD_BYTES", 268435456);
  const logLevel = z.enum(["debug", "info", "warn", "error"]).parse(optionalEnv("YFY_LOG_LEVEL") ?? "info");
  const downloadExposeLocalPath = parseEnabled("YFY_DOWNLOAD_EXPOSE_LOCAL_PATH", transport === "stdio");
  const downloadStagedHttpEnabled = parseEnabled("YFY_DOWNLOAD_STAGED_HTTP", transport === "http");
  const stagedPublicBaseRaw = optionalEnv("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL");
  if (transport === "stdio" && downloadStagedHttpEnabled) throw new Error("YFY_DOWNLOAD_STAGED_HTTP is only supported with YFY_TRANSPORT=http.");
  if (transport === "stdio" && !downloadExposeLocalPath) throw new Error("stdio download delivery requires YFY_DOWNLOAD_EXPOSE_LOCAL_PATH=enabled.");
  if (transport === "http" && !downloadExposeLocalPath && !downloadStagedHttpEnabled) throw new Error("HTTP download delivery requires local_path or staged HTTP to be enabled.");
  if (stagedPublicBaseRaw && (transport !== "http" || !downloadStagedHttpEnabled)) {
    throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL requires HTTP transport with staged downloads enabled.");
  }
  const httpHost = optionalEnv("YFY_HTTP_HOST") ?? "127.0.0.1";
  if (transport === "http" && downloadStagedHttpEnabled && !stagedPublicBaseRaw && !isLoopbackHostname(httpHost)) {
    throw new Error("YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL is required when HTTP staged downloads bind to a non-loopback address.");
  }
  const textPreviewMaxBytes = parsePositiveInt("YFY_TEXT_PREVIEW_MAX_BYTES", 32768);
  if (textPreviewMaxBytes > 1_048_576) throw new Error("YFY_TEXT_PREVIEW_MAX_BYTES must not exceed 1048576.");
  const maxConcurrentProviderRequests = parsePositiveInt("YFY_MAX_CONCURRENT_PROVIDER_REQUESTS", 40);
  const maxConcurrentRequestsPerIdentity = parsePositiveInt("YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY", 20);
  if (maxConcurrentProviderRequests > 40 || maxConcurrentRequestsPerIdentity > 40) throw new Error("Provider request concurrency must not exceed 40.");
  if (maxConcurrentRequestsPerIdentity > maxConcurrentProviderRequests) throw new Error("YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY must not exceed YFY_MAX_CONCURRENT_PROVIDER_REQUESTS.");
  const downloadStagedMaxConcurrentReads = parsePositiveInt("YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS", 20);
  if (downloadStagedMaxConcurrentReads > 40) throw new Error("YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS must not exceed 40.");

  const workflowProfiles = (parseCsv("YFY_WORKFLOW_PROFILES") ?? []).map((value) => WorkflowProfileSchema.parse(value)) as WorkflowProfile[];
  const config: AppConfig = {
    accessContexts,
    apiBaseUrl: apiBaseUrl(),
    authorityScopes: parseScopes(accessContexts),
    oauthBaseUrl: validateUrl("YFY_OAUTH_BASE_URL", optionalEnv("YFY_OAUTH_BASE_URL") ?? PUBLIC_BASE_URL),
    clientId: requireEnv("YFY_CLIENT_ID"),
    clientSecret: requireEnv("YFY_CLIENT_SECRET"),
    defaultAccessContext,
    defaultUserId,
    enterpriseId,
    logLevel,
    allowPrivateTransferUrls: parseEnabled("YFY_ALLOW_PRIVATE_TRANSFER_URLS", false),
    downloadIdleTimeoutMs: parsePositiveInt("YFY_DOWNLOAD_IDLE_TIMEOUT_MS", 30000),
    downloadWallTimeoutMs: parsePositiveInt("YFY_DOWNLOAD_WALL_TIMEOUT_MS", 300000),
    httpAllowedHosts: parseCsv("YFY_HTTP_ALLOWED_HOSTS"),
    httpAllowedOrigins: parseCsv("YFY_HTTP_ALLOWED_ORIGINS"),
    httpBearerToken: optionalEnv("YFY_HTTP_BEARER_TOKEN"),
    httpHost,
    httpMaxSessions: parsePositiveInt("YFY_HTTP_MAX_SESSIONS", 100),
    httpPort: parsePositiveInt("YFY_HTTP_PORT", 3000),
    httpSessionIdleSeconds: parsePositiveInt("YFY_HTTP_SESSION_IDLE_SECONDS", 1800),
    maxConcurrentProviderRequests,
    maxConcurrentRequestsPerIdentity,
    maxDownloadBytes,
    maxPageCapacity: parsePositiveInt("YFY_MAX_PAGE_CAPACITY", 500),
    maxRetryDelayMs: parsePositiveInt("YFY_MAX_RETRY_DELAY_MS", 30000),
    maxStateBytes: parsePositiveInt("YFY_MAX_STATE_BYTES", 2147483648),
    maxTempBytes: parsePositiveInt("YFY_MAX_TEMP_BYTES", 1073741824),
    requestTimeoutMs: parsePositiveInt("YFY_REQUEST_TIMEOUT_MS", 30000),
    retryBaseDelayMs: parsePositiveInt("YFY_RETRY_BASE_DELAY_MS", 500),
    retryMaxAttempts: parsePositiveInt("YFY_RETRY_MAX_ATTEMPTS", 3),
    snapshotConcurrency,
    snapshotTtlSeconds: parsePositiveInt("YFY_INVENTORY_TTL_SECONDS", 604800),
    stateDatabasePath,
    tempDir,
    tempFileTtlSeconds: parsePositiveInt("YFY_TEMP_FILE_TTL_SECONDS", 86400),
    textPreviewMaxBytes,
    downloadExposeLocalPath,
    downloadStagedHttpEnabled,
    downloadStagedMaxConcurrentReads,
    downloadStagedMaxFetches: parsePositiveInt("YFY_DOWNLOAD_STAGED_MAX_FETCHES", 10),
    ...(stagedPublicBaseRaw
      ? { downloadStagedPublicBaseUrl: validateStagedPublicBase(stagedPublicBaseRaw) }
      : {}),
    tokenRefreshSkewSeconds: parsePositiveInt("YFY_TOKEN_REFRESH_SKEW_SECONDS", 300),
    toolsets: [...new Set(toolsets)],
    transport,
    ...(optionalEnv("YFY_UPLOAD_ROOT_DIR") ? { uploadRootDir: path.resolve(optionalEnv("YFY_UPLOAD_ROOT_DIR")!) } : {}),
    workflowProfiles
  };
  assertProfilesReady(config);
  return config;
}

export function getConfigSummary(config: AppConfig): Record<string, string | number | boolean | string[]> {
  return {
    configuration_source: "process_environment",
    access_contexts: config.accessContexts.map((context) => context.id),
    api_base_url: config.apiBaseUrl,
    workspaces: config.authorityScopes.map((scope) => scope.id),
    default_access_context: config.defaultAccessContext,
    max_download_bytes: config.maxDownloadBytes,
    download_local_path_enabled: config.downloadExposeLocalPath ?? false,
    download_staged_http_enabled: config.downloadStagedHttpEnabled ?? false,
    download_staged_max_concurrent_reads: config.downloadStagedMaxConcurrentReads ?? 20,
    download_staged_max_fetches: config.downloadStagedMaxFetches ?? 10,
    download_staged_public_base_configured: Boolean(config.downloadStagedPublicBaseUrl),
    download_ttl_seconds: config.tempFileTtlSeconds,
    max_page_capacity: config.maxPageCapacity,
    max_state_bytes: config.maxStateBytes ?? 2147483648,
    max_temp_bytes: config.maxTempBytes ?? 1073741824,
    oauth_base_url: config.oauthBaseUrl,
    inventory_ttl_seconds: config.snapshotTtlSeconds ?? 604800,
    inventory_concurrency: config.snapshotConcurrency ?? 2,
    text_preview_max_bytes: config.textPreviewMaxBytes ?? 32768,
    toolsets: config.toolsets,
    transport: config.transport ?? "stdio",
    workflow_profiles: config.workflowProfiles
  };
}
