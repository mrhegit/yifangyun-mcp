import crypto from "node:crypto";
import type { AppConfig, IdLike, JsonObject, JsonValue, TokenRecord, TokenResponse, TokenSubjectType } from "./types.js";

interface ApiTokenRequest {
  subjectType: TokenSubjectType;
  subjectId: IdLike;
}

export class YifangyunError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly details?: JsonObject;

  constructor(message: string, options: { statusCode?: number; retryable?: boolean; details?: JsonObject } = {}) {
    super(message);
    this.name = "YifangyunError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function getNumber(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const output: JsonObject = {};
    for (const [key, field] of Object.entries(value)) {
      output[key] = toJsonValue(field);
    }
    return output;
  }
  return String(value);
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/g, "Bearer ***redacted***")
    .replace(/(access_token|refresh_token|client_secret|download_url)(['\"\s:=]+)([^'\"\s,}]+)/gi, "$1$2***redacted***")
    .replace(/([?&](?:sign|token|access_token|authorization)=)[^&\s]+/gi, "$1***redacted***");
}

function summarizeText(text: string): string {
  return redactSensitiveText(text.replace(/\s+/g, " ").trim()).slice(0, 300);
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

  async getEnterprise(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<JsonValue> {
    const token = await this.getEnterpriseToken();
    return this.apiGet(path, token, params);
  }

  async getAsUser(path: string, userId?: IdLike, params: Record<string, string | number | boolean | undefined> = {}): Promise<JsonValue> {
    const resolvedUserId = this.resolveFileAccessUser(userId);
    const token = await this.getUserToken(resolvedUserId);
    return this.apiGet(path, token, params);
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

    const data = await this.fetchJson(url.toString(), {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}` }
    });

    if (!isJsonObject(data) || typeof data.access_token !== "string") {
      throw new YifangyunError("OAuth token response did not include access_token.", {
        details: { response_shape: summarizeShape(data) }
      });
    }

    const tokenData = data as unknown as TokenResponse;
    const expiresIn = typeof tokenData.expires_in === "number" && tokenData.expires_in > 0 ? tokenData.expires_in : 21600;
    return {
      accessToken: tokenData.access_token,
      expiresAtMs: Date.now() + expiresIn * 1000
    };
  }

  private async apiGet(path: string, bearerToken: string, params: Record<string, string | number | boolean | undefined>): Promise<JsonValue> {
    const url = new URL(`${this.config.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return this.fetchJson(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });
  }

  private async fetchJson(url: string, init: RequestInit): Promise<JsonValue> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (error) {
        throw this.invalidJsonError(response, text, url, error);
      }
      if (!response.ok) {
        throw this.httpError(response.status, parsed, url);
      }
      return toJsonValue(parsed);
    } catch (error) {
      if (error instanceof YifangyunError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new YifangyunError("Yifangyun request timed out.", { retryable: true });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new YifangyunError(redactSensitiveText(`Yifangyun request failed: ${message}`), { retryable: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  private httpError(statusCode: number, responseBody: unknown, url: string): YifangyunError {
    const path = new URL(url).pathname;
    const retryable = statusCode === 429 || statusCode >= 500;
    const details: JsonObject = {
      status_code: statusCode,
      endpoint: path,
      response_shape: summarizeShape(toJsonValue(responseBody))
    };

    if (statusCode === 401) {
      return new YifangyunError("Authentication failed. Check client credentials, enterprise_id, user_id, and OAuth base URL.", { statusCode, retryable, details });
    }
    if (statusCode === 403) {
      return new YifangyunError("Permission denied. Use a user_id that has access to the requested cloud-drive resource.", { statusCode, retryable, details });
    }
    if (statusCode === 404) {
      return new YifangyunError("Resource not found. Check the department, folder, or file id.", { statusCode, retryable, details });
    }
    return new YifangyunError(`Yifangyun API request failed with HTTP ${statusCode}.`, { statusCode, retryable, details });
  }

  private invalidJsonError(response: Response, text: string, url: string, error: unknown): YifangyunError {
    const parsedUrl = new URL(url);
    const statusCode = response.status;
    const retryable = statusCode === 429 || statusCode >= 500;
    const reason = error instanceof Error ? error.message : String(error);
    return new YifangyunError("Yifangyun response was not valid JSON. Check base URL, reverse proxy, and credentials.", {
      statusCode,
      retryable,
      details: {
        status_code: statusCode,
        endpoint: parsedUrl.pathname,
        content_type: response.headers.get("content-type") ?? "",
        response_preview: summarizeText(text),
        parse_error: redactSensitiveText(reason)
      }
    });
  }
}

function summarizeShape(value: JsonValue): JsonObject {
  if (Array.isArray(value)) {
    return { type: "array", count: value.length };
  }
  if (isJsonObject(value)) {
    const output: JsonObject = { type: "object", keys: Object.keys(value).slice(0, 20) };
    const message = getString(value, "message") ?? getString(value, "error") ?? getString(value, "msg");
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
