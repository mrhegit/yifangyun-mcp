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
  "YFY_RETRY_BASE_DELAY_MS"
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
  assert.equal(config.tempFileTtlSeconds, 86400);
  assert.match(config.tempDir, /yifangyun-mcp/i);
});

test("loadConfig rejects admin file strategy without admin user id", () => {
  setBaseEnv();
  process.env.YFY_FILE_ACCESS_USER_STRATEGY = "admin";
  assert.throws(() => loadConfig(), /YFY_ADMIN_USER_ID is required/);
});
