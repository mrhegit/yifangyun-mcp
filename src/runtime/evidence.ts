import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { YifangyunError } from "../client.js";

interface EvidenceArtifact {
  expiresAtMs: number;
  mimeType?: string;
  name: string;
  path: string;
}

export class EvidenceArtifactRegistry {
  private readonly artifacts = new Map<string, EvidenceArtifact>();
  private readonly cleanupTimer: NodeJS.Timeout;
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
    this.cleanupTimer = setInterval(() => this.pruneExpired(Date.now(), true), intervalMs);
    this.cleanupTimer.unref();
  }

  register(input: Omit<EvidenceArtifact, "expiresAtMs">): string {
    this.pruneExpired();
    while (this.artifacts.size >= this.maxEntries) {
      const oldest = this.artifacts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.artifacts.delete(oldest);
    }
    const token = crypto.randomBytes(24).toString("hex");
    this.artifacts.set(token, { ...input, expiresAtMs: this.ttlSeconds > 0 ? Date.now() + this.ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER });
    return `yfy://evidence/${token}`;
  }

  async read(token: string): Promise<{ blob: string; mimeType?: string; name: string }> {
    const artifact = this.artifacts.get(token);
    if (!artifact || artifact.expiresAtMs <= Date.now()) {
      this.artifacts.delete(token);
      throw new YifangyunError("Evidence artifact is unavailable or expired.", { code: "YFY_EVIDENCE_ARTIFACT_NOT_FOUND", phase: "evidence_resource" });
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(artifact.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("Evidence artifact path is not a file.");
      if (stat.size > this.maxResourceBytes) {
        throw new YifangyunError("Evidence artifact exceeds the MCP resource size limit.", {
          code: "YFY_EVIDENCE_RESOURCE_TOO_LARGE",
          details: { max_resource_bytes: this.maxResourceBytes, size_bytes: stat.size },
          phase: "evidence_resource",
          suggestedAction: "Use temp_path from a local stdio client, or capture a smaller file for remote MCP resource transfer."
        });
      }
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const result = await handle.read(content, offset, content.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return { blob: content.subarray(0, offset).toString("base64"), ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}), name: artifact.name };
    } catch (error) {
      if (error instanceof YifangyunError) throw error;
      this.artifacts.delete(token);
      throw new YifangyunError("Evidence artifact file is unavailable.", { code: "YFY_EVIDENCE_ARTIFACT_NOT_FOUND", phase: "evidence_resource" });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    this.artifacts.clear();
  }

  private pruneExpired(now = Date.now(), force = false): void {
    if (!force && now - this.lastPruneAtMs < 1000) return;
    this.lastPruneAtMs = now;
    for (const [token, artifact] of this.artifacts) {
      if (artifact.expiresAtMs <= now) this.artifacts.delete(token);
    }
  }
}
