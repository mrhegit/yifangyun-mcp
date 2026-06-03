export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type IdLike = string | number;

export type TokenSubjectType = "enterprise" | "user";

export type FileAccessUserStrategy = "default" | "admin" | "explicit";

export interface AppConfig {
  apiBaseUrl: string;
  oauthBaseUrl: string;
  clientId: string;
  clientSecret: string;
  enterpriseId: IdLike;
  defaultUserId: IdLike;
  adminUserId?: IdLike;
  fileAccessUserStrategy: FileAccessUserStrategy;
  requestTimeoutMs: number;
  tokenRefreshSkewSeconds: number;
  maxPageCapacity: number;
  allowDownloadUrl: boolean;
  logLevel: string;
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
  ok: boolean;
  data?: JsonValue;
  error?: JsonObject;
}
