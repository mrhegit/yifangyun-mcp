import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const REQUIRED_KEYS = [
  "YFY_CLIENT_ID",
  "YFY_CLIENT_SECRET",
  "YFY_ENTERPRISE_ID",
  "YFY_DEFAULT_USER_ID",
  "YFY_OPENAPI_BASE_URL",
  "YFY_OAUTH_BASE_URL",
  "YFY_API_BASE_URL",
  "YFY_ADMIN_USER_ID",
  "YFY_FILE_ACCESS_USER_STRATEGY",
  "YFY_ALLOW_DOWNLOAD_URL",
  "YFY_ENABLE_MUTATION_TOOLS",
  "YFY_ENABLE_ADMIN_TOOLS",
  "YFY_ENABLE_RAW_RESPONSE",
  "YFY_MAX_DOWNLOAD_BYTES",
  "YFY_TEMP_DIR",
  "YFY_TEMP_FILE_TTL_SECONDS",
  "YFY_RETRY_MAX_ATTEMPTS",
  "YFY_RETRY_BASE_DELAY_MS",
  "YFY_MAX_RETRY_DELAY_MS",
  "YFY_MAX_CONCURRENT_PROVIDER_REQUESTS",
  "YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY",
  "YFY_DOWNLOAD_IDLE_TIMEOUT_MS",
  "YFY_DOWNLOAD_WALL_TIMEOUT_MS",
  "YFY_MAX_TEMP_BYTES",
  "YFY_SCAN_DIR",
  "YFY_SCAN_TTL_SECONDS",
  "YFY_MAX_SCAN_BYTES",
  "YFY_AUTHORITY_ROOT_FOLDER_ID",
  "YFY_ALLOW_PRIVATE_TRANSFER_URLS",
  "YFY_TRANSPORT",
  "YFY_HTTP_HOST",
  "YFY_HTTP_PORT",
  "YFY_HTTP_BEARER_TOKEN",
  "YFY_HTTP_ALLOWED_HOSTS",
  "YFY_HTTP_ALLOWED_ORIGINS"
];

function setBaseEnv(): void {
  for (const key of REQUIRED_KEYS) {
    delete process.env[key];
  }
  process.env.YFY_CLIENT_ID = "client-id";
  process.env.YFY_CLIENT_SECRET = "client-secret";
  process.env.YFY_ENTERPRISE_ID = "115";
  process.env.YFY_DEFAULT_USER_ID = "530";
}

test("loadConfig uses secure and disabled defaults for new capability flags", () => {
  setBaseEnv();
  const config = loadConfig();
  assert.equal(config.allowDownloadUrl, false);
  assert.equal(config.enableMutationTools, false);
  assert.equal(config.enableAdminTools, false);
  assert.equal(config.enableRawResponse, false);
  assert.equal(config.retryMaxAttempts, 3);
  assert.equal(config.retryBaseDelayMs, 500);
  assert.equal(config.maxDownloadBytes, 268435456);
  assert.equal(config.maxTempBytes, 1073741824);
  assert.equal(config.maxConcurrentProviderRequests, 4);
  assert.equal(config.maxConcurrentRequestsPerIdentity, 2);
  assert.equal(config.downloadIdleTimeoutMs, 30000);
  assert.equal(config.downloadWallTimeoutMs, 300000);
  assert.equal(config.scanTtlSeconds, 604800);
  assert.equal(config.maxScanBytes, 2147483648);
  assert.equal(config.transport, "stdio");
  assert.equal(config.tempFileTtlSeconds, 86400);
  assert.match(config.tempDir, /yifangyun-mcp/i);
});

test("loadConfig rejects admin file strategy without admin user id", () => {
  setBaseEnv();
  process.env.YFY_FILE_ACCESS_USER_STRATEGY = "admin";
  assert.throws(() => loadConfig(), /YFY_ADMIN_USER_ID is required/);
});
