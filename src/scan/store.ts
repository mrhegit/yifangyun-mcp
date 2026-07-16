import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScopePageArtifact, ScopeScanState } from "./types.js";
import { YifangyunError } from "../client.js";

interface PendingPageCommit {
  artifact: ScopePageArtifact;
  state: ScopeScanState;
  version: 1;
}

export class ScopeScanStore {
  private readonly activeCommits = new Set<string>();
  private readonly locks = new Map<string, Promise<void>>();
  private quotaTail: Promise<void> = Promise.resolve();
  private usedBytes?: number;

  constructor(private readonly rootDir: string, private readonly ttlSeconds: number, private readonly maxBytes = Number.MAX_SAFE_INTEGER) {}

  async create(state: ScopeScanState): Promise<void> {
    await this.ensurePrivateDir(this.pageDir(state.scanId));
    await this.save(state);
  }

  async load(scanId: string): Promise<ScopeScanState> {
    if (!this.activeCommits.has(scanId)) {
      await this.withQuotaLock(() => this.recoverPendingCommit(scanId));
    }
    const text = await fs.readFile(this.statePath(scanId), "utf8");
    return JSON.parse(text) as ScopeScanState;
  }

  async save(state: ScopeScanState): Promise<void> {
    await this.withQuotaLock(async () => {
      const dir = this.scanDir(state.scanId);
      await this.ensurePrivateDir(dir);
      const target = this.statePath(state.scanId);
      const content = JSON.stringify(state, null, 2);
      const incomingBytes = Buffer.byteLength(content);
      const existingBytes = await this.fileBytes(target);
      const projectedBytes = await this.projectedBytes(existingBytes, incomingBytes);
      this.assertCapacity(projectedBytes, incomingBytes - existingBytes);
      await this.atomicReplace(target, content);
      this.usedBytes = projectedBytes;
    });
  }

  async withLock<T>(scanId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(scanId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.locks.set(scanId, chain);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(scanId) === chain) {
        this.locks.delete(scanId);
      }
    }
  }

  async commitPage(scanId: string, artifact: ScopePageArtifact, state: ScopeScanState): Promise<void> {
    this.activeCommits.add(scanId);
    let transactionWritten = false;
    try {
      await this.withQuotaLock(async () => {
        await this.recoverPendingCommit(scanId);
        await this.ensurePrivateDir(this.pageDir(scanId));
        const pageTarget = this.pagePath(scanId, artifact.pageKey);
        const stateTarget = this.statePath(scanId);
        const transactionTarget = this.transactionPath(scanId);
        const pageContent = JSON.stringify(artifact);
        const stateContent = JSON.stringify(state, null, 2);
        const pageBytes = Buffer.byteLength(pageContent);
        const stateBytes = Buffer.byteLength(stateContent);
        const existingPageBytes = await this.fileBytes(pageTarget);
        const existingStateBytes = await this.fileBytes(stateTarget);
        const usedBytes = this.usedBytes ?? await this.directoryBytes(this.rootDir);
        const projectedBytes = usedBytes - existingPageBytes - existingStateBytes + pageBytes + stateBytes;
        this.assertCapacity(projectedBytes, pageBytes + stateBytes - existingPageBytes - existingStateBytes);

        const transaction: PendingPageCommit = { artifact, state, version: 1 };
        await this.atomicReplace(transactionTarget, JSON.stringify(transaction));
        transactionWritten = true;
        await this.atomicReplace(pageTarget, pageContent);
        await this.atomicReplace(stateTarget, stateContent);
        await fs.rm(transactionTarget, { force: true });
        this.usedBytes = projectedBytes;
      });
    } catch (error) {
      this.usedBytes = undefined;
      if (transactionWritten) {
        throw new YifangyunError("Scope scan page commit is pending recovery.", {
          code: "YFY_SCAN_COMMIT_PENDING",
          details: { cause: error instanceof Error ? error.message : String(error) },
          phase: "scan_storage",
          retryable: true,
          scanId,
          suggestedAction: "Call yfy_get_scope_scan to recover the pending commit, then resume with the returned revision."
        });
      }
      throw error;
    } finally {
      this.activeCommits.delete(scanId);
    }
  }

  async listPages(scanId: string): Promise<ScopePageArtifact[]> {
    if (!this.activeCommits.has(scanId)) {
      await this.withQuotaLock(() => this.recoverPendingCommit(scanId));
    }
    const entries = await fs.readdir(this.pageDir(scanId), { withFileTypes: true }).catch(() => []);
    const pages: ScopePageArtifact[] = [];
    for (const entry of entries.filter((value) => value.isFile() && value.name.endsWith(".json"))) {
      const text = await fs.readFile(path.join(this.pageDir(scanId), entry.name), "utf8");
      pages.push(JSON.parse(text) as ScopePageArtifact);
    }
    return pages.sort((left, right) => left.pageKey.localeCompare(right.pageKey));
  }

  async findReusable(accessIdentityRef: string, rootFolderId: string, policyHash: string): Promise<ScopeScanState | undefined> {
    await this.ensurePrivateDir(this.rootDir);
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const candidates: ScopeScanState[] = [];
    for (const entry of entries.filter((value) => value.isDirectory())) {
      const state = await this.load(entry.name).catch(() => undefined);
      if (state && state.accessIdentityRef === accessIdentityRef && state.rootFolderId === rootFolderId && state.policyHash === policyHash
        && !["cancelled", "failed", "expired"].includes(state.status) && Date.parse(state.expiresAt) > Date.now()) {
        candidates.push(state);
      }
    }
    return candidates.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  }

  async pruneExpired(): Promise<void> {
    await this.withQuotaLock(async () => {
      await this.ensurePrivateDir(this.rootDir);
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
      let removed = false;
      for (const entry of entries.filter((value) => value.isDirectory())) {
        if (this.locks.has(entry.name) || this.activeCommits.has(entry.name)) {
          continue;
        }
        const state = await this.readStateWithoutRecovery(entry.name).catch(() => undefined);
        if (!state || Date.parse(state.expiresAt) <= Date.now()) {
          await fs.rm(this.scanDir(entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => undefined);
          removed = true;
        }
      }
      if (removed) {
        this.usedBytes = undefined;
      }
    });
  }

  makeExpiry(now = Date.now()): string {
    return new Date(now + this.ttlSeconds * 1000).toISOString();
  }

  private scanDir(scanId: string): string {
    return path.join(this.rootDir, scanId);
  }

  private statePath(scanId: string): string {
    return path.join(this.scanDir(scanId), "state.json");
  }

  private pageDir(scanId: string): string {
    return path.join(this.scanDir(scanId), "pages");
  }

  private pagePath(scanId: string, pageKey: string): string {
    return path.join(this.pageDir(scanId), `${crypto.createHash("sha256").update(pageKey).digest("hex")}.json`);
  }

  private transactionPath(scanId: string): string {
    return path.join(this.scanDir(scanId), "pending-page-commit.json");
  }

  private async ensurePrivateDir(directory: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => undefined);
  }

  private assertCapacity(projectedBytes: number, incomingBytes: number): void {
    if (projectedBytes > this.maxBytes) {
      throw new YifangyunError("Scope scan storage quota would be exceeded.", {
        code: "YFY_SCAN_STORAGE_INSUFFICIENT",
        details: { incoming_bytes: Math.max(0, incomingBytes), max_scan_bytes: this.maxBytes, projected_bytes: projectedBytes },
        phase: "scan_storage"
      });
    }
  }

  private async atomicReplace(target: string, content: string): Promise<void> {
    const temp = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async fileBytes(target: string): Promise<number> {
    return (await fs.stat(target).catch(() => undefined))?.size ?? 0;
  }

  private async projectedBytes(existingBytes: number, incomingBytes: number): Promise<number> {
    const usedBytes = this.usedBytes ?? await this.directoryBytes(this.rootDir);
    return usedBytes - existingBytes + incomingBytes;
  }

  private async readStateWithoutRecovery(scanId: string): Promise<ScopeScanState> {
    const text = await fs.readFile(this.statePath(scanId), "utf8");
    return JSON.parse(text) as ScopeScanState;
  }

  private async recoverPendingCommit(scanId: string): Promise<void> {
    const transactionTarget = this.transactionPath(scanId);
    const text = await fs.readFile(transactionTarget, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (text === undefined) {
      return;
    }
    try {
      const transaction = JSON.parse(text) as PendingPageCommit;
      if (transaction.version !== 1 || transaction.state.scanId !== scanId || transaction.artifact.pageKey.length === 0) {
        throw new Error("Pending page commit is invalid.");
      }
      await this.ensurePrivateDir(this.pageDir(scanId));
      await this.atomicReplace(this.pagePath(scanId, transaction.artifact.pageKey), JSON.stringify(transaction.artifact));
      await this.atomicReplace(this.statePath(scanId), JSON.stringify(transaction.state, null, 2));
      await fs.rm(transactionTarget, { force: true });
      this.usedBytes = undefined;
    } catch (error) {
      throw new YifangyunError("Scope scan pending commit could not be recovered.", {
        code: "YFY_SCAN_COMMIT_RECOVERY_FAILED",
        details: { cause: error instanceof Error ? error.message : String(error) },
        phase: "scan_storage",
        retryable: true,
        scanId
      });
    }
  }

  private async withQuotaLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.quotaTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.quotaTail = previous.then(() => current);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async directoryBytes(directory: string): Promise<number> {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        total += await this.directoryBytes(entryPath);
      } else if (entry.isFile() && entry.name !== "pending-page-commit.json") {
        total += (await fs.stat(entryPath).catch(() => undefined))?.size ?? 0;
      }
    }
    return total;
  }
}
