import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    const uri = await registry.register({ path: filePath, name: "evidence.txt", mimeType: "text/plain", expectedSize: 8, expectedSha256: crypto.createHash("sha256").update("evidence").digest("hex") });
    assert.match(uri, /^yfy:\/\/evidence\/[a-f0-9]{48}$/);
    const artifact = await registry.read(uri.split("/").at(-1)!);
    assert.equal(Buffer.from(artifact.blob, "base64").toString("utf8"), "evidence");
    assert.equal(artifact.mimeType, "text/plain");
  } finally {
    await registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry rejects oversized resources before allocating content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-resource-limit-"));
  const filePath = path.join(dir, "large.bin");
  await fs.writeFile(filePath, Buffer.alloc(32), { mode: 0o600 });
  const registry = new EvidenceArtifactRegistry(60, 16);
  try {
    const uri = await registry.register({ path: filePath, name: "large.bin", expectedSize: 32, expectedSha256: crypto.createHash("sha256").update(Buffer.alloc(32)).digest("hex") });
    await assert.rejects(() => registry.read(uri.split("/").at(-1)!), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_RESOURCE_TOO_LARGE"));
  } finally {
    await registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry evicts old tokens at its capacity", async () => {
  const registry = new EvidenceArtifactRegistry(60, 1024, 2);
  try {
    const first = await registry.register({ name: "first", path: "first", expectedSize: 0, expectedSha256: crypto.createHash("sha256").update("").digest("hex") });
    await registry.register({ name: "second", path: "second", expectedSize: 0, expectedSha256: crypto.createHash("sha256").update("").digest("hex") });
    await registry.register({ name: "third", path: "third", expectedSize: 0, expectedSha256: crypto.createHash("sha256").update("").digest("hex") });
    await assert.rejects(() => registry.read(first.split("/").at(-1)!), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_ARTIFACT_NOT_FOUND"));
  } finally {
    await registry.close();
  }
});

test("evidence registry rejects a non-expiring resource TTL", () => {
  assert.throws(() => new EvidenceArtifactRegistry(0, 1024), /positive integer/);
});

test("evidence registry rejects bytes changed after registration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-integrity-"));
  const filePath = path.join(dir, "evidence.txt");
  await fs.writeFile(filePath, "original");
  const registry = new EvidenceArtifactRegistry(60, 1024);
  try {
    const uri = await registry.register({ path: filePath, name: "evidence.txt", expectedSize: 8, expectedSha256: crypto.createHash("sha256").update("original").digest("hex") });
    await fs.writeFile(filePath, "modified");
    await assert.rejects(() => registry.read(uri.split("/").at(-1)!), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_ARTIFACT_INTEGRITY_FAILED"));
  } finally {
    await registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry release deletes bytes and invalidates the token", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-release-"));
  const filePath = path.join(dir, "evidence.txt");
  await fs.writeFile(filePath, "evidence");
  const registry = new EvidenceArtifactRegistry(60, 1024);
  try {
    const uri = await registry.register({ path: filePath, name: "evidence.txt", expectedSize: 8, expectedSha256: crypto.createHash("sha256").update("evidence").digest("hex") });
    assert.equal(await registry.release(uri), true);
    await assert.rejects(() => fs.stat(filePath), { code: "ENOENT" });
    assert.equal(await registry.release(uri), false);
  } finally {
    await registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry keeps the token when release cannot delete the artifact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yfy-evidence-release-failure-"));
  const artifactDirectory = path.join(dir, "artifact-directory");
  await fs.mkdir(artifactDirectory);
  const registry = new EvidenceArtifactRegistry(60, 1024);
  const uri = await registry.register({ path: artifactDirectory, name: "invalid", expectedSize: 0, expectedSha256: crypto.createHash("sha256").update("").digest("hex") });
  try {
    await assert.rejects(() => registry.release(uri), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_RELEASE_FAILED"));
    await fs.rm(artifactDirectory, { recursive: true });
    assert.equal(await registry.release(uri), true);
  } finally {
    await registry.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }
});

test("evidence registry rejects registration after shutdown begins", async () => {
  const registry = new EvidenceArtifactRegistry(60, 1024);
  await registry.close();
  await assert.rejects(() => registry.register({ path: "late", name: "late", expectedSize: 0, expectedSha256: crypto.createHash("sha256").update("").digest("hex") }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_EVIDENCE_REGISTRY_CLOSED"));
});
