import crypto from "node:crypto";
import { YifangyunError } from "../client.js";
import type { JsonObject, JsonValue } from "../types.js";
import { arrayValue, idValue, objectValue } from "./projectors.js";

export interface FileVersion {
  current: boolean;
  evidence_ready: boolean;
  generation: number;
  modified_at_iso?: string;
  modified_at_unix?: number;
  name?: string;
  provider_version_id?: string;
  remark?: string;
  sha1?: string;
  size_bytes?: number;
}

export type VersionSelector = { kind: "current" } | { kind: "historical"; version_id: string };
export type EvidenceDownloadStrategy = "current_ordinal" | "historical_reverse_ordinal" | "historical_ordinal" | "historical_version_id";

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
      generation: index,
      current: item.current === true,
      evidence_ready: sha1 !== undefined && size !== undefined,
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
    ? versions[0]
    : versions.find((version) => version.provider_version_id === selector.version_id);
  if (!selected) {
    throw new YifangyunError("请求的文件版本不在当前版本历史中。", {
      code: "YFY_VERSION_NOT_FOUND",
      phase: "version_selection",
      agentDetails: {
        available_version_ids: versions.flatMap((version) => version.provider_version_id ? [version.provider_version_id] : []),
        requested_version_id: selector.kind === "historical" ? selector.version_id : "current"
      },
      suggestedAction: "重新调用 yfy_file_versions，并使用当前返回的历史 version_id。"
    });
  }
  if ((selector.kind === "current") !== selected.current || (selected.current && selected.generation !== 0)) {
    throw new YifangyunError("Provider 版本顺序存在歧义。", {
      code: "YFY_DOWNLOAD_VERSION_ORDER_AMBIGUOUS",
      phase: "version_selection",
      details: { selected_current: selected.current, selected_generation: selected.generation }
    });
  }
  if (!selected.evidence_ready) {
    throw new YifangyunError("请求的文件版本缺少安全取证所需的 SHA-1 或大小元数据。", {
      code: "YFY_VERSION_METADATA_INCOMPLETE",
      phase: "version_selection",
      agentDetails: { generation: selected.generation, provider_version_id: selected.provider_version_id ?? null },
      suggestedAction: "只能对 evidence_ready=true 的版本执行取证。"
    });
  }
  return selected;
}

export function versionSelectionProof(version: FileVersion, selector: VersionSelector, downloadStrategy: EvidenceDownloadStrategy): JsonObject {
  return {
    kind: selector.kind,
    generation: version.generation,
    ...(version.provider_version_id ? { provider_version_id: version.provider_version_id } : {}),
    download_strategy: downloadStrategy,
    validation_level: "content_and_metadata"
  };
}
