import crypto from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { YifangyunError } from "../errors.js";
import { TempStorageManager } from "./tempStorage.js";

const DOWNLOAD_ID_PATTERN = /^dl_[a-f0-9]{32}$/;
const MANIFEST_VERSION = 2;

export interface DownloadRecord {
  downloadId: string;
  expiresAtMs: number;
  fileName: string;
  identityRef: string;
  localPath: string;
  mediaType: string;
  remainingDownloads: number;
  sha1: string;
  sha256: string;
  sizeBytes: number;
}

export interface DownloadLease {
  record: DownloadRecord;
  createReadStream(): Readable;
  release(): Promise<void>;
}

interface StoredDownloadRecord extends DownloadRecord {
  accountedBytes: number;
  activeReaders: number;
  directory: string;
  fileCtimeMs: number;
  fileMtimeMs: number;
  manifestPath: string;
  pendingDelete: boolean;
}

interface DownloadManifest {
  download_id: string;
  expires_at_ms: number;
  file_ctime_ms: number;
  file_name: string;
  file_mtime_ms: number;
  identity_ref: string;
  manifest_version: number;
  media_type: string;
  sha1: string;
  sha256: string;
  size_bytes: number;
}

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }
}

export class DownloadRegistry {
  private activeHttpLeases = 0;
  private closing = false;
  private readonly cleanupTimer: NodeJS.Timeout;
  private cleanupRunning = false;
  private initialized = false;
  private readonly mutex = new AsyncMutex();
  private pendingRegistrations = 0;
  private readonly registrationDrainWaiters: Array<() => void> = [];
  private readonly records = new Map<string, StoredDownloadRecord>();

  constructor(
    private readonly storage: TempStorageManager,
    private readonly ttlSeconds: number,
    private readonly maxDownloadsPerFile = 10,
    private readonly maxEntries = 10_000,
    private readonly maxConcurrentHttpLeases = 20
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("Download TTL must be a positive integer.");
    if (!Number.isSafeInteger(maxDownloadsPerFile) || maxDownloadsPerFile <= 0) throw new Error("Download max fetches must be a positive integer.");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("Download max entries must be a positive integer.");
    if (!Number.isSafeInteger(maxConcurrentHttpLeases) || maxConcurrentHttpLeases <= 0 || maxConcurrentHttpLeases > 40) throw new Error("Download concurrent HTTP lease limit must be between 1 and 40.");
    const intervalMs = Math.min(Math.max(ttlSeconds * 1000, 1000), 60_000);
    this.cleanupTimer = setInterval(() => {
      if (this.cleanupRunning) return;
      this.cleanupRunning = true;
      void this.pruneExpired().catch(() => undefined).finally(() => { this.cleanupRunning = false; });
    }, intervalMs);
    this.cleanupTimer.unref();
  }

  downloadsRoot(): string {
    return this.storage.downloadsRoot();
  }

  ttlSecondsValue(): number {
    return this.ttlSeconds;
  }

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.initialized) return;
      await this.storage.initialize();
      await fs.mkdir(this.downloadsRoot(), { recursive: true, mode: 0o700 });
      await this.recoverLocked();
      if (this.records.size > this.maxEntries) {
        throw new YifangyunError("Recovered downloads exceed the configured entry limit.", {
          code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
          details: { max_entries: this.maxEntries, recovered_entries: this.records.size },
          phase: "download_registry_initialize"
        });
      }
      await this.storage.validateUsage();
      this.initialized = true;
    });
  }

  async register(input: {
    fileName: string;
    identityRef: string;
    mediaType: string;
    sha1: string;
    sha256: string;
    sizeBytes: number;
    sourcePath: string;
  }): Promise<DownloadRecord> {
    await this.initialize();
    await this.mutex.run(async () => {
      if (this.closing) throw new YifangyunError("Download registry is closing.", { code: "YFY_DOWNLOAD_REGISTRY_CLOSED", phase: "download_register" });
      await this.pruneExpiredLocked(Date.now());
      if (this.records.size + this.pendingRegistrations >= this.maxEntries) {
        throw new YifangyunError("Download staging entry limit reached.", {
          code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
          details: { active_entries: this.records.size, max_entries: this.maxEntries, pending_entries: this.pendingRegistrations },
          phase: "download_register",
          suggestedAction: "Release completed downloads or wait for TTL cleanup before retrying."
        });
      }
      this.pendingRegistrations += 1;
    });
    const downloadId = `dl_${crypto.randomBytes(16).toString("hex")}`;
    const safeIdentity = input.identityRef.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "default";
    const directory = path.join(this.downloadsRoot(), safeIdentity, downloadId);
    const fileName = sanitizeFileName(input.fileName);
    const localPath = path.join(directory, fileName);
    const manifestPath = path.join(directory, "manifest.json");
    const record: StoredDownloadRecord = {
      accountedBytes: input.sizeBytes,
      activeReaders: 0,
      directory,
      downloadId,
      expiresAtMs: Date.now() + this.ttlSeconds * 1000,
      fileCtimeMs: Number.MAX_SAFE_INTEGER,
      fileName,
      fileMtimeMs: Number.MAX_SAFE_INTEGER,
      identityRef: input.identityRef,
      localPath,
      manifestPath,
      mediaType: input.mediaType,
      pendingDelete: false,
      remainingDownloads: this.maxDownloadsPerFile,
      sha1: input.sha1.toLowerCase(),
      sha256: input.sha256.toLowerCase(),
      sizeBytes: input.sizeBytes
    };
    const manifestReservationBytes = Buffer.byteLength(JSON.stringify(toManifest(record)));
    const sourceIsManaged = this.storage.isManagedPath(input.sourcePath);
    let reservation: Awaited<ReturnType<TempStorageManager["reserve"]>> | undefined;
    let directoryCreated = false;
    let moved = false;
    try {
      reservation = await this.storage.reserve((sourceIsManaged ? 0 : input.sizeBytes) + manifestReservationBytes);
      await this.storage.createDownloadDirectory(safeIdentity, downloadId);
      directoryCreated = true;
      await moveFile(input.sourcePath, localPath);
      moved = true;
      await fs.chmod(localPath, 0o600).catch(() => undefined);
      await verifyFileMetadata(localPath, input.sizeBytes);
      const finalStat = await fs.stat(localPath);
      record.fileCtimeMs = Math.trunc(finalStat.ctimeMs);
      record.fileMtimeMs = Math.trunc(finalStat.mtimeMs);
      record.expiresAtMs = Date.now() + this.ttlSeconds * 1000;
      const manifestText = JSON.stringify(toManifest(record));
      const manifestBytes = Buffer.byteLength(manifestText);
      record.accountedBytes = input.sizeBytes + manifestBytes;
      await writeManifest(manifestPath, manifestText);
      await this.mutex.run(async () => {
        if (this.closing) throw new YifangyunError("Download registry is closing.", { code: "YFY_DOWNLOAD_REGISTRY_CLOSED", phase: "download_register" });
        await reservation!.commit((sourceIsManaged ? 0 : input.sizeBytes) + manifestBytes);
        this.records.set(downloadId, record);
      });
      return publicRecord(record);
    } catch (error) {
      await reservation?.release();
      try {
        if (directoryCreated) await deleteTree(directory);
        if (!moved) await fs.rm(input.sourcePath, { force: true });
        if (sourceIsManaged) await this.storage.releaseUsed(input.sizeBytes);
      } catch {
        await this.storage.reconcile().catch(() => undefined);
        throw new YifangyunError("Failed download registration left temporary files that could not be removed.", {
          code: "YFY_DOWNLOAD_CLEANUP_FAILED",
          details: { download_id: downloadId },
          phase: "download_register_cleanup",
          retryable: true,
          suggestedAction: "Close local file handles, remove the failed directory under YFY_TEMP_DIR/downloads, and retry."
        });
      }
      throw error;
    } finally {
      await this.finishRegistration();
    }
  }

  get(downloadId: string): DownloadRecord | undefined {
    const record = this.records.get(downloadId);
    if (!record || record.pendingDelete || record.expiresAtMs <= Date.now()) return undefined;
    return publicRecord(record);
  }

  async acquireForHttpFetch(downloadId: string, signal?: AbortSignal): Promise<DownloadLease> {
    await this.initialize();
    let sourceHandle: FileHandle | undefined;
    let record!: StoredDownloadRecord;
    await this.mutex.run(async () => {
      if (signal?.aborted) throw requestCancelledError();
      record = this.records.get(downloadId)!;
      if (!record || record.pendingDelete || record.expiresAtMs <= Date.now()) {
        if (record && record.expiresAtMs <= Date.now()) await this.markForDeletionLocked(record);
        throw new YifangyunError("Download is unavailable or expired.", { code: "YFY_DOWNLOAD_NOT_FOUND", phase: "download_http" });
      }
      if (record.remainingDownloads <= 0) {
        throw new YifangyunError("Download fetch limit exceeded.", { code: "YFY_DOWNLOAD_FETCH_LIMIT", phase: "download_http" });
      }
      if (this.activeHttpLeases >= this.maxConcurrentHttpLeases) {
        throw new YifangyunError("Concurrent staged download limit reached.", {
          code: "YFY_DOWNLOAD_READ_CAPACITY",
          details: { active_reads: this.activeHttpLeases, max_concurrent_reads: this.maxConcurrentHttpLeases },
          phase: "download_http",
          retryable: true,
          suggestedAction: "Wait for an active staged download to finish, then retry."
        });
      }
      record.activeReaders += 1;
      this.activeHttpLeases += 1;
      record.remainingDownloads -= 1;
    });

    try {
      const before = await fs.lstat(record.localPath).catch(() => undefined);
      if (!before?.isFile() || before.isSymbolicLink()) throw downloadIntegrityError(record.downloadId, "download_http");
      sourceHandle = await fs.open(record.localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await sourceHandle.stat().catch(() => undefined);
      if (!opened?.isFile() || opened.size !== record.sizeBytes || Math.trunc(opened.ctimeMs) !== record.fileCtimeMs || Math.trunc(opened.mtimeMs) !== record.fileMtimeMs) {
        throw downloadIntegrityError(record.downloadId, "download_http");
      }
    } catch (error) {
      await sourceHandle?.close().catch(() => undefined);
      await this.mutex.run(() => this.markForDeletionLocked(record)).catch(() => undefined);
      await this.finishReader(record, true).catch(() => undefined);
      if (error instanceof YifangyunError) throw error;
      throw downloadIntegrityError(record.downloadId, "download_http");
    }

    let released = false;
    let streamCreated = false;
    return {
      record: publicRecord(record),
      createReadStream: () => {
        if (streamCreated) throw new Error("Download lease stream is no longer available.");
        streamCreated = true;
        const source = sourceHandle!.createReadStream({ autoClose: false, start: 0 });
        const registry = this;
        return Readable.from((async function* () {
          const sha1 = crypto.createHash("sha1");
          const sha256 = crypto.createHash("sha256");
          let sizeBytes = 0;
          for await (const chunk of source) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            sizeBytes += bytes.length;
            sha1.update(bytes);
            sha256.update(bytes);
            yield bytes;
          }
          const valid = sizeBytes === record.sizeBytes && sha1.digest("hex") === record.sha1 && sha256.digest("hex") === record.sha256;
          if (!valid) {
            await registry.mutex.run(() => registry.markForDeletionLocked(record)).catch(() => undefined);
            throw downloadIntegrityError(record.downloadId, "download_http_stream");
          }
        })());
      },
      release: async () => {
        if (released) return;
        released = true;
        await sourceHandle!.close().catch(() => undefined);
        await this.finishReader(record, true);
      }
    };
  }

  async readVerifiedBytes(downloadId: string, maxBytes: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Verified read limit must be a non-negative integer.");
    await this.initialize();
    let handle!: FileHandle;
    let record!: StoredDownloadRecord;
    const shouldRead = await this.mutex.run(async () => {
      record = this.records.get(downloadId)!;
      if (!record || record.pendingDelete || record.expiresAtMs <= Date.now()) {
        if (record && record.expiresAtMs <= Date.now()) await this.markForDeletionLocked(record);
        throw new YifangyunError("Download is unavailable or expired.", { code: "YFY_DOWNLOAD_NOT_FOUND", phase: "download_read" });
      }
      if (record.sizeBytes > maxBytes) return false;
      const before = await fs.lstat(record.localPath).catch(() => undefined);
      if (!before?.isFile() || before.isSymbolicLink()) {
        await this.markForDeletionLocked(record);
        throw downloadIntegrityError(record.downloadId, "download_read");
      }
      try {
        handle = await fs.open(record.localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch {
        await this.markForDeletionLocked(record);
        throw downloadIntegrityError(record.downloadId, "download_read");
      }
      const opened = await handle.stat().catch(() => undefined);
      if (!opened?.isFile() || opened.size !== record.sizeBytes || opened.size > maxBytes) {
        await handle.close().catch(() => undefined);
        await this.markForDeletionLocked(record);
        throw downloadIntegrityError(record.downloadId, "download_read");
      }
      record.activeReaders += 1;
      return true;
    });
    if (!shouldRead) return undefined;

    try {
      const verified = await readAndHashHandle(handle, record.sizeBytes);
      if (verified.sha1 !== record.sha1 || verified.sha256 !== record.sha256 || verified.sizeBytes !== record.sizeBytes) {
        await this.mutex.run(() => this.markForDeletionLocked(record));
        throw downloadIntegrityError(record.downloadId, "download_read");
      }
      return verified.bytes;
    } catch (error) {
      if (error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_READ_CAPACITY") throw error;
      if (!(error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED")) {
        await this.mutex.run(() => this.markForDeletionLocked(record)).catch(() => undefined);
      }
      if (error instanceof YifangyunError && error.code === "YFY_DOWNLOAD_INTEGRITY_FAILED") throw error;
      throw downloadIntegrityError(record.downloadId, "download_read");
    } finally {
      await handle.close().catch(() => undefined);
      await this.finishReader(record);
    }
  }

  async release(downloadId: string): Promise<boolean> {
    await this.initialize();
    return this.mutex.run(async () => {
      const record = this.records.get(downloadId);
      if (!record) return false;
      await this.markForDeletionLocked(record);
      return true;
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    if (!this.initialized) return;
    await this.waitForRegistrations();
    await this.mutex.run(async () => {
      const failures: string[] = [];
      for (const record of [...this.records.values()]) {
        try {
          await this.markForDeletionLocked(record);
        } catch {
          failures.push(record.downloadId);
        }
      }
      if (failures.length > 0) {
        throw new YifangyunError("Some temporary downloads could not be removed.", {
          code: "YFY_DOWNLOAD_CLEANUP_FAILED",
          details: { download_ids: failures },
          phase: "download_registry_close"
        });
      }
    });
  }

  private async finishRegistration(): Promise<void> {
    await this.mutex.run(() => {
      this.pendingRegistrations = Math.max(0, this.pendingRegistrations - 1);
      if (this.pendingRegistrations === 0) {
        for (const resolve of this.registrationDrainWaiters.splice(0)) resolve();
      }
    });
  }

  private waitForRegistrations(): Promise<void> {
    if (this.pendingRegistrations === 0) return Promise.resolve();
    return new Promise((resolve) => this.registrationDrainWaiters.push(resolve));
  }

  private async finishReader(record: StoredDownloadRecord, httpLease = false): Promise<void> {
    await this.mutex.run(async () => {
      record.activeReaders = Math.max(0, record.activeReaders - 1);
      if (httpLease) this.activeHttpLeases = Math.max(0, this.activeHttpLeases - 1);
      if (record.activeReaders === 0 && (record.pendingDelete || record.expiresAtMs <= Date.now())) await this.deleteRecordLocked(record);
    });
  }

  private async markForDeletionLocked(record: StoredDownloadRecord): Promise<void> {
    record.pendingDelete = true;
    await fs.rename(record.manifestPath, path.join(record.directory, "manifest.releasing")).catch((error) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    });
    if (record.activeReaders === 0) await this.deleteRecordLocked(record);
  }

  private async deleteRecordLocked(record: StoredDownloadRecord): Promise<void> {
    try {
      await deleteTree(record.directory);
    } catch (error) {
      throw new YifangyunError("Temporary download could not be removed.", {
        code: "YFY_DOWNLOAD_CLEANUP_FAILED",
        details: { download_id: record.downloadId },
        phase: "download_cleanup",
        retryable: true,
        suggestedAction: "Close any local parser still using the file and retry yfy_download_release."
      });
    }
    this.records.delete(record.downloadId);
    await this.storage.releaseUsed(record.accountedBytes);
  }

  private async pruneExpired(): Promise<void> {
    if (!this.initialized) return;
    await this.mutex.run(() => this.pruneExpiredLocked(Date.now()));
  }

  private async pruneExpiredLocked(now: number): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.pendingDelete || record.expiresAtMs <= now) await this.markForDeletionLocked(record).catch(() => undefined);
    }
  }

  private async recoverLocked(): Promise<void> {
    const identityEntries = await fs.readdir(this.downloadsRoot(), { withFileTypes: true });
    for (const identityEntry of identityEntries) {
      const identityPath = path.join(this.downloadsRoot(), identityEntry.name);
      if (!identityEntry.isDirectory() || !/^[a-zA-Z0-9._-]{1,64}$/.test(identityEntry.name)) continue;
      const downloadEntries = await fs.readdir(identityPath, { withFileTypes: true }).catch((error) => {
        if (isMissingError(error)) return [];
        throw error;
      });
      for (const downloadEntry of downloadEntries) {
        const directory = path.join(identityPath, downloadEntry.name);
        if (!downloadEntry.isDirectory() || !DOWNLOAD_ID_PATTERN.test(downloadEntry.name)) continue;
        const recovered = await recoverRecord(directory, this.maxDownloadsPerFile);
        if (!recovered || recovered.expiresAtMs <= Date.now()) {
          const removedBytes = await directoryBytes(directory);
          await deleteTree(directory);
          await this.storage.releaseUsed(removedBytes);
          continue;
        }
        this.records.set(recovered.downloadId, recovered);
      }
      const remaining = await fs.readdir(identityPath).catch((error) => {
        if (isMissingError(error)) return [];
        throw error;
      });
      if (remaining.length === 0) await fs.rmdir(identityPath).catch((error) => {
        if (!isMissingError(error)) throw error;
      });
    }
  }
}

async function recoverRecord(directory: string, maxDownloadsPerFile: number): Promise<StoredDownloadRecord | undefined> {
  const manifestPath = path.join(directory, "manifest.json");
  const manifestStat = await fs.lstat(manifestPath).catch((error) => {
    if (isMissingError(error)) return undefined;
    throw error;
  });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) return undefined;
  let raw: Partial<DownloadManifest>;
  try {
    raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<DownloadManifest>;
  } catch (error) {
    if (error instanceof SyntaxError || isMissingError(error)) return undefined;
    throw error;
  }
  if (raw.manifest_version !== MANIFEST_VERSION || !DOWNLOAD_ID_PATTERN.test(String(raw.download_id ?? "")) || path.basename(directory) !== raw.download_id) return undefined;
  if (!Number.isSafeInteger(raw.expires_at_ms) || !Number.isSafeInteger(raw.file_ctime_ms) || !Number.isSafeInteger(raw.file_mtime_ms) || !Number.isSafeInteger(raw.size_bytes)) return undefined;
  if (typeof raw.file_name !== "string" || raw.file_name !== sanitizeFileName(raw.file_name) || typeof raw.identity_ref !== "string" || typeof raw.media_type !== "string") return undefined;
  if (typeof raw.sha1 !== "string" || !/^[a-f\d]{40}$/i.test(raw.sha1) || typeof raw.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(raw.sha256)) return undefined;
  const localPath = path.join(directory, raw.file_name);
  if (!await verifyRecoveredFileMetadata(localPath, raw.size_bytes!, raw.file_ctime_ms!, raw.file_mtime_ms!)) return undefined;
  const expectedEntries = new Set(["manifest.json", raw.file_name]);
  const entries = await fs.readdir(directory);
  if (entries.length !== expectedEntries.size || entries.some((entry) => !expectedEntries.has(entry))) return undefined;
  return {
    accountedBytes: raw.size_bytes! + manifestStat.size,
    activeReaders: 0,
    directory,
    downloadId: raw.download_id!,
    expiresAtMs: raw.expires_at_ms!,
    fileCtimeMs: raw.file_ctime_ms!,
    fileName: raw.file_name,
    fileMtimeMs: raw.file_mtime_ms!,
    identityRef: raw.identity_ref,
    localPath,
    manifestPath,
    mediaType: raw.media_type,
    pendingDelete: false,
    remainingDownloads: maxDownloadsPerFile,
    sha1: raw.sha1.toLowerCase(),
    sha256: raw.sha256.toLowerCase(),
    sizeBytes: raw.size_bytes!
  };
}

function publicRecord(record: StoredDownloadRecord): DownloadRecord {
  return {
    downloadId: record.downloadId,
    expiresAtMs: record.expiresAtMs,
    fileName: record.fileName,
    identityRef: record.identityRef,
    localPath: record.localPath,
    mediaType: record.mediaType,
    remainingDownloads: record.remainingDownloads,
    sha1: record.sha1,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes
  };
}

function toManifest(record: StoredDownloadRecord): DownloadManifest {
  return {
    download_id: record.downloadId,
    expires_at_ms: record.expiresAtMs,
    file_ctime_ms: record.fileCtimeMs,
    file_name: record.fileName,
    file_mtime_ms: record.fileMtimeMs,
    identity_ref: record.identityRef,
    manifest_version: MANIFEST_VERSION,
    media_type: record.mediaType,
    sha1: record.sha1,
    sha256: record.sha256,
    size_bytes: record.sizeBytes
  };
}

async function writeManifest(manifestPath: string, text: string): Promise<void> {
  const temporary = `${manifestPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, manifestPath).catch(async (error) => {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  });
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  await fs.rename(sourcePath, targetPath).catch(async (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EXDEV") {
      await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      await fs.rm(sourcePath, { force: true });
      return;
    }
    throw error;
  });
}

async function verifyFileMetadata(filePath: string, sizeBytes: number): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== sizeBytes) throw new Error("Download source is not the expected regular file.");
}

async function verifyRecoveredFileMetadata(filePath: string, sizeBytes: number, ctimeMs: number, mtimeMs: number): Promise<boolean> {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (isMissingError(error)) return undefined;
    throw error;
  });
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.size === sizeBytes && Math.trunc(stat.ctimeMs) === ctimeMs && Math.trunc(stat.mtimeMs) === mtimeMs);
}

async function readAndHashHandle(handle: FileHandle, maxBytes: number): Promise<{ bytes: Buffer; sha1: string; sha256: string; sizeBytes: number }> {
  let output: Buffer;
  try {
    output = Buffer.allocUnsafe(maxBytes);
  } catch {
    throw new YifangyunError("Verified download buffer could not be allocated.", {
      code: "YFY_DOWNLOAD_READ_CAPACITY",
      details: { requested_bytes: maxBytes },
      phase: "download_read",
      retryable: true
    });
  }
  const sha1 = crypto.createHash("sha1");
  const sha256 = crypto.createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
    const bytes = Buffer.from(chunk);
    if (sizeBytes + bytes.length > maxBytes) throw new Error("Verified read exceeded its byte limit.");
    bytes.copy(output, sizeBytes);
    sizeBytes += bytes.length;
    sha1.update(bytes);
    sha256.update(bytes);
  }
  return { bytes: output.subarray(0, sizeBytes), sha1: sha1.digest("hex"), sha256: sha256.digest("hex"), sizeBytes };
}

function requestCancelledError(): YifangyunError {
  return new YifangyunError("Staged download request was cancelled.", { code: "YFY_REQUEST_CANCELLED", phase: "download_http" });
}

function isMissingError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function downloadIntegrityError(downloadId: string, phase: string): YifangyunError {
  return new YifangyunError("Download file integrity check failed.", {
    code: "YFY_DOWNLOAD_INTEGRITY_FAILED",
    details: { download_id: downloadId },
    phase
  });
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await fs.stat(entryPath).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

async function deleteTree(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
      return;
    } catch (error) {
      const retryable = Boolean(error && typeof error === "object" && "code" in error && ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(String(error.code)));
      if (!retryable || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function sanitizeFileName(name: string): string {
  let base = path.basename(name).replace(/[\x00-\x1f\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().replace(/[ .]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  if (["manifest.json", "manifest.releasing"].includes(base.toLowerCase())) base = `_${base}`;
  return base || "download.bin";
}
