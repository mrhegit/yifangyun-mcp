import { YifangyunError } from "../client.js";

export type PlaceRef =
  | { kind: "personal" }
  | { kind: "collaboration" }
  | { kind: "department"; departmentId: string }
  | { kind: "folder"; folderId: string }
  | { kind: "workspace"; workspaceId: string };

export type ItemRef = { id: string; type: "file" | "folder" };

export type VersionRef = { fileId: string; providerVersionId: string };

export function parsePlaceRef(value: string): PlaceRef {
  if (value === "personal") return { kind: "personal" };
  if (value === "collaboration") return { kind: "collaboration" };
  const separator = value.indexOf(":");
  const kind = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (kind === "department" && /^\d+$/.test(id)) return { kind, departmentId: id };
  if (kind === "folder" && /^\d+$/.test(id)) return { kind, folderId: id };
  if (kind === "workspace" && /^[a-zA-Z0-9_-]+$/.test(id)) return { kind, workspaceId: id };
  throw new YifangyunError("Place reference is invalid.", {
    code: "YFY_INPUT_INVALID",
    phase: "place_resolution",
    suggestedAction: "Use personal, collaboration, department:<id>, folder:<id>, or workspace:<id>."
  });
}

export function parseItemRef(value: string): ItemRef {
  const match = /^(file|folder):(\d+)$/.exec(value);
  if (!match) {
    throw new YifangyunError("Item reference is invalid.", {
      code: "YFY_INPUT_INVALID",
      phase: "item_reference",
      suggestedAction: "Use an item ref returned by this server, such as file:501 or folder:502."
    });
  }
  return { type: match[1] as ItemRef["type"], id: match[2]! };
}

export function formatItemRef(type: ItemRef["type"], id: string): string {
  return `${type}:${id}`;
}

export function parseVersionRef(value: string, expectedFileId?: string): VersionRef {
  const match = /^version:(\d+):(\d+)$/.exec(value);
  if (!match || (expectedFileId !== undefined && match[1] !== expectedFileId)) {
    throw new YifangyunError("Version reference is invalid or belongs to another file.", {
      code: "YFY_INPUT_INVALID",
      phase: "version_reference",
      suggestedAction: "Call yfy_versions and copy the returned historical version ref for this file."
    });
  }
  return { fileId: match[1]!, providerVersionId: match[2]! };
}

export function formatVersionRef(fileId: string, providerVersionId: string): string {
  return `version:${fileId}:${providerVersionId}`;
}
