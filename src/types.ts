export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type IdLike = string | number;

export type TokenSubjectType = "enterprise" | "user";

export type FileAccessUserStrategy = "default" | "admin" | "explicit";

export interface RateLimitMeta {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface ApiResponseMeta {
  endpoint: string;
  fetchedAtIso: string;
  fetchedAtUnix: number;
  requestId?: string;
  sourceApiVersion: string;
  statusCode: number;
  rateLimit?: RateLimitMeta;
}

export interface ApiJsonResponse {
  data: JsonValue;
  meta: ApiResponseMeta;
}

export interface DownloadedFile {
  contentType?: string;
  detectedContentType?: string;
  fileName: string;
  meta: ApiResponseMeta;
  sha1: string;
  sha256: string;
  sizeBytes: number;
  tempPath: string;
}

export interface UploadDeliveryResult {
  deliveryMethod: string;
  fileName: string;
  localPath: string;
  remoteStatusCode: number;
  sizeBytes: number;
}

export interface AppConfig {
  apiBaseUrl: string;
  allowDownloadUrl: boolean;
  adminUserId?: IdLike;
  oauthBaseUrl: string;
  clientId: string;
  clientSecret: string;
  enterpriseId: IdLike;
  defaultUserId: IdLike;
  enableAdminTools: boolean;
  enableMutationTools: boolean;
  enableRawResponse: boolean;
  fileAccessUserStrategy: FileAccessUserStrategy;
  logLevel: string;
  maxDownloadBytes: number;
  maxPageCapacity: number;
  requestTimeoutMs: number;
  retryBaseDelayMs: number;
  retryMaxAttempts: number;
  tempDir: string;
  tempFileTtlSeconds: number;
  tokenRefreshSkewSeconds: number;
  allowPrivateTransferUrls?: boolean;
  authorityRootFolderId?: IdLike;
  downloadIdleTimeoutMs?: number;
  downloadWallTimeoutMs?: number;
  httpAllowedHosts?: string[];
  httpAllowedOrigins?: string[];
  httpBearerToken?: string;
  httpHost?: string;
  httpPort?: number;
  maxConcurrentProviderRequests?: number;
  maxConcurrentRequestsPerIdentity?: number;
  maxRetryDelayMs?: number;
  maxScanBytes?: number;
  maxTempBytes?: number;
  scanDir?: string;
  scanTtlSeconds?: number;
  transport?: "stdio" | "http";
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface TokenRecord {
  accessToken: string;
  expiresAtMs: number;
}

export interface ToolOutput extends Record<string, unknown> {
  meta?: JsonObject;
  ok: boolean;
  outcome?: string;
  request_succeeded?: boolean;
  server_version?: string;
  data?: JsonValue;
  error?: JsonObject;
  raw?: JsonValue;
  warnings?: string[];
}
