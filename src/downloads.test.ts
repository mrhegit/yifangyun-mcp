import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { YifangyunError } from "./client.js";
import { DownloadRegistry } from "./runtime/downloads.js";
import { TempStorageManager } from "./runtime/tempStorage.js";

function hashes(body: string | Buffer) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    sha1: crypto.createHash("sha1").update(bytes).digest("hex"),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length
  };
}

async function sourceFile(root: string, name: string, body: string | Buffer) {
  const sourcePath = path.join(root, name);
  await fs.writeFile(sourcePath, body);
  return { fileName: name, identityRef: "default.test", mediaType: "application/octet-stream", sourcePath, ...hashes(body) };
}

function registry(root: string, options: { fetches?: number; maxBytes?: number; maxEntries?: number; ttl?: number } = {}) {
  const ttl = options.ttl ?? 60;
  const storage = new TempStorageManager(root, options.maxBytes ?? 1_048_576, ttl);
  return { downloads: new DownloadRegistry(storage, ttl, options.fetches ?? 10, options.maxEntries ?? 10_000), storage };
}

test("download registry persists a verified manifest and releases the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-reg-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "hello.txt", "hello-download"));
    assert.match(record.downloadId, /^dl_[a-f0-9]{32}$/);
    assert.equal(await fs.readFile(record.localPath, "utf8"), "hello-download");
    const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(record.localPath), "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.download_id, record.downloadId);
    assert.equal(manifest.sha256, record.sha256);
    assert.equal(await downloads.release(record.downloadId), true);
    await assert.rejects(() => fs.access(record.localPath));
    assert.equal(await downloads.release(record.downloadId), false);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download registry recovers active records after an ungraceful restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-recover-"));
  const first = registry(root);
  const record = await first.downloads.register(await sourceFile(root, "recover.bin", "recoverable"));
  const second = registry(root);
  try {
    await second.downloads.initialize();
    assert.equal(second.downloads.get(record.downloadId)?.sha256, record.sha256);
    assert.equal(await second.downloads.release(record.downloadId), true);
  } finally {
    await second.downloads.close();
    await first.downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery over a reduced quota fails without deleting valid downloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-recover-quota-"));
  const first = registry(root);
  const record = await first.downloads.register(await sourceFile(root, "preserve.bin", "preserve-after-failed-startup"));
  const second = registry(root, { maxBytes: 1 });
  try {
    await assert.rejects(() => second.downloads.initialize(), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_LOCAL_STORAGE_INSUFFICIENT");
    await second.downloads.close();
    assert.equal(await fs.readFile(record.localPath, "utf8"), "preserve-after-failed-startup");
  } finally {
    await first.downloads.close();
    await second.downloads.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("download registry removes expired records discovered after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-expired-"));
  const first = registry(root, { ttl: 1 });
  const record = await first.downloads.register(await sourceFile(root, "expired.bin", "x"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = registry(root, { ttl: 1 });
  try {
    await second.downloads.initialize();
    assert.equal(second.downloads.get(record.downloadId), undefined);
    await assert.rejects(() => fs.access(record.localPath));
  } finally {
    await second.downloads.close();
    await first.downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery removes expired downloads before enforcing a reduced quota", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-expired-quota-"));
  const first = registry(root);
  const record = await first.downloads.register(await sourceFile(root, "expired-over-quota.bin", "expired-content"));
  const manifestPath = path.join(path.dirname(record.localPath), "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.expires_at_ms = 0;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const second = registry(root, { maxBytes: 1 });
  try {
    await second.downloads.initialize();
    assert.equal(second.downloads.get(record.downloadId), undefined);
    await assert.rejects(() => fs.access(record.localPath));
    assert.equal(second.storage.usage().used_bytes, 0);
  } finally {
    await second.downloads.close();
    await first.downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("quota pressure rejects a new download without evicting an active one", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-quota-"));
  const { downloads } = registry(root, { maxBytes: 700 });
  try {
    const first = await downloads.register(await sourceFile(root, "first.bin", "a".repeat(100)));
    const secondInput = await sourceFile(root, "second.bin", "b".repeat(600));
    await assert.rejects(() => downloads.register(secondInput), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_LOCAL_STORAGE_INSUFFICIENT");
    assert.equal(await fs.readFile(first.localPath, "utf8"), "a".repeat(100));
    assert.ok(downloads.get(first.downloadId));
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact pruning does not double-count an active reservation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-reservation-"));
  const storage = new TempStorageManager(root, 1_048_576, 60);
  try {
    const reservation = await storage.reserve(100);
    await fs.writeFile(path.join(storage.artifactsRoot(), "partial.bin"), Buffer.alloc(50));
    await storage.pruneArtifacts();
    assert.deepEqual(storage.usage(), { max_bytes: 1_048_576, reserved_bytes: 100, used_bytes: 0 });
    await reservation.commit(50);
    assert.deepEqual(storage.usage(), { max_bytes: 1_048_576, reserved_bytes: 0, used_bytes: 50 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("artifact namespaces are recreated after pruning removes an empty directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-pruned-namespace-"));
  const storage = new TempStorageManager(root, 1_048_576, 60);
  try {
    const namespace = await storage.ensureArtifactNamespace("default_test");
    await storage.pruneArtifacts();
    await assert.rejects(() => fs.access(namespace));
    assert.equal(await storage.ensureArtifactNamespace("default_test"), namespace);
    await fs.access(namespace);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cached managed directories are revalidated after link replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-revalidate-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-revalidate-target-"));
  const storage = new TempStorageManager(root, 1_048_576, 60);
  try {
    const namespace = await storage.ensureArtifactNamespace("default_test");
    await fs.rmdir(namespace);
    await fs.symlink(target, namespace, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => storage.ensureArtifactNamespace("default_test"), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TEMP_STORAGE_CONFIG_UNSAFE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("managed roots are revalidated after initialization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-root-revalidate-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-root-target-"));
  const storage = new TempStorageManager(root, 1_048_576, 60);
  const artifactsRoot = storage.artifactsRoot();
  try {
    await storage.initialize();
    await fs.rm(artifactsRoot, { recursive: true, force: true });
    await fs.symlink(target, artifactsRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => storage.ensureArtifactNamespace("default_test"), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TEMP_STORAGE_CONFIG_UNSAFE");
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await fs.unlink(artifactsRoot).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("managed download roots reject directory links without touching their targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-link-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-target-"));
  const linkedRoot = path.join(root, "downloads");
  await fs.writeFile(path.join(target, "keep.txt"), "keep");
  await fs.symlink(target, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const storage = new TempStorageManager(root, 1_048_576, 60);
  try {
    await assert.rejects(() => storage.initialize(), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TEMP_STORAGE_CONFIG_UNSAFE");
    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "keep");
  } finally {
    await fs.unlink(linkedRoot).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("managed identity and artifact namespace links cannot escape their roots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-child-link-"));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-storage-child-target-"));
  const { downloads, storage } = registry(root);
  await storage.initialize();
  const identityLink = path.join(storage.downloadsRoot(), "default.test");
  const artifactLink = path.join(storage.artifactsRoot(), "default_test");
  await fs.symlink(target, identityLink, process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(target, artifactLink, process.platform === "win32" ? "junction" : "dir");
  try {
    const escapedSource = await sourceFile(root, "escape.bin", "escape");
    await assert.rejects(() => downloads.register(escapedSource), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TEMP_STORAGE_CONFIG_UNSAFE");
    await assert.rejects(() => storage.ensureArtifactNamespace("default_test"), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_TEMP_STORAGE_CONFIG_UNSAFE");
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await fs.unlink(identityLink).catch(() => undefined);
    await fs.unlink(artifactLink).catch(() => undefined);
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("release clears accounted bytes after external file removal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-accounting-"));
  const { downloads, storage } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "removed.bin", "removed"));
    assert.ok(storage.usage().used_bytes > 0);
    await fs.rm(path.dirname(record.localPath), { recursive: true, force: true });
    assert.equal(await downloads.release(record.downloadId), true);
    assert.equal(storage.usage().used_bytes, 0);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent registration respects the entry limit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-entry-limit-"));
  const { downloads } = registry(root, { maxEntries: 1 });
  try {
    const [first, second] = await Promise.allSettled([
      downloads.register(await sourceFile(root, "one.bin", "one")),
      downloads.register(await sourceFile(root, "two.bin", "two"))
    ]);
    assert.equal([first, second].filter((result) => result.status === "fulfilled").length, 1);
    const failure = [first, second].find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(failure.reason instanceof YifangyunError);
    assert.equal(failure.reason.code, "YFY_LOCAL_STORAGE_INSUFFICIENT");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed registration releases one managed artifact without debiting unrelated usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-register-accounting-"));
  const { downloads, storage } = registry(root);
  const namespace = await storage.ensureArtifactNamespace("accounting");
  const retained = path.join(namespace, "retained.bin");
  const source = path.join(namespace, "source.bin");
  const retainedBody = Buffer.from("retained");
  const sourceBody = Buffer.from("source");
  const retainedReservation = await storage.reserve(retainedBody.length);
  await fs.writeFile(retained, retainedBody);
  await retainedReservation.commit(retainedBody.length);
  const sourceReservation = await storage.reserve(sourceBody.length);
  await fs.writeFile(source, sourceBody);
  await sourceReservation.commit(sourceBody.length);
  const originalCreate = storage.createDownloadDirectory.bind(storage);
  let enteredResolve!: () => void;
  let continueResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const proceed = new Promise<void>((resolve) => { continueResolve = resolve; });
  storage.createDownloadDirectory = async (identity, downloadId) => {
    const directory = await originalCreate(identity, downloadId);
    enteredResolve();
    await proceed;
    return directory;
  };
  const registration = downloads.register({
    fileName: "source.bin",
    identityRef: "default.test",
    mediaType: "application/octet-stream",
    sha1: crypto.createHash("sha1").update(sourceBody).digest("hex"),
    sha256: crypto.createHash("sha256").update(sourceBody).digest("hex"),
    sizeBytes: sourceBody.length,
    sourcePath: source
  });
  try {
    await entered;
    const closing = downloads.close();
    continueResolve();
    await assert.rejects(() => registration, (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_REGISTRY_CLOSED");
    await closing;
    assert.equal(storage.usage().used_bytes, retainedBody.length);
    assert.equal(await fs.readFile(retained, "utf8"), "retained");
    await assert.rejects(() => fs.access(source));
  } finally {
    continueResolve();
    await downloads.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP acquisition rejects same-size tampering", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-tamper-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "file.bin", "original"));
    await fs.writeFile(record.localPath, "modified");
    await assert.rejects(() => downloads.acquireForHttpFetch(record.downloadId), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED");
    assert.equal(downloads.get(record.downloadId), undefined);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP acquisition treats a missing staged file as an integrity failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-missing-"));
  const { downloads, storage } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "missing.bin", "missing"));
    await fs.rm(record.localPath, { force: true });
    await assert.rejects(() => downloads.acquireForHttpFetch(record.downloadId), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED");
    assert.equal(downloads.get(record.downloadId), undefined);
    assert.equal(storage.usage().used_bytes, 0);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verified local reads reject same-size replacement bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-read-tamper-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "preview.txt", "original"));
    await fs.writeFile(record.localPath, "modified");
    await assert.rejects(() => downloads.readVerifiedBytes(record.downloadId, 1024), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED");
    assert.equal(downloads.get(record.downloadId), undefined);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release invalidates new HTTP fetches and waits for an active lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-lease-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "leased.bin", "lease-body"));
    const lease = await downloads.acquireForHttpFetch(record.downloadId);
    assert.equal(await downloads.release(record.downloadId), true);
    assert.equal(downloads.get(record.downloadId), undefined);
    assert.equal(await fs.readFile(record.localPath, "utf8"), "lease-body");
    await lease.release();
    await assert.rejects(() => fs.access(record.localPath));
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP fetch attempt limit is enforced in process", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-fetch-limit-"));
  const { downloads } = registry(root, { fetches: 1 });
  try {
    const record = await downloads.register(await sourceFile(root, "limited.bin", "limited"));
    const lease = await downloads.acquireForHttpFetch(record.downloadId);
    await lease.release();
    await assert.rejects(() => downloads.acquireForHttpFetch(record.downloadId), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_FETCH_LIMIT");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP lease detects staged bytes changed after acquisition", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-http-stream-integrity-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "snapshot.bin", "original"));
    const lease = await downloads.acquireForHttpFetch(record.downloadId);
    await fs.writeFile(record.localPath, "modified");
    await assert.rejects(async () => {
      for await (const _chunk of lease.createReadStream()) {
        // 消费完整流以触发末尾完整性校验。
      }
    }, (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED");
    await lease.release();
    assert.equal(downloads.get(record.downloadId), undefined);
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HTTP staged reads enforce concurrency and do not consume fetches when pre-cancelled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-http-capacity-"));
  const storage = new TempStorageManager(root, 1_048_576, 60);
  const downloads = new DownloadRegistry(storage, 60, 1, 10_000, 1);
  try {
    const first = await downloads.register(await sourceFile(root, "first-http.bin", "first"));
    const second = await downloads.register(await sourceFile(root, "second-http.bin", "second"));
    const lease = await downloads.acquireForHttpFetch(first.downloadId);
    await assert.rejects(() => downloads.acquireForHttpFetch(second.downloadId), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_READ_CAPACITY");
    await lease.release();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => downloads.acquireForHttpFetch(second.downloadId, controller.signal), (error: unknown) => error instanceof YifangyunError && error.code === "YFY_REQUEST_CANCELLED");
    const secondLease = await downloads.acquireForHttpFetch(second.downloadId);
    await secondLease.release();
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows reserved file names are sanitized", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-dl-name-"));
  const { downloads } = registry(root);
  try {
    const record = await downloads.register(await sourceFile(root, "source.bin", "name"));
    await downloads.release(record.downloadId);
    const special = await sourceFile(root, "source2.bin", "name2");
    const sanitized = await downloads.register({ ...special, fileName: "CON. " });
    assert.equal(path.basename(sanitized.localPath).startsWith("_CON"), true);
    await downloads.release(sanitized.downloadId);
    const manifestNamed = await sourceFile(root, "source3.bin", "name3");
    const reserved = await downloads.register({ ...manifestNamed, fileName: "manifest.json" });
    assert.equal(path.basename(reserved.localPath), "_manifest.json");
  } finally {
    await downloads.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
