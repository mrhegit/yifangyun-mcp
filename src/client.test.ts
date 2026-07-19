import assert from "node:assert/strict";
import dns from "node:dns";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTransferLookup, redactSensitiveText, YifangyunClient, YifangyunError } from "./client.js";
import { YifangyunGateway } from "./gateway.js";
import { metrics } from "./observability.js";
import { AccessRegistry } from "./runtime/access.js";
import type { AppConfig } from "./types.js";

function makeConfig(): AppConfig {
  return {
    accessContexts: [{ id: "default", userId: "530" }], apiBaseUrl: "https://open.fangcloud.com/api", authorityScopes: [], oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client-id", clientSecret: "client-secret", enterpriseId: "115", defaultUserId: "530", defaultAccessContext: "default", logLevel: "info",
    maxDownloadBytes: 1024, maxPageCapacity: 500, requestTimeoutMs: 1000, retryBaseDelayMs: 100, retryMaxAttempts: 1,
    stateDatabasePath: ":memory:", tempDir: "C:/temp/yifangyun-mcp-test", tempFileTtlSeconds: 60, tokenRefreshSkewSeconds: 300,
    toolsets: ["drive"], transport: "stdio", workflowProfiles: []
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

test("transfer DNS lookup rejects non-public and IPv4-mapped addresses", async () => {
  for (const address of ["100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "::ffff:127.0.0.1", "::ffff:0a00:0001", "2001:db8::1", "2002:7f00:1::"]) {
    const resolver = ((_hostname: string, _options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => {
      callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
    }) as unknown as typeof dns.lookup;
    const lookup = createTransferLookup(false, resolver);
    await assert.rejects(() => new Promise((resolve, reject) => {
      lookup("download.example", { all: true }, (error, result) => error ? reject(error) : resolve(result));
    }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_TRANSFER_URL_PRIVATE_ADDRESS"));
  }
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

test("download transfer rejects final non-2xx responses before staging bytes", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-transfer-status-"));
  globalThis.fetch = async () => new Response("not-found-body", { status: 404, headers: { "content-length": "14" } });
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true, retryMaxAttempts: 1, tempDir: dir }, (url, init) => globalThis.fetch(url, init));
  try {
    await assert.rejects(() => client.downloadFromUrlToTemp("https://127.0.0.1/file", { fileNameHint: "file.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_TRANSFER_HTTP_ERROR" && error.statusCode === 404);
    assert.deepEqual(await fs.readdir(path.join(dir, "artifacts")).catch(() => []), []);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("download stream failures remove partial staged bytes", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-transfer-partial-cleanup-"));
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("connection reset"));
    }
  }), { status: 200, headers: { "content-length": "10" } });
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true, retryMaxAttempts: 1, tempDir: dir }, (url, init) => globalThis.fetch(url, init));
  try {
    await assert.rejects(() => client.downloadFromUrlToTemp("https://download.example/partial", { fileNameHint: "partial.bin" }), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_STREAM_FAILED");
    assert.deepEqual(await fs.readdir(path.join(dir, "artifacts", "shared")).catch(() => []), []);
  } finally {
    await client.close();
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

test("download concurrency is bucketed by access identity", async () => {
  const originalFetch = globalThis.fetch;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-download-bucket-"));
  let calls = 0;
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; } }), { status: 200, headers: { "content-length": "1" } });
    }
    return new Response(new Uint8Array([2]), { status: 200, headers: { "content-length": "1" } });
  };
  const client = new YifangyunClient({
    ...makeConfig(),
    allowPrivateTransferUrls: true,
    maxConcurrentProviderRequests: 2,
    maxConcurrentRequestsPerIdentity: 1,
    maxTempBytes: 1024,
    tempDir: dir
  }, (url, init) => globalThis.fetch(url, init));
  try {
    const first = client.downloadFromUrlToTemp("https://127.0.0.1/first", { fileNameHint: "first.bin", namespace: "identity-a" });
    for (let attempt = 0; attempt < 50 && calls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = client.downloadFromUrlToTemp("https://127.0.0.1/second", { fileNameHint: "second.bin", namespace: "identity-a" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls, 1);
    firstController!.enqueue(new Uint8Array([1]));
    firstController!.close();
    await first;
    await second;
    assert.equal(calls, 2);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("Provider API concurrency is shared across resource paths for one identity", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    apiCalls += 1;
    if (apiCalls === 1) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; } }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 2 }), { status: 200 });
  };
  const client = new YifangyunClient({ ...makeConfig(), maxConcurrentProviderRequests: 2, maxConcurrentRequestsPerIdentity: 1 });
  try {
    const first = client.getAsUser("/v2/file/1/info_v2");
    for (let attempt = 0; attempt < 50 && apiCalls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = client.getAsUser("/v2/folder/2/info");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(apiCalls, 1);
    firstController!.enqueue(new TextEncoder().encode(JSON.stringify({ id: 1 })));
    firstController!.close();
    await first;
    await second;
    assert.equal(apiCalls, 2);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});

test("Provider API buckets isolate users, enterprise access and external enterprises", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    apiCalls += 1;
    if (apiCalls === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; } }), { status: 200 });
    return new Response(JSON.stringify({ id: apiCalls }), { status: 200 });
  };
  const client = new YifangyunClient({ ...makeConfig(), maxConcurrentProviderRequests: 4, maxConcurrentRequestsPerIdentity: 1 });
  try {
    await Promise.all([client.getUserToken("530"), client.getUserToken("531"), client.getEnterpriseToken()]);
    const first = client.getAsUser("/v2/file/1/info_v2", "530", {}, undefined, "external-a");
    for (let attempt = 0; attempt < 50 && apiCalls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const others = [
      client.getAsUser("/v2/file/2/info_v2", "531", {}, undefined, "external-a"),
      client.getEnterprise("/v2/enterprise/info"),
      client.getAsUser("/v2/file/3/info_v2", "530", {}, undefined, "external-b")
    ];
    for (let attempt = 0; attempt < 50 && apiCalls < 4; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(apiCalls, 4);
    firstController!.enqueue(new TextEncoder().encode(JSON.stringify({ id: 1 })));
    firstController!.close();
    await Promise.all([first, ...others]);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});

test("Gateway propagates external enterprise identity into Provider concurrency buckets", async () => {
  const originalFetch = globalThis.fetch;
  let apiCalls = 0;
  let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    apiCalls += 1;
    if (apiCalls === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) { firstController = controller; } }), { status: 200 });
    return new Response(JSON.stringify({ id: 2 }), { status: 200 });
  };
  const appConfig = {
    ...makeConfig(),
    accessContexts: [
      { id: "external-a", userId: "530", externalEnterpriseId: "enterprise-a" },
      { id: "external-b", userId: "530", externalEnterpriseId: "enterprise-b" }
    ],
    defaultAccessContext: "external-a",
    maxConcurrentProviderRequests: 2,
    maxConcurrentRequestsPerIdentity: 1
  } satisfies AppConfig;
  const client = new YifangyunClient(appConfig);
  const gateway = new YifangyunGateway(client, new AccessRegistry(appConfig), 500);
  try {
    const first = gateway.getUser("/v2/file/1/info_v2", "external-a");
    for (let attempt = 0; attempt < 50 && apiCalls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = gateway.getUser("/v2/file/2/info_v2", "external-b");
    for (let attempt = 0; attempt < 50 && apiCalls < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(apiCalls, 2);
    firstController!.enqueue(new TextEncoder().encode(JSON.stringify({ id: 1 })));
    firstController!.close();
    await Promise.all([first, second]);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});

test("transfer URL DNS validation stops when the operation signal is aborted", async () => {
  const originalLookup = dns.promises.lookup;
  dns.promises.lookup = (() => new Promise(() => undefined)) as typeof dns.promises.lookup;
  const client = new YifangyunClient(makeConfig());
  const controller = new AbortController();
  try {
    const request = client.downloadFromUrlToTemp("https://download.example/file", { fileNameHint: "file.bin", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => request, (error: unknown) => error instanceof YifangyunError && error.code === "YFY_REQUEST_CANCELLED" && error.phase === "transfer_url_validation");
  } finally {
    await client.close();
    dns.promises.lookup = originalLookup;
  }
});

test("historical version ids retain exact decimal text in the Provider URL", async () => {
  const originalFetch = globalThis.fetch;
  const providerVersionId = "90071992547409931234";
  let requestedUrl: URL | undefined;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
    requestedUrl = new URL(String(input));
    return new Response(JSON.stringify({ download_url: "https://download.example/file" }), { status: 200 });
  };
  const client = new YifangyunClient(makeConfig());
  try {
    await client.getAsUser("/v2/file/10/download_v2", undefined, { version: providerVersionId });
    assert.equal(requestedUrl?.searchParams.get("version"), providerVersionId);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});

test("transfer metrics use one low-cardinality endpoint label", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-transfer-metrics-"));
  const opaquePaths = ["01JABCDEF0123456789ABCDEFG", "signed_Zm9vYmFyLXVuaXF1ZQ"];
  const client = new YifangyunClient({ ...makeConfig(), allowPrivateTransferUrls: true, maxTempBytes: 1024, tempDir: dir }, async () => new Response("x", { status: 200, headers: { "content-length": "1" } }));
  try {
    for (const opaque of opaquePaths) {
      await client.downloadFromUrlToTemp(`https://download.example/${opaque}/file.bin`, { fileNameHint: "file.bin", namespace: "metrics" });
    }
    const snapshot = JSON.stringify(metrics.snapshot());
    assert.match(snapshot, /endpoint=provider_transfer/);
    for (const opaque of opaquePaths) assert.doesNotMatch(snapshot, new RegExp(opaque));
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});
