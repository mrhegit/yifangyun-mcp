import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFileVersions, selectFileVersion } from "./domain/fileVersions.js";

test("file versions expose stable generations and provider version ids", () => {
  const result = normalizeFileVersions({ file_versions: [
    { current: true, sha1: "a".repeat(40), size: 10, modified_at: 2 },
    { id: 501, current: false, sha1: "b".repeat(40), size: 9, modified_at: 1 }
  ] });
  assert.equal(result.versions[0]?.generation, 0);
  assert.equal(result.versions[0]?.provider_version_id, undefined);
  assert.equal(result.versions[1]?.generation, 1);
  assert.equal(result.versions[1]?.provider_version_id, "501");
  assert.equal(selectFileVersion(result.versions, { kind: "historical", version_id: "501" }).sha1, "b".repeat(40));
});

test("file version selection rejects unknown historical ids", () => {
  const result = normalizeFileVersions({ file_versions: [{ current: true, sha1: "a".repeat(40), size: 10 }] });
  assert.throws(() => selectFileVersion(result.versions, { kind: "historical", version_id: "501" }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_VERSION_NOT_FOUND"));
});

test("historical versions without Provider ids are not marked download ready", () => {
  const result = normalizeFileVersions({ file_versions: [
    { current: true, sha1: "a".repeat(40), size: 10 },
    { current: false, sha1: "b".repeat(40), size: 9 }
  ] });
  assert.equal(result.versions[1]?.download_ready, false);
  assert.equal(result.versions[1]?.provider_version_id, undefined);
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

test("file versions normalize Provider hashes and enforce current generation identity", () => {
  const result = normalizeFileVersions({ file_versions: [{ current: true, sha1: "A".repeat(40), size: 10 }] });
  assert.equal(result.versions[0]?.sha1, "a".repeat(40));
  assert.throws(() => selectFileVersion([{ ...result.versions[0]!, generation: 1 }], { kind: "current" }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS"));
});

test("file versions reject duplicate provider version ids", () => {
  assert.throws(() => normalizeFileVersions({ file_versions: [
    { current: true, id: 501, sha1: "a".repeat(40), size: 10 },
    { current: false, id: 501, sha1: "b".repeat(40), size: 9 }
  ] }), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS"));
});
