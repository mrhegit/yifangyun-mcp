export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type IdLike = string | number;

export type TokenSubjectType = "enterprise" | "user";

export type Toolset = "core" | "authority" | "snapshot" | "evidence" | "organization" | "collaboration" | "mutation" | "admin" | "transfer";
export type WorkflowProfile = "tender";

export interface AccessContext {
  externalEnterpriseId?: string;
  id: string;
  userId: string;
}

export interface AuthorityScope {
  accessContext: string;
  id: string;
  rootFolderId: string;
  tags: string[];
}

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
  remoteStatusCode: number;
  sizeBytes: number;
}

export interface AppConfig {
  accessContexts: AccessContext[];
  apiBaseUrl: string;
  authorityScopes: AuthorityScope[];
  oauthBaseUrl: string;
  clientId: string;
  clientSecret: string;
  defaultAccessContext: string;
  defaultUserId: string;
  enterpriseId: string;
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
  downloadIdleTimeoutMs?: number;
  downloadWallTimeoutMs?: number;
  httpAllowedHosts?: string[];
  httpAllowedOrigins?: string[];
  httpBearerToken?: string;
  httpHost?: string;
  httpMaxSessions?: number;
  httpPort?: number;
  httpSessionIdleSeconds?: number;
  maxConcurrentProviderRequests?: number;
  maxConcurrentRequestsPerIdentity?: number;
  maxEvidenceResourceBytes?: number;
  maxRetryDelayMs?: number;
  maxStateBytes?: number;
  maxTempBytes?: number;
  snapshotConcurrency?: number;
  snapshotTtlSeconds?: number;
  stateDatabasePath: string;
  toolsets: Toolset[];
  transport?: "stdio" | "http";
  uploadRootDir?: string;
  workflowProfiles: WorkflowProfile[];
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
  error?: JsonObject;
  provenance?: JsonObject;
  warnings?: string[];
}
