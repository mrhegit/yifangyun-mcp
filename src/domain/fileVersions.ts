import crypto from "node:crypto";
import { YifangyunError } from "../client.js";
import type { JsonObject, JsonValue } from "../types.js";
import { arrayValue, idValue, objectValue } from "./projectors.js";

export interface FileVersion {
  current: boolean;
  download_version: number;
  downloadable: boolean;
  modified_at_iso?: string;
  modified_at_unix?: number;
  name?: string;
  provider_version_id?: string;
  remark?: string;
  sha1?: string;
  size_bytes?: number;
}

export type VersionSelector = { kind: "current" } | { generations_back: number; kind: "history" };

export function normalizeFileVersions(value: JsonValue | undefined): { fingerprint: string; versions: FileVersion[] } {
  const source = objectValue(value) ?? {};
  const preferred = arrayValue(source.file_versions);
  const rawVersions = preferred.length > 0 ? preferred : arrayValue(source.versions);
  const versions = rawVersions.map((entry, index): FileVersion => {
    const item = objectValue(entry);
    if (!item) {
      throw new YifangyunError("Provider version history contains an invalid entry.", {
        code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
        phase: "version_normalization",
        details: { invalid_index: index, version_count: rawVersions.length }
      });
    }
    const modifiedAt = typeof item.modified_at === "number" && Number.isSafeInteger(item.modified_at) && item.modified_at >= 0 ? item.modified_at : undefined;
    const size = typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : undefined;
    const sha1 = typeof item.sha1 === "string" && /^[a-f\d]{40}$/i.test(item.sha1) ? item.sha1.toLowerCase() : undefined;
    return {
      download_version: index,
      current: item.current === true,
      downloadable: sha1 !== undefined && size !== undefined,
      ...(idValue(item.id) ? { provider_version_id: idValue(item.id)! } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(sha1 ? { sha1 } : {}),
      ...(size !== undefined ? { size_bytes: size } : {}),
      ...(modifiedAt !== undefined ? { modified_at_unix: modifiedAt, modified_at_iso: new Date(modifiedAt * 1000).toISOString() } : {}),
      ...(typeof item.remark === "string" ? { remark: item.remark } : {})
    };
  });
  const currentIndexes = versions.flatMap((version, index) => version.current ? [index] : []);
  if (versions.length === 0 || currentIndexes.length !== 1 || currentIndexes[0] !== 0) {
    throw new YifangyunError("Provider version order is ambiguous.", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_normalization",
      details: { current_indexes: currentIndexes, version_count: versions.length }
    });
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(versions.map((version) => ({
    current: version.current,
    download_version: version.download_version,
    modified_at_unix: version.modified_at_unix ?? null,
    provider_version_id: version.provider_version_id ?? null,
    sha1: version.sha1 ?? null,
    size_bytes: version.size_bytes ?? null
  })))).digest("hex");
  return { versions, fingerprint };
}

export function selectFileVersion(versions: FileVersion[], selector: VersionSelector): FileVersion {
  const downloadVersion = selector.kind === "current" ? 0 : selector.generations_back;
  const selected = versions[downloadVersion];
  if (!selected) {
    throw new YifangyunError("Requested file version is outside the available history.", {
      code: "YFY_VERSION_NOT_FOUND",
      phase: "version_selection",
      details: { available_versions: versions.length, requested_download_version: downloadVersion }
    });
  }
  if (selected.download_version !== downloadVersion || (downloadVersion === 0) !== selected.current) {
    throw new YifangyunError("Provider version order is ambiguous.", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_selection",
      details: { requested_download_version: downloadVersion, selected_download_version: selected.download_version, selected_current: selected.current }
    });
  }
  if (!selected.downloadable) {
    throw new YifangyunError("Requested file version lacks SHA-1 or size metadata required for safe download.", {
      code: "YFY_VERSION_METADATA_INCOMPLETE",
      phase: "version_selection",
      details: { download_version: selected.download_version }
    });
  }
  return selected;
}

export function versionSelectionProof(version: FileVersion, selector: VersionSelector, validationLevel: "content_and_metadata" | "selector_prevalidated"): JsonObject {
  return {
    kind: selector.kind,
    provider_download_version: version.download_version,
    ...(selector.kind === "history" ? { generations_back: selector.generations_back } : {}),
    ...(version.provider_version_id ? { provider_version_id: version.provider_version_id } : {}),
    validation_level: validationLevel
  };
}
