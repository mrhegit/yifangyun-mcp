import assert from "node:assert/strict";
import type dns from "node:dns";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTransferLookup, redactSensitiveText, YifangyunClient, YifangyunError } from "./client.js";
import type { AppConfig } from "./types.js";

function makeConfig(): AppConfig {
  return {
    accessContexts: [{ id: "default", userId: "530" }], apiBaseUrl: "https://open.fangcloud.com/api", authorityScopes: [], oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client-id", clientSecret: "client-secret", enterpriseId: "115", defaultUserId: "530", defaultAccessContext: "default", logLevel: "info",
    maxDownloadBytes: 1024, maxPageCapacity: 500, requestTimeoutMs: 1000, retryBaseDelayMs: 100, retryMaxAttempts: 1,
    stateDatabasePath: ":memory:", tempDir: "C:/temp/yifangyun-mcp-test", tempFileTtlSeconds: 60, tokenRefreshSkewSeconds: 300,
    toolsets: ["core"], transport: "stdio", workflowProfiles: []
  };
}

test("redactSensitiveText masks bearer tokens and signed URLs", () => {
  const redacted = redactSensitiveText("Bearer abc123 download_url=https://a.test?token=1&sign=2 presign_url=https://b.test/upload");
  assert.doesNotMatch(redacted, /abc123|https:\/\/a\.test|https:\/\/b\.test\/upload/);
  assert.match(redacted, /\*\*\*redacted\*\*\*/);
});

test("file access uses an explicit context user or the configured default", () => {
  const client = new YifangyunClient(makeConfig(), (url, init) => globalThis.fetch(url, init));
  try {
    assert.equal(client.resolveFileAccessUser(), "530");
    assert.equal(client.resolveFileAccessUser("531"), "531");
  } finally {
    client.close();
  }
});

test("non-idempotent POST requests are not automatically retried", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    apiCalls += 1;
    return new Response(JSON.stringify({ errors: [{ code: "server_error", msg: "failed" }] }), { status: 500 });
  };
  const client = new YifangyunClient({ ...makeConfig(), retryMaxAttempts: 3 });
  try {
    await assert.rejects(() => client.postAsUser("/v2/folder/create", undefined, { name: "x", parent_id: 1 }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_PROVIDER_SERVER_ERROR");
    assert.equal(apiCalls, 1);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("safe GET requests retry transient provider failures", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    apiCalls += 1;
    return apiCalls === 1
      ? new Response(JSON.stringify({ errors: [{ code: "busy", msg: "busy" }] }), { status: 503 })
      : new Response(JSON.stringify({ id: 1, name: "ok" }), { status: 200 });
  };
  const client = new YifangyunClient({ ...makeConfig(), retryBaseDelayMs: 1, retryMaxAttempts: 2 });
  try {
    const result = await client.getAsUser("/v2/file/1/info_v2");
    assert.equal((result.data as { name: string }).name, "ok");
    assert.equal(apiCalls, 2);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("Provider retry backoff stops promptly when the request is cancelled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/oauth/token")
    ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ errors: [{ code: "busy", msg: "busy" }] }), { status: 503, headers: { "retry-after": "2" } });
  const client = new YifangyunClient({ ...makeConfig(), maxRetryDelayMs: 5000, retryMaxAttempts: 3 });
  const controller = new AbortController();
  try {
    const startedAt = Date.now();
    const request = client.getAsUser("/v2/file/1/info_v2", undefined, {}, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => request, (error: unknown) => error instanceof YifangyunError && error.code === "YFY_REQUEST_CANCELLED");
    assert.ok(Date.now() - startedAt < 500, "cancellation should interrupt retry backoff");
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("concurrent token requests share one OAuth exchange", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  };
  const client = new YifangyunClient(makeConfig(), (url, init) => globalThis.fetch(url, init));
  try {
    const [left, right] = await Promise.all([client.getUserToken("530"), client.getUserToken("530")]);
    assert.equal(left, "token");
    assert.equal(right, "token");
    assert.equal(tokenCalls, 1);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("cancelling one token waiter does not cancel the shared OAuth exchange", async () => {
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
  };
  const client = new YifangyunClient(makeConfig());
  const controller = new AbortController();
  try {
    const cancelled = client.getUserToken("530", controller.signal);
    controller.abort();
    await assert.rejects(() => cancelled, (error: unknown) => error instanceof YifangyunError && error.code === "YFY_REQUEST_CANCELLED");
    assert.equal(await client.getUserToken("530"), "token");
    assert.equal(tokenCalls, 1);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("private transfer addresses are rejected by default", async () => {
  const client = new YifangyunClient(makeConfig());
  try {
    await assert.rejects(() => client.downloadFromUrlToTemp("https://127.0.0.1/file", { fileNameHint: "file.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TRANSFER_URL_PRIVATE_ADDRESS");
  } finally {
    client.close();
  }
});

test("transfer DNS lookup preserves the all-address callback contract", async () => {
  const resolver = ((_hostname: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
    assert.equal(options.all, true);
    callback(null, [{ address: "8.8.8.8", family: 4 }]);
  }) as unknown as typeof dns.lookup;
  const lookup = createTransferLookup(false, resolver);
  const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
    lookup("download.example", { all: true }, (error, address) => {
      if (error) reject(error);
      else resolve(address as dns.LookupAddress[]);
    });
  });
  assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
});

test("download redirects are revalidated before the next transfer hop", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    requestInit = init;
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  };
  const client = new YifangyunClient(makeConfig(), (url, init) => globalThis.fetch(url, init));
  try {
    await assert.rejects(() => client.downloadFromUrlToTemp("https://8.8.8.8/file", { fileNameHint: "file.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TRANSFER_URL_PRIVATE_ADDRESS");
    assert.equal(calls, 1);
    assert.equal(requestInit?.redirect, "manual");
    assert.ok("dispatcher" in (requestInit as RequestInit & { dispatcher: unknown }));
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
});

test("upload redirects are rejected instead of replaying the file body", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-upload-redirect-"));
  const filePath = path.join(dir, "source.bin");
  await fs.writeFile(filePath, "content");
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 307, headers: { location: "https://upload.example/next" } });
  };
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true }, (url, init) => globalThis.fetch(url, init));
  const source = await fs.open(filePath, "r");
  try {
    await assert.rejects(() => client.uploadLocalFileToPresignedUrl("https://upload.example/file", source, "source.bin"), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TRANSFER_REDIRECT_REJECTED");
    assert.equal(calls, 1);
  } finally {
    await source.close();
    client.close();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("downloads without Content-Length reserve the maximum bounded size", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-temp-reservation-"));
  globalThis.fetch = async () => new Response("small", { status: 200 });
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true, maxDownloadBytes: 1024, maxTempBytes: 100, tempDir: dir }, (url, init) => globalThis.fetch(url, init));
  try {
    await assert.rejects(() => client.downloadFromUrlToTemp("https://127.0.0.1/file", { fileNameHint: "file.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_LOCAL_STORAGE_INSUFFICIENT");
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("concurrent downloads cannot exceed the shared temporary storage quota", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-temp-concurrency-"));
  let calls = 0;
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; } }), { status: 200, headers: { "content-length": "60" } });
    }
    return new Response(new Uint8Array(60), { status: 200, headers: { "content-length": "60" } });
  };
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true, maxDownloadBytes: 100, maxTempBytes: 100, tempDir: dir }, (url, init) => globalThis.fetch(url, init));
  try {
    const first = client.downloadFromUrlToTemp("https://127.0.0.1/first", { fileNameHint: "first.bin" });
    const artifactDir = path.join(dir, "artifacts", "shared");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await fs.readdir(artifactDir).catch(() => [])).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await assert.rejects(() => client.downloadFromUrlToTemp("https://127.0.0.1/second", { fileNameHint: "second.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_LOCAL_STORAGE_INSUFFICIENT");
    firstController!.enqueue(new Uint8Array(60));
    firstController!.close();
    assert.equal((await first).sizeBytes, 60);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
