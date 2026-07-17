import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFileVersions, selectFileVersion } from "./domain/fileVersions.js";

test("file versions expose distinct download ordinals and provider detail ids", () => {
  const result = normalizeFileVersions({ file_versions: [
    { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
    { id: 501, current: false, sha1: "b".repeat(40), size: 9, modified_at: 1 }
  ] });
  assert.equal(result.versions[0]?.download_version, 0);
  assert.equal(result.versions[0]?.provider_version_id, undefined);
  assert.equal(result.versions[1]?.download_version, 1);
  assert.equal(result.versions[1]?.provider_version_id, "501");
  assert.equal(selectFileVersion(result.versions, { kind: "history", generations_back: 1 }).sha1, "b".repeat(40));
});

test("file version selection rejects Provider fallback-prone out-of-range ordinals", () => {
  const result = normalizeFileVersions({ file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }] });
  assert.throws(() => selectFileVersion(result.versions, { kind: "history", generations_back: 1 }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_VERSION_NOT_FOUND"));
});

test("file versions reject ambiguous ordering", () => {
  assert.throws(() => normalizeFileVersions({ file_versions: [{ current: false, sha1: "a".repeat(40), size: 10 }] }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS"));
  assert.throws(() => normalizeFileVersions({ file_versions: [
    { current: true, sha1: "a".repeat(40), size: 10 },
    { current: true, sha1: "b".repeat(40), size: 9 }
  ] }));
  assert.throws(() => normalizeFileVersions({ file_versions: [null, { current: true, sha1: "a".repeat(40), size: 10 }] }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS"));
  assert.throws(() => normalizeFileVersions({ file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }, null, { current: false, sha1: "b".repeat(40), size: 9 }] }));
});

test("file versions normalize Provider hashes and enforce ordinal identity", () => {
  const result = normalizeFileVersions({ file_versions: [{ current: true, sha1: "A".repeat(40), size: 10 }] });
  assert.equal(result.versions[0]?.sha1, "a".repeat(40));
  assert.throws(() => selectFileVersion([{ ...result.versions[0]!, download_version: 1 }], { kind: "current" }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS"));
});

test("file versions prefer file_versions over duplicate compatibility arrays", () => {
  const result = normalizeFileVersions({
    file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }],
    versions: [{ current: true, sha1: "a".repeat(40), size: 10 }]
  });
  assert.equal(result.versions.length, 1);
});
