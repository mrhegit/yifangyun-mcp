import assert from "node:assert/strict";
import test from "node:test";
import { getConfigSummary, loadConfig } from "./config.js";

const ENV_KEYS = [
  "YFY_CLIENT_ID", "YFY_CLIENT_SECRET", "YFY_ENTERPRISE_ID", "YFY_DEFAULT_USER_ID", "YFY_TOOLSETS", "YFY_ACCESS_CONTEXTS_JSON", "YFY_WORKSPACES_JSON",
  "YFY_API_BASE_URL", "YFY_OAUTH_BASE_URL", "YFY_INVENTORY_CONCURRENCY", "YFY_INVENTORY_TTL_SECONDS", "YFY_STATE_DB", "YFY_TEMP_DIR", "YFY_MAX_DOWNLOAD_BYTES",
  "YFY_MAX_CONCURRENT_PROVIDER_REQUESTS", "YFY_MAX_CONCURRENT_REQUESTS_PER_IDENTITY",
  "YFY_TEMP_FILE_TTL_SECONDS", "YFY_LOG_LEVEL", "YFY_UPLOAD_ROOT_DIR", "YFY_WORKFLOW_PROFILES", "YFY_TRANSPORT", "YFY_HTTP_HOST", "YFY_HTTP_PORT",
  "YFY_DOWNLOAD_EXPOSE_LOCAL_PATH", "YFY_DOWNLOAD_STAGED_HTTP", "YFY_DOWNLOAD_STAGED_MAX_FETCHES", "YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS", "YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL", "YFY_TEXT_PREVIEW_MAX_BYTES",
  "YFY_HTTP_BEARER_TOKEN", "YFY_HTTP_ALLOWED_HOSTS", "YFY_HTTP_ALLOWED_ORIGINS"
] as const;

function withEnv(values: Record<string, string | undefined>, work: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    work();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("loadConfig creates access contexts, workspaces and toolsets", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "drive,workspace,inventory",
    YFY_ACCESS_CONTEXTS_JSON: '[{"id":"reviewer","user_id":"531","external_enterprise_id":"9"}]',
    YFY_WORKSPACES_JSON: '[{"id":"tender_public","root_folder_id":"501","access_context":"reviewer","tags":["tender"]}]'
  }, () => {
    const config = loadConfig();
    assert.deepEqual(config.toolsets, ["drive", "workspace", "inventory"]);
    assert.equal(config.accessContexts[1]?.id, "reviewer");
    assert.equal(config.authorityScopes[0]?.rootFolderId, "501");
    assert.equal(config.snapshotConcurrency, 2);
    assert.equal(config.maxConcurrentProviderRequests, 40);
    assert.equal(config.maxConcurrentRequestsPerIdentity, 20);
    assert.equal(config.downloadStagedMaxConcurrentReads, 20);
    assert.match(config.stateDatabasePath, /state\.sqlite$/);
    assert.equal(config.apiBaseUrl, "https://open.fangcloud.com/api");
    assert.equal(getConfigSummary(config).configuration_source, "process_environment");
  });
});

test("loadConfig rejects an incomplete tender profile", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "drive,workspace", YFY_WORKFLOW_PROFILES: "tender"
  }, () => assert.throws(() => loadConfig(), /Workflow profile configuration is incomplete/));
});

test("loadConfig accepts a ready tender profile", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "drive,workspace,inventory", YFY_WORKFLOW_PROFILES: "tender",
    YFY_WORKSPACES_JSON: '[{"id":"tender","root_folder_id":"501"}]'
  }, () => assert.deepEqual(loadConfig().workflowProfiles, ["tender"]));
});

test("loadConfig rejects duplicate workspace ids", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_WORKSPACES_JSON: '[{"id":"scope","root_folder_id":"1"},{"id":"scope","root_folder_id":"2"}]'
  }, () => assert.throws(() => loadConfig(), /Duplicate workspace id/));
});

test("loadConfig rejects a state database inside managed temporary directories", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TEMP_DIR: "C:/tmp/yfy",
    YFY_STATE_DB: "C:/tmp/yfy/artifacts/state.sqlite"
  }, () => assert.throws(() => loadConfig(), /must not be located inside/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TEMP_DIR: "C:/tmp/yfy", YFY_STATE_DB: "C:/tmp/yfy/downloads/state.sqlite"
  }, () => assert.throws(() => loadConfig(), /must not be located inside/));
});

test("loadConfig enforces the stdio and HTTP download delivery matrix", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "stdio", YFY_DOWNLOAD_STAGED_HTTP: "enabled"
  }, () => assert.throws(() => loadConfig(), /only supported/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "stdio", YFY_DOWNLOAD_EXPOSE_LOCAL_PATH: "disabled"
  }, () => assert.throws(() => loadConfig(), /stdio download delivery/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http"
  }, () => {
    const config = loadConfig();
    assert.equal(config.downloadExposeLocalPath, false);
    assert.equal(config.downloadStagedHttpEnabled, true);
  });
});

test("loadConfig validates staged public URLs before startup", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http", YFY_HTTP_HOST: "0.0.0.0"
  }, () => assert.throws(() => loadConfig(), /PUBLIC_BASE_URL is required/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http", YFY_HTTP_HOST: "0.0.0.0", YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL: "http://files.example.com"
  }, () => assert.throws(() => loadConfig(), /must use HTTPS/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http", YFY_HTTP_HOST: "0.0.0.0", YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL: "https://0.0.0.0:3000"
  }, () => assert.throws(() => loadConfig(), /must not use a wildcard address/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http", YFY_HTTP_HOST: "0.0.0.0", YFY_DOWNLOAD_STAGED_PUBLIC_BASE_URL: "https://files.example.com/mcp"
  }, () => assert.equal(loadConfig().downloadStagedPublicBaseUrl, "https://files.example.com/mcp"));
});

test("loadConfig caps text preview size", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TEXT_PREVIEW_MAX_BYTES: "1048577"
  }, () => assert.throws(() => loadConfig(), /must not exceed/));
});

test("loadConfig caps configured concurrency", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_MAX_CONCURRENT_PROVIDER_REQUESTS: "41"
  }, () => assert.throws(() => loadConfig(), /must not exceed 40/));
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TRANSPORT: "http", YFY_DOWNLOAD_STAGED_MAX_CONCURRENT_READS: "41"
  }, () => assert.throws(() => loadConfig(), /must not exceed 40/));
});

test("loadConfig rejects unsupported log levels", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_LOG_LEVEL: "verbose"
  }, () => assert.throws(() => loadConfig()));
});

test("loadConfig requires download TTL to be positive", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TEMP_FILE_TTL_SECONDS: "0"
  }, () => assert.throws(() => loadConfig(), /positive integer/));
});
