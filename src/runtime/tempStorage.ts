import { promises as fs } from "node:fs";
import path from "node:path";
import { YifangyunError } from "../errors.js";

export interface TempReservation {
  bytes: number;
  commit(actualBytes: number): Promise<void>;
  release(): Promise<void>;
}

interface ManagedDirectoryIdentity {
  device: bigint;
  inode: bigint;
  realPath: string;
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

export class TempStorageManager {
  private artifactsIdentity?: ManagedDirectoryIdentity;
  private downloadsIdentity?: ManagedDirectoryIdentity;
  private initialized = false;
  private readonly mutex = new AsyncMutex();
  private reservedBytes = 0;
  private rootIdentity?: ManagedDirectoryIdentity;
  private usedBytes = 0;

  constructor(
    readonly rootDir: string,
    private readonly maxBytes: number,
    private readonly ttlSeconds: number
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Temporary storage limit must be a positive integer.");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("Temporary storage TTL must be a positive integer.");
  }

  artifactsRoot(): string {
    return path.join(this.rootDir, "artifacts");
  }

  downloadsRoot(): string {
    return path.join(this.rootDir, "downloads");
  }

  async ensureArtifactNamespace(namespace: string): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw unsafeTempDirectory(namespace);
    await this.initialize();
    const target = path.join(this.artifactsRoot(), namespace);
    return this.mutex.run(async () => {
      await this.validateManagedRootsLocked();
      await ensureSafeChildDirectory(this.artifactsRoot(), namespace, false);
      return target;
    });
  }

  async createDownloadDirectory(identity: string, downloadId: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(identity) || !/^dl_[a-f0-9]{32}$/.test(downloadId)) throw unsafeTempDirectory(`${identity}/${downloadId}`);
    await this.initialize();
    return this.mutex.run(async () => {
      await this.validateManagedRootsLocked();
      const identityDirectory = path.join(this.downloadsRoot(), identity);
      await ensureSafeChildDirectory(this.downloadsRoot(), identity, false);
      return ensureSafeChildDirectory(identityDirectory, downloadId, true);
    });
  }

  async initialize(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.initialized) return;
      await ensureSafeDirectory(this.rootDir);
      this.rootIdentity = await captureDirectoryIdentity(this.rootDir);
      for (const managedRoot of [this.artifactsRoot(), this.downloadsRoot()]) {
        await ensureSafeDirectory(managedRoot);
        const managedIdentity = await captureDirectoryIdentity(managedRoot);
        const relative = path.relative(this.rootIdentity.realPath, managedIdentity.realPath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw unsafeTempDirectory(managedRoot);
        }
        if (managedRoot === this.artifactsRoot()) this.artifactsIdentity = managedIdentity;
        else this.downloadsIdentity = managedIdentity;
      }
      await this.pruneArtifactsLocked();
      this.usedBytes = await this.directoryFileBytes(this.artifactsRoot()) + await this.directoryFileBytes(this.downloadsRoot());
      this.initialized = true;
    });
  }

  async validateUsage(): Promise<void> {
    await this.initialize();
    await this.mutex.run(() => this.assertWithinLimit());
  }

  async reserve(bytes: number): Promise<TempReservation> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Temporary storage reservation must be a non-negative integer.");
    await this.initialize();
    await this.mutex.run(async () => {
      await this.validateManagedRootsLocked();
      if (this.usedBytes + this.reservedBytes + bytes > this.maxBytes && this.reservedBytes === 0) {
        await this.pruneArtifactsLocked();
        this.usedBytes = await this.directoryFileBytes(this.artifactsRoot()) + await this.directoryFileBytes(this.downloadsRoot());
      }
      if (this.usedBytes + this.reservedBytes + bytes > this.maxBytes) {
        throw new YifangyunError("Local temporary storage quota would be exceeded.", {
          code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
          details: { incoming_bytes: bytes, max_temp_bytes: this.maxBytes, reserved_bytes: this.reservedBytes, used_bytes: this.usedBytes },
          phase: "temp_storage"
        });
      }
      this.reservedBytes += bytes;
    });
    let completed = false;
    return {
      bytes,
      commit: async (actualBytes: number) => {
        if (!Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > bytes) {
          throw new Error("Committed temporary storage bytes must fit the reservation.");
        }
        await this.mutex.run(() => {
          if (completed) return;
          completed = true;
          this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
          this.usedBytes += actualBytes;
          this.assertWithinLimit();
        });
      },
      release: async () => {
        await this.mutex.run(() => {
          if (completed) return;
          completed = true;
          this.reservedBytes = Math.max(0, this.reservedBytes - bytes);
        });
      }
    };
  }

  async releaseUsed(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    await this.mutex.run(() => { this.usedBytes = Math.max(0, this.usedBytes - bytes); });
  }

  async reconcile(): Promise<void> {
    await this.initialize();
    await this.mutex.run(async () => {
      await this.validateManagedRootsLocked();
      this.usedBytes = await this.directoryFileBytes(this.artifactsRoot()) + await this.directoryFileBytes(this.downloadsRoot());
      this.assertWithinLimit();
    });
  }

  async pruneArtifacts(): Promise<void> {
    await this.initialize();
    await this.mutex.run(async () => {
      await this.validateManagedRootsLocked();
      if (this.reservedBytes > 0) return;
      const removedBytes = await this.pruneArtifactsLocked();
      this.usedBytes = Math.max(0, this.usedBytes - removedBytes);
    });
  }

  isManagedPath(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    return [this.artifactsRoot(), this.downloadsRoot()].some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  }

  usage(): { max_bytes: number; reserved_bytes: number; used_bytes: number } {
    return { max_bytes: this.maxBytes, reserved_bytes: this.reservedBytes, used_bytes: this.usedBytes };
  }

  private assertWithinLimit(): void {
    if (this.usedBytes + this.reservedBytes > this.maxBytes) {
      throw new YifangyunError("Existing temporary files exceed YFY_MAX_TEMP_BYTES.", {
        code: "YFY_LOCAL_STORAGE_INSUFFICIENT",
        details: { max_temp_bytes: this.maxBytes, reserved_bytes: this.reservedBytes, used_bytes: this.usedBytes },
        phase: "temp_storage_initialize",
        suggestedAction: "Remove expired files from YFY_TEMP_DIR or raise YFY_MAX_TEMP_BYTES before restarting."
      });
    }
  }

  private async validateManagedRootsLocked(): Promise<void> {
    if (!this.rootIdentity || !this.artifactsIdentity || !this.downloadsIdentity) throw unsafeTempDirectory(this.rootDir);
    await assertDirectoryIdentity(this.rootDir, this.rootIdentity);
    await assertDirectoryIdentity(this.artifactsRoot(), this.artifactsIdentity);
    await assertDirectoryIdentity(this.downloadsRoot(), this.downloadsIdentity);
  }

  private async pruneArtifactsLocked(): Promise<number> {
    const cutoffMs = Date.now() - this.ttlSeconds * 1000;
    return this.pruneDirectory(this.artifactsRoot(), cutoffMs);
  }

  private async directoryFileBytes(directory: string): Promise<number> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) total += await this.directoryFileBytes(entryPath);
      else if (entry.isFile()) total += (await fs.stat(entryPath).catch(() => undefined))?.size ?? 0;
    }
    return total;
  }

  private async pruneDirectory(directory: string, cutoffMs: number): Promise<number> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let removedBytes = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        removedBytes += await this.pruneDirectory(entryPath, cutoffMs);
        if ((await fs.readdir(entryPath).catch(() => [])).length === 0) await fs.rmdir(entryPath).catch(() => undefined);
      } else if (entry.isFile()) {
        const stat = await fs.stat(entryPath).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoffMs) {
          const removed = await fs.rm(entryPath, { force: true }).then(() => true, () => false);
          if (removed) removedBytes += stat.size;
        }
      }
    }
    return removedBytes;
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  const before = await fs.lstat(directory).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before && (!before.isDirectory() || before.isSymbolicLink())) throw unsafeTempDirectory(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const after = await fs.lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink()) throw unsafeTempDirectory(directory);
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function captureDirectoryIdentity(directory: string): Promise<ManagedDirectoryIdentity> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeTempDirectory(directory);
  return { device: stat.dev, inode: stat.ino, realPath: await fs.realpath(directory) };
}

async function assertDirectoryIdentity(directory: string, expected: ManagedDirectoryIdentity): Promise<void> {
  const actual = await captureDirectoryIdentity(directory);
  if (actual.device !== expected.device || actual.inode !== expected.inode || actual.realPath !== expected.realPath) {
    throw unsafeTempDirectory(directory);
  }
}

function unsafeTempDirectory(directory: string): YifangyunError {
  return new YifangyunError("Managed temporary directories must be ordinary directories, not files, symbolic links or junctions.", {
    code: "YFY_TEMP_STORAGE_CONFIG_UNSAFE",
    details: { directory },
    phase: "temp_storage_initialize",
    suggestedAction: "Remove the unsafe path or configure YFY_TEMP_DIR to a private directory owned by the server account."
  });
}

async function ensureSafeChildDirectory(parent: string, name: string, exclusive: boolean): Promise<string> {
  const target = path.join(parent, name);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw unsafeTempDirectory(target);
  if (exclusive) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw unsafeTempDirectory(target);
      throw error;
    }
  } else {
    await ensureSafeDirectory(target);
  }
  const [realParent, realTarget] = await Promise.all([fs.realpath(parent), fs.realpath(target)]);
  const realRelative = path.relative(realParent, realTarget);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw unsafeTempDirectory(target);
  return target;
}
