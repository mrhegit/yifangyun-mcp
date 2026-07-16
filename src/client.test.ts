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

test("non-idempotent POST requests are not automatically retried", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    }
    apiCalls += 1;
    return new Response(JSON.stringify({ errors: [{ code: "server_error", msg: "failed" }] }), { status: 500 });
  };
  try {
    const client = new YifangyunClient({ ...makeConfig(), retryMaxAttempts: 3 });
    await assert.rejects(() => client.postAsUser("/v2/folder/create", undefined, { name: "x", parent_id: 1 }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_PROVIDER_SERVER_ERROR");
    assert.equal(apiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safe GET requests retry transient provider failures", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    }
    apiCalls += 1;
    return apiCalls === 1
      ? new Response(JSON.stringify({ errors: [{ code: "busy", msg: "busy" }] }), { status: 503 })
      : new Response(JSON.stringify({ id: 1, name: "ok" }), { status: 200 });
  };
  try {
    const client = new YifangyunClient({ ...makeConfig(), retryBaseDelayMs: 1, retryMaxAttempts: 2 });
    const result = await client.getAsUser("/v2/file/1/info_v2");
    assert.equal((result.data as { name: string }).name, "ok");
    assert.equal(apiCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent token requests share one in-flight OAuth exchange", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  };
  try {
    const client = new YifangyunClient(makeConfig());
    const [left, right] = await Promise.all([client.getUserToken(530), client.getUserToken(530)]);
    assert.equal(left, "token");
    assert.equal(right, "token");
    assert.equal(tokenCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transfer URLs resolving to private addresses are rejected by default", async () => {
  const client = new YifangyunClient(makeConfig());
  await assert.rejects(
    () => client.downloadFromUrlToTemp("https://127.0.0.1/file", { fileNameHint: "file.bin" }),
    (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TRANSFER_URL_PRIVATE_ADDRESS"
  );
});
