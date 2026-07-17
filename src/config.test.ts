import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const ENV_KEYS = [
  "YFY_CLIENT_ID", "YFY_CLIENT_SECRET", "YFY_ENTERPRISE_ID", "YFY_DEFAULT_USER_ID", "YFY_TOOLSETS", "YFY_ACCESS_CONTEXTS_JSON", "YFY_SCOPES_JSON",
  "YFY_API_BASE_URL", "YFY_OAUTH_BASE_URL", "YFY_SNAPSHOT_CONCURRENCY", "YFY_STATE_DB", "YFY_TEMP_DIR", "YFY_MAX_DOWNLOAD_BYTES",
  "YFY_MAX_EVIDENCE_RESOURCE_BYTES", "YFY_TEMP_FILE_TTL_SECONDS", "YFY_LOG_LEVEL", "YFY_UPLOAD_ROOT_DIR", "YFY_WORKFLOW_PROFILES"
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

test("loadConfig creates access contexts, scopes and toolsets", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "core,authority,snapshot,evidence",
    YFY_ACCESS_CONTEXTS_JSON: '[{"id":"reviewer","user_id":"531","external_enterprise_id":"9"}]',
    YFY_SCOPES_JSON: '[{"id":"tender_public","root_folder_id":"501","access_context":"reviewer","tags":["tender"]}]'
  }, () => {
    const config = loadConfig();
    assert.deepEqual(config.toolsets, ["core", "authority", "snapshot", "evidence"]);
    assert.equal(config.accessContexts[1]?.id, "reviewer");
    assert.equal(config.authorityScopes[0]?.rootFolderId, "501");
    assert.equal(config.snapshotConcurrency, 2);
    assert.match(config.stateDatabasePath, /state\.sqlite$/);
    assert.equal(config.apiBaseUrl, "https://open.fangcloud.com/api");
  });
});

test("loadConfig rejects an incomplete tender profile", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "core,evidence", YFY_WORKFLOW_PROFILES: "tender"
  }, () => assert.throws(() => loadConfig(), /Workflow profile configuration is incomplete/));
});

test("loadConfig accepts a ready tender profile", () => {
  withEnv({
    YFY_CLIENT_ID: "client", YFY_CLIENT_SECRET: "secret", YFY_ENTERPRISE_ID: "115", YFY_DEFAULT_USER_ID: "530",
    YFY_TOOLSETS: "core,organization,authority,snapshot,evidence", YFY_WORKFLOW_PROFILES: "tender",
    YFY_SCOPES_JSON: '[{"id":"tender","root_folder_id":"501"}]'
  }, () => assert.deepEqual(loadConfig().workflowProfiles, ["tender"]));
});

test("loadConfig rejects duplicate authority scope ids", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_SCOPES_JSON: '[{"id":"scope","root_folder_id":"1"},{"id":"scope","root_folder_id":"2"}]'
  }, () => assert.throws(() => loadConfig(), /Duplicate authority scope id/));
});

test("loadConfig rejects a state database inside the evidence artifact directory", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TEMP_DIR: "C:/tmp/yfy",
    YFY_STATE_DB: "C:/tmp/yfy/artifacts/state.sqlite"
  }, () => assert.throws(() => loadConfig(), /must not be located inside/));
});

test("loadConfig bounds MCP evidence resources below the download limit", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_MAX_DOWNLOAD_BYTES: "16",
    YFY_MAX_EVIDENCE_RESOURCE_BYTES: "32"
  }, () => assert.throws(() => loadConfig(), /must not exceed/));
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

test("loadConfig requires evidence resource TTL to be positive", () => {
  withEnv({
    YFY_CLIENT_ID: "client",
    YFY_CLIENT_SECRET: "secret",
    YFY_ENTERPRISE_ID: "115",
    YFY_DEFAULT_USER_ID: "530",
    YFY_TEMP_FILE_TTL_SECONDS: "0"
  }, () => assert.throws(() => loadConfig(), /positive integer/));
});
