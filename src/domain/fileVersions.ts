import crypto from "node:crypto";
import { YifangyunError } from "../client.js";
import type { JsonValue } from "../types.js";
import { arrayValue, idValue, objectValue } from "./projectors.js";

export interface FileVersion {
  current: boolean;
  download_support: "supported" | "unknown" | "unsupported";
  generation: number;
  metadata_complete: boolean;
  modified_at_iso?: string;
  modified_at_unix?: number;
  name?: string;
  provider_version_id?: string;
  remark?: string;
  sha1?: string;
  size_bytes?: number;
}
export type VersionSelector = { kind: "current" } | { kind: "historical"; version_id: string };
export type DownloadStrategy = "current" | "historical_version_id";

export function normalizeFileVersions(value: JsonValue | undefined): { fingerprint: string; versions: FileVersion[] } {
  const source = objectValue(value) ?? {};
  const rawVersions = arrayValue(source.file_versions);
  const parsedVersions = rawVersions.map((entry, index): Omit<FileVersion, "generation"> => {
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
    const current = item.current === true;
    const providerVersionId = idValue(item.id);
    const metadataComplete = sha1 !== undefined && size !== undefined;
    return {
      current,
      metadata_complete: metadataComplete,
      download_support: metadataComplete && current
        ? "supported"
        : metadataComplete && providerVersionId !== undefined
          ? "unknown"
          : "unsupported",
      ...(providerVersionId ? { provider_version_id: providerVersionId } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(sha1 ? { sha1 } : {}),
      ...(size !== undefined ? { size_bytes: size } : {}),
      ...(modifiedAt !== undefined ? { modified_at_unix: modifiedAt, modified_at_iso: new Date(modifiedAt * 1000).toISOString() } : {}),
      ...(typeof item.remark === "string" ? { remark: item.remark } : {})
    };
  });
  const currentIndexes = parsedVersions.flatMap((version, index) => version.current ? [index] : []);
  if (parsedVersions.length === 0 || currentIndexes.length !== 1) {
    throw new YifangyunError("Provider version history must contain exactly one current version.", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_normalization",
      details: { current_indexes: currentIndexes, version_count: parsedVersions.length }
    });
  }
  const ordered = [parsedVersions[currentIndexes[0]!]!, ...parsedVersions.filter((_version, index) => index !== currentIndexes[0])];
  const versions = ordered.map((version, generation): FileVersion => ({ ...version, generation }));
  const versionIdCounts = new Map<string, number>();
  for (const version of versions) {
    if (version.provider_version_id) {
      versionIdCounts.set(version.provider_version_id, (versionIdCounts.get(version.provider_version_id) ?? 0) + 1);
    }
  }
  const duplicateVersionIds = [...versionIdCounts].filter(([, count]) => count > 1).map(([versionId]) => versionId);
  if (duplicateVersionIds.length > 0) {
    throw new YifangyunError("Provider version history contains duplicate version IDs.", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_normalization",
      agentDetails: { duplicate_version_ids: duplicateVersionIds }
    });
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(versions.map((version) => ({
    current: version.current,
    generation: version.generation,
    modified_at_unix: version.modified_at_unix ?? null,
    provider_version_id: version.provider_version_id ?? null,
    sha1: version.sha1 ?? null,
    size_bytes: version.size_bytes ?? null
  })))).digest("hex");
  return { versions, fingerprint };
}

export function selectFileVersion(versions: FileVersion[], selector: VersionSelector): FileVersion {
  const selected = selector.kind === "current"
    ? versions.find((version) => version.current)
    : versions.find((version) => version.provider_version_id === selector.version_id);
  if (!selected) {
    throw new YifangyunError("The requested file version is not present in the current version history.", {
      code: "YFY_VERSION_NOT_FOUND",
      phase: "version_selection",
      agentDetails: {
        available_version_ids: versions.flatMap((version) => version.provider_version_id ? [version.provider_version_id] : []),
        requested_version_id: selector.kind === "historical" ? selector.version_id : "current"
      },
      suggestedAction: "Call yfy_versions again and copy a historical version ref from the current result."
    });
  }
  if ((selector.kind === "current") !== selected.current) {
    throw new YifangyunError("The selected version does not match the requested current or historical kind.", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_selection",
      details: { selected_current: selected.current, selected_generation: selected.generation }
    });
  }
  if (!selected.metadata_complete) {
    throw new YifangyunError("The requested file version lacks the SHA-1 or size metadata required for verified download.", {
      code: "YFY_VERSION_METADATA_INCOMPLETE",
      phase: "version_selection",
      agentDetails: { generation: selected.generation, provider_version_id: selected.provider_version_id ?? null },
      suggestedAction: "Download only versions that report metadata_complete=true and download_support is not unsupported."
    });
  }
  if (selector.kind === "historical" && !selected.provider_version_id) {
    throw new YifangyunError("The requested historical version lacks a Provider version ID.", {
      code: "YFY_VERSION_METADATA_INCOMPLETE",
      phase: "version_selection",
      agentDetails: { generation: selected.generation },
      suggestedAction: "Select a historical version that includes a copyable VersionRef."
    });
  }
  return selected;
}
