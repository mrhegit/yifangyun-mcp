import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runHttp } from "./index.js";
import { AppRuntime } from "./runtime/runtime.js";
import type { AppConfig } from "./types.js";

function config(root: string, stagedHttp = true): AppConfig {
  return {
    accessContexts: [{ id: "default", userId: "530" }],
    apiBaseUrl: "https://open.fangcloud.com/api",
    authorityScopes: [],
    oauthBaseUrl: "https://open.fangcloud.com",
    clientId: "client",
    clientSecret: "secret",
    defaultAccessContext: "default",
    defaultUserId: "530",
    downloadExposeLocalPath: !stagedHttp,
    downloadStagedHttpEnabled: stagedHttp,
    downloadStagedMaxFetches: 1,
    enterpriseId: "115",
    httpBearerToken: "test-token",
    httpHost: "127.0.0.1",
    httpPort: 0,
    logLevel: "error",
    maxDownloadBytes: 1_048_576,
    maxPageCapacity: 100,
    maxTempBytes: 2_097_152,
    requestTimeoutMs: 1000,
    retryBaseDelayMs: 1,
    retryMaxAttempts: 1,
    stateDatabasePath: path.join(root, "state.sqlite"),
    tempDir: root,
    tempFileTtlSeconds: 60,
    tokenRefreshSkewSeconds: 30,
    toolsets: ["drive"],
    transport: "http",
    workflowProfiles: []
  };
}

async function stage(runtime: AppRuntime, root: string, body: string) {
  const sourcePath = path.join(root, `source-${crypto.randomBytes(4).toString("hex")}.bin`);
  await fs.writeFile(sourcePath, body);
  return runtime.downloads.register({
    fileName: "report.bin",
    identityRef: "default.test",
    mediaType: "application/octet-stream",
    sha1: crypto.createHash("sha1").update(body).digest("hex"),
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    sizeBytes: Buffer.byteLength(body),
    sourcePath
  });
}

async function requestStatus(url: string, headers: http.OutgoingHttpHeaders): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
  });
}

test("HTTP staged download enforces auth, streams verified bytes and fetch limits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-download-"));
  const runtime = await AppRuntime.create(config(root));
  const running = await runHttp(runtime);
  try {
    const record = await stage(runtime, root, "http-body");
    const url = `${running.baseUrl}/staged/v1/${record.downloadId}/${encodeURIComponent(record.fileName)}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "http-body");
    assert.equal(response.headers.get("etag"), `"${record.sha256}"`);
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer test-token" } })).status, 404);
  } finally {
    await running.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP staged route is absent when the delivery channel is disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-disabled-"));
  const runtime = await AppRuntime.create(config(root, false));
  const running = await runHttp(runtime);
  try {
    const record = await stage(runtime, root, "local-only");
    const response = await fetch(`${running.baseUrl}/staged/v1/${record.downloadId}/report.bin`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 404);
  } finally {
    await running.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote staged delivery requires bearer, Host and Origin policy before startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-remote-config-"));
  const missingBearerConfig = config(root);
  missingBearerConfig.downloadStagedPublicBaseUrl = "https://files.example.com/mcp";
  delete missingBearerConfig.httpBearerToken;
  const missingBearerRuntime = await AppRuntime.create(missingBearerConfig);
  try {
    await assert.rejects(() => runHttp(missingBearerRuntime), /BEARER_TOKEN is required/);
  } finally {
    await missingBearerRuntime.close();
  }

  const missingPolicyConfig = config(root);
  missingPolicyConfig.downloadStagedPublicBaseUrl = "https://files.example.com/mcp";
  const missingPolicyRuntime = await AppRuntime.create(missingPolicyConfig);
  try {
    await assert.rejects(() => runHttp(missingPolicyRuntime), /ALLOWED_HOSTS and YFY_HTTP_ALLOWED_ORIGINS are required/);
  } finally {
    await missingPolicyRuntime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote HTTP policy enforces Host, Origin and bearer headers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-remote-policy-"));
  const appConfig = config(root);
  appConfig.downloadStagedPublicBaseUrl = "https://files.example.com/mcp";
  appConfig.httpAllowedHosts = ["files.example.com"];
  appConfig.httpAllowedOrigins = ["https://agent.example.com"];
  const runtime = await AppRuntime.create(appConfig);
  const running = await runHttp(runtime);
  try {
    const headers = { Host: "files.example.com" };
    assert.equal(await requestStatus(`${running.baseUrl}/health`, headers), 401);
    assert.equal(await requestStatus(`${running.baseUrl}/health`, {
      ...headers,
      Authorization: "Bearer test-token",
      Origin: "https://wrong.example.com"
    }), 403);
    assert.equal(await requestStatus(`${running.baseUrl}/health`, {
      ...headers,
      Authorization: "Bearer test-token",
      Origin: "https://agent.example.com"
    }), 200);
    assert.equal(await requestStatus(`${running.baseUrl}/health`, {
      Authorization: "Bearer test-token",
      Host: "wrong.example.com",
      Origin: "https://agent.example.com"
    }), 403);
  } finally {
    await running.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP staged download rejects same-size tampering", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-integrity-"));
  const runtime = await AppRuntime.create(config(root));
  const running = await runHttp(runtime);
  try {
    const record = await stage(runtime, root, "original");
    await fs.writeFile(record.localPath, "modified");
    const response = await fetch(`${running.baseUrl}/staged/v1/${record.downloadId}`, { headers: { Authorization: "Bearer test-token" } });
    assert.equal(response.status, 410);
  } finally {
    await running.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release preserves an active streamed HTTP response and deletes staged bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-http-lease-"));
  const appConfig = config(root);
  appConfig.maxDownloadBytes = 8 * 1024 * 1024;
  appConfig.maxTempBytes = 16 * 1024 * 1024;
  const runtime = await AppRuntime.create(appConfig);
  const running = await runHttp(runtime);
  try {
    const record = await stage(runtime, root, "x".repeat(4 * 1024 * 1024));
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${running.baseUrl}/staged/v1/${record.downloadId}`, {
        headers: { Authorization: "Bearer test-token" }
      }, resolve);
      request.on("error", reject);
    });
    response.pause();
    assert.equal(response.statusCode, 200);
    assert.equal(await runtime.downloads.release(record.downloadId), true);
    let receivedBytes = 0;
    response.on("data", (chunk: Buffer) => { receivedBytes += chunk.length; });
    const ended = once(response, "end");
    response.resume();
    await ended;
    assert.equal(receivedBytes, 4 * 1024 * 1024);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await fs.stat(record.localPath).catch(() => undefined))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(() => fs.access(record.localPath));
  } finally {
    await running.close();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
