import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EvidenceArtifactRegistry } from "./runtime/evidence.js";

test("evidence registry exposes short-lived bytes through an opaque resource token", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-resource-"));
  const filePath = path.join(dir, "evidence.txt");
  await fs.writeFile(filePath, "evidence", { mode: 0o600 });
  const registry = new EvidenceArtifactRegistry(60, 1024);
  try {
    const uri = registry.register({ path: filePath, name: "evidence.txt", mimeType: "text/plain" });
    assert.match(uri, /^yfy:\/\/evidence\/[a-f0-9]{48}$/);
    const artifact = await registry.read(uri.split("/").at(-1)!);
    assert.equal(Buffer.from(artifact.blob, "base64").toString("utf8"), "evidence");
    assert.equal(artifact.mimeType, "text/plain");
  } finally {
    registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry rejects oversized resources before allocating content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-resource-limit-"));
  const filePath = path.join(dir, "large.bin");
  await fs.writeFile(filePath, Buffer.alloc(32), { mode: 0o600 });
  const registry = new EvidenceArtifactRegistry(60, 16);
  try {
    const uri = registry.register({ path: filePath, name: "large.bin" });
    await assert.rejects(() => registry.read(uri.split("/").at(-1)!), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_RESOURCE_TOO_LARGE"));
  } finally {
    registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry evicts old tokens at its capacity", async () => {
  const registry = new EvidenceArtifactRegistry(60, 1024, 2);
  try {
    const first = registry.register({ name: "first", path: "first" });
    registry.register({ name: "second", path: "second" });
    registry.register({ name: "third", path: "third" });
    await assert.rejects(() => registry.read(first.split("/").at(-1)!), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_ARTIFACT_NOT_FOUND"));
  } finally {
    registry.close();
  }
});

test("evidence registry rejects a non-expiring resource TTL", () => {
  assert.throws(() => new EvidenceArtifactRegistry(0, 1024), /positive integer/);
});
