import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText, YifangyunClient, YifangyunError } from "./client.js";
import type { AppConfig } from "./types.js";

function makeConfig(strategy: AppConfig["fileAccessUserStrategy"] = "default"): AppConfig {
  return {
    apiBaseUrl: "https://open.fangcloud.com/api",
    allowDownloadUrl: false,
    adminUserId: 999,
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    enterpriseId: 115,
    defaultUserId: 530,
    enableAdminTools: false,
    enableMutationTools: false,
    enableRawResponse: false,
    fileAccessUserStrategy: strategy,
    logLevel: "info",
    maxDownloadBytes: 1024,
    maxPageCapacity: 500,
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 100,
    retryMaxAttempts: 1,
    tempDir: "C:/temp/yifangyun-mcp-test",
    tempFileTtlSeconds: 60,
    tokenRefreshSkewSeconds: 300
  };
}

test("redactSensitiveText masks bearer tokens and signed URLs", () => {
  const text = "Bearer abc123 download_url=https://a.test?token=1&sign=2 presign_url=https://b.test/upload";
  const redacted = redactSensitiveText(text);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /https:\/\/a\.test/);
  assert.doesNotMatch(redacted, /https:\/\/b\.test\/upload/);
  assert.match(redacted, /\*\*\*redacted\*\*\*/);
});

test("resolveFileAccessUser follows default, admin, and explicit strategies", () => {
  const defaultClient = new YifangyunClient(makeConfig("default"));
  assert.equal(defaultClient.resolveFileAccessUser(), 530);

  const adminClient = new YifangyunClient(makeConfig("admin"));
  assert.equal(adminClient.resolveFileAccessUser(), 999);

  const explicitClient = new YifangyunClient(makeConfig("explicit"));
  assert.throws(() => explicitClient.resolveFileAccessUser(), (error: unknown) => error instanceof YifangyunError);
});
