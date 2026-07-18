import { YifangyunError } from "../client.js";
import { decodeCanonicalBase64Url } from "./base64url.js";

export type PlaceRef =
  | { kind: "personal" }
  | { kind: "collaboration" }
  | { kind: "department"; departmentId: string }
  | { kind: "folder"; item: ItemRef }
  | { kind: "workspace"; workspaceId: string };

export type ItemRef = { accessContextId: string; id: string; identityRef: string; type: "file" | "folder" };

export type VersionRef = { file: ItemRef; fileRef: string; providerVersionId: string };

const CONTEXT_ID = "[A-Za-z0-9_-]+";
const IDENTITY_REF = "[a-f0-9]{24}";
const ITEM_REF_PATTERN = new RegExp(`^(file|folder):(\\d+)@(${CONTEXT_ID})\\.(${IDENTITY_REF})$`);

export function formatWorkspaceRef(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function parseWorkspaceRef(value: string): string {
  const match = /^workspace:([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) {
    throw new YifangyunError("Workspace reference is invalid.", {
      code: "YFY_WORKSPACE_REF_INVALID",
      phase: "workspace_reference",
      suggestedAction: "Copy a workspace:<id> reference returned by yfy_status. Bare workspace IDs are not accepted."
    });
  }
  return match[1]!;
}

export function parsePlaceRef(value: string): PlaceRef {
  if (value === "personal") return { kind: "personal" };
  if (value === "collaboration") return { kind: "collaboration" };
  const separator = value.indexOf(":");
  const kind = separator > 0 ? value.slice(0, separator) : "";
  const id = separator > 0 ? value.slice(separator + 1) : "";
  if (kind === "department" && /^\d+$/.test(id)) return { kind, departmentId: id };
  if (kind === "folder") return { kind, item: parseItemRef(value) };
  if (kind === "workspace" && /^[a-zA-Z0-9_-]+$/.test(id)) return { kind, workspaceId: id };
  throw new YifangyunError("Place reference is invalid.", {
    code: "YFY_INPUT_INVALID",
    phase: "place_resolution",
    suggestedAction: "Use personal, collaboration, department:<id>, folder:<id>, or workspace:<id>."
  });
}

export function parseItemRef(value: string): ItemRef {
  const match = ITEM_REF_PATTERN.exec(value);
  if (!match) {
    throw new YifangyunError("Item reference is invalid.", {
      code: "YFY_INPUT_INVALID",
      phase: "item_reference",
      suggestedAction: "Copy the complete context-bound item ref returned by this server. Legacy numeric IDs are not accepted."
    });
  }
  return { type: match[1] as ItemRef["type"], id: match[2]!, accessContextId: match[3]!, identityRef: match[4]! };
}

export function formatItemRef(type: ItemRef["type"], id: string, accessContextId: string, identityRef: string): string {
  return `${type}:${id}@${accessContextId}.${identityRef}`;
}

export function parseVersionRef(value: string, expectedFileRef?: string): VersionRef {
  const match = /^version:(\d+)@([A-Za-z0-9_-]+)$/.exec(value);
  let fileRef: string | undefined;
  try {
    fileRef = match ? decodeCanonicalBase64Url(match[2]!).toString("utf8") : undefined;
  } catch {
    fileRef = undefined;
  }
  if (!match || !fileRef || (expectedFileRef !== undefined && fileRef !== expectedFileRef)) {
    throw new YifangyunError("Version reference is invalid or belongs to another file.", {
      code: "YFY_INPUT_INVALID",
      phase: "version_reference",
      suggestedAction: "Call yfy_versions and copy the returned historical version ref for this file."
    });
  }
  const file = parseItemRef(fileRef);
  if (file.type !== "file") throw new YifangyunError("Version reference is not bound to a file.", { code: "YFY_INPUT_INVALID", phase: "version_reference" });
  return { file, fileRef, providerVersionId: match[1]! };
}

export function formatVersionRef(fileRef: string, providerVersionId: string): string {
  return `version:${providerVersionId}@${Buffer.from(fileRef, "utf8").toString("base64url")}`;
}
