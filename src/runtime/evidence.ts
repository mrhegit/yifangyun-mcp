import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { YifangyunError } from "../client.js";

interface EvidenceArtifact {
  expectedSha256: string;
  expectedSize: number;
  expiresAtMs: number;
  mimeType?: string;
  name: string;
  path: string;
}

export class EvidenceArtifactRegistry {
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private closing = false;
  private lastPruneAtMs = 0;

  constructor(
    private readonly ttlSeconds: number,
    private readonly maxResourceBytes: number,
    private readonly maxEntries = 10_000
  ) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("Evidence resource TTL must be a positive integer.");
    }
    const intervalMs = Math.min(Math.max(ttlSeconds * 1000, 1000), 60_000);
    this.cleanupTimer = setInterval(() => void this.pruneExpired(Date.now(), true).catch(() => undefined), intervalMs);
    this.cleanupTimer.unref();
  }

  async register(input: Omit<EvidenceArtifact, "expiresAtMs">): Promise<string> {
    if (this.closing) throw new YifangyunError("Evidence registry is closing.", { code: "YFY_EVIDENCE_REGISTRY_CLOSED", phase: "evidence_resource" });
    await this.pruneExpired();
    if (this.closing) throw new YifangyunError("Evidence registry is closing.", { code: "YFY_EVIDENCE_REGISTRY_CLOSED", phase: "evidence_resource" });
    while (this.artifacts.size >= this.maxEntries) {
      const oldest = this.artifacts.keys().next().value as string | undefined;
      if (!oldest) break;
      const artifact = this.artifacts.get(oldest);
      if (artifact) await this.deleteArtifact(oldest, artifact);
    }
    if (this.closing) throw new YifangyunError("Evidence registry is closing.", { code: "YFY_EVIDENCE_REGISTRY_CLOSED", phase: "evidence_resource" });
    const token = crypto.randomBytes(24).toString("hex");
    this.artifacts.set(token, { ...input, expiresAtMs: this.ttlSeconds > 0 ? Date.now() + this.ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER });
    return `yfy://evidence/${token}`;
  }

  async read(token: string): Promise<{ kind: "blob"; blob: string; mimeType?: string; name: string } | { kind: "text"; text: string; mimeType?: string; name: string }> {
    const artifact = this.artifacts.get(token);
    if (!artifact || artifact.expiresAtMs <= Date.now()) {
      if (artifact) await this.deleteArtifact(token, artifact);
      throw new YifangyunError("Evidence artifact is unavailable or expired.", { code: "YFY_EVIDENCE_ARTIFACT_NOT_FOUND", phase: "evidence_resource" });
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const pathStat = await fs.lstat(artifact.path);
      if (pathStat.isSymbolicLink()) throw new Error("Evidence artifact path must not be a symbolic link.");
      handle = await fs.open(artifact.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Evidence artifact path is not a file.");
      if (stat.size !== artifact.expectedSize) throw new Error("Evidence artifact size changed after registration.");
      if (stat.size > this.maxResourceBytes) {
        throw new YifangyunError("Evidence artifact exceeds the MCP resource size limit.", {
          code: "YFY_EVIDENCE_RESOURCE_TOO_LARGE",
          details: { max_resource_bytes: this.maxResourceBytes, size_bytes: stat.size },
          phase: "evidence_resource",
          suggestedAction: "Capture a smaller file or raise the configured MCP resource limit within the download limit."
        });
      }
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const result = await handle.read(content, offset, content.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const bytes = content.subarray(0, offset);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== artifact.expectedSha256) throw new Error("Evidence artifact hash changed after registration.");
      const textMedia = artifact.mimeType?.startsWith("text/")
        || artifact.mimeType === "application/json"
        || artifact.mimeType === "application/xml"
        || artifact.mimeType?.endsWith("+json")
        || artifact.mimeType?.endsWith("+xml");
      if (textMedia) {
        try {
          return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}), name: artifact.name };
        } catch {
          // Invalid UTF-8 remains available as the verified original byte representation.
        }
      }
      return { kind: "blob", blob: bytes.toString("base64"), ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}), name: artifact.name };
    } catch (error) {
      if (error instanceof YifangyunError) throw error;
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await this.deleteArtifact(token, artifact);
      throw new YifangyunError("Evidence artifact integrity verification failed.", { code: "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED", phase: "evidence_resource" });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async manifest(token: string): Promise<{ mimeType?: string; name: string; partCount: number; partSizeBytes: number; sizeBytes: number }> {
    const artifact = await this.availableArtifact(token);
    return {
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      name: artifact.name,
      partCount: Math.ceil(artifact.expectedSize / this.maxResourceBytes),
      partSizeBytes: this.maxResourceBytes,
      sizeBytes: artifact.expectedSize
    };
  }

  async readPart(token: string, part: number): Promise<{ blob: string; mimeType?: string; name: string }> {
    const artifact = await this.availableArtifact(token);
    const partCount = Math.ceil(artifact.expectedSize / this.maxResourceBytes);
    if (!Number.isInteger(part) || part < 0 || part >= partCount) {
      throw new YifangyunError("Evidence resource part is invalid.", { code: "YFY_INPUT_INVALID", phase: "evidence_resource" });
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const pathStat = await fs.lstat(artifact.path);
      if (pathStat.isSymbolicLink()) throw new Error("Evidence artifact path must not be a symbolic link.");
      handle = await fs.open(artifact.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.expectedSize) throw new Error("Evidence artifact changed after registration.");
      const start = part * this.maxResourceBytes;
      const end = Math.min(stat.size, start + this.maxResourceBytes);
      const selected = Buffer.alloc(end - start);
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(Math.min(1_048_576, Math.max(1, stat.size)));
      let offset = 0;
      while (offset < stat.size) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (result.bytesRead === 0) break;
        const bytes = buffer.subarray(0, result.bytesRead);
        hash.update(bytes);
        const overlapStart = Math.max(offset, start);
        const overlapEnd = Math.min(offset + result.bytesRead, end);
        if (overlapStart < overlapEnd) bytes.copy(selected, overlapStart - start, overlapStart - offset, overlapEnd - offset);
        offset += result.bytesRead;
      }
      if (offset !== stat.size || hash.digest("hex") !== artifact.expectedSha256) throw new Error("Evidence artifact hash changed after registration.");
      return { blob: selected.toString("base64"), ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}), name: `${artifact.name}.part-${part}` };
    } catch (error) {
      if (error instanceof YifangyunError) throw error;
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await this.deleteArtifact(token, artifact);
      throw new YifangyunError("Evidence artifact integrity verification failed.", { code: "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED", phase: "evidence_resource" });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async release(resourceUriOrToken: string): Promise<boolean> {
    const token = /^yfy:\/\/evidence\/([a-f0-9]{48})(?:\/.*)?$/.exec(resourceUriOrToken)?.[1] ?? resourceUriOrToken;
    const artifact = this.artifacts.get(token);
    if (!artifact) return false;
    if (artifact.expiresAtMs <= Date.now()) {
      await this.deleteArtifact(token, artifact);
      return false;
    }
    await this.deleteArtifact(token, artifact, "YFY_EVIDENCE_RELEASE_FAILED", "evidence_release");
    return true;
  }

  private async availableArtifact(token: string): Promise<EvidenceArtifact> {
    const artifact = this.artifacts.get(token);
    if (!artifact || artifact.expiresAtMs <= Date.now()) {
      if (artifact) await this.deleteArtifact(token, artifact);
      throw new YifangyunError("Evidence artifact is unavailable or expired.", { code: "YFY_EVIDENCE_ARTIFACT_NOT_FOUND", phase: "evidence_resource" });
    }
    return artifact;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    const failures: string[] = [];
    await Promise.all([...this.artifacts].map(async ([token, artifact]) => {
      try {
        await this.deleteArtifact(token, artifact);
      } catch {
        failures.push(token);
      }
    }));
    if (failures.length > 0) {
      throw new YifangyunError("One or more evidence artifacts could not be deleted during shutdown.", {
        code: "YFY_EVIDENCE_CLEANUP_FAILED",
        phase: "evidence_shutdown",
        details: { failure_count: failures.length }
      });
    }
  }

  private async deleteArtifact(token: string, artifact: EvidenceArtifact, code = "YFY_EVIDENCE_CLEANUP_FAILED", phase = "evidence_cleanup"): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rm(artifact.path, { force: true });
        if (this.artifacts.get(token) === artifact) this.artifacts.delete(token);
        return;
      } catch (error) {
        const retryable = Boolean(error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EBUSY"));
        if (!retryable || attempt === 2) throw new YifangyunError("Evidence artifact could not be deleted.", { code, phase, retryable });
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }

  private async pruneExpired(now = Date.now(), force = false): Promise<void> {
    if (!force && now - this.lastPruneAtMs < 1000) return;
    this.lastPruneAtMs = now;
    for (const [token, artifact] of this.artifacts) {
      if (artifact.expiresAtMs <= now) await this.deleteArtifact(token, artifact).catch(() => undefined);
    }
  }
}
