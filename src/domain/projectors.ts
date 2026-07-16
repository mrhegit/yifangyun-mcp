import type { ApiResponseMeta, JsonArray, JsonObject, JsonValue } from "../types.js";

export function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function arrayValue(value: JsonValue | undefined): JsonArray {
  return Array.isArray(value) ? value : [];
}

export function idValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function projectPath(value: JsonValue | undefined): JsonObject[] {
  return arrayValue(value).flatMap((entry) => {
    const source = objectValue(entry);
    if (!source) {
      return [];
    }
    const id = idValue(source.id);
    return [{
      ...(id ? { id } : {}),
      ...(typeof source.name === "string" ? { name: source.name } : {}),
      ...(typeof source.type === "string" ? { type: source.type } : {})
    }];
  });
}

export function projectItem(value: JsonValue | undefined, view: "summary" | "evidence" | "full" = "summary"): JsonObject {
  const source = objectValue(value);
  if (!source) {
    return {};
  }
  const output: JsonObject = {};
  const id = idValue(source.id);
  if (id) output.id = id;
  for (const key of ["name", "type", "extension", "extension_category", "folder_type", "description", "file_version_key", "sha1"] as const) {
    const field = source[key];
    if (field === null || typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      output[key] = field;
    }
  }
  if (typeof source.size === "number") output.size_bytes = source.size;
  const parentId = idValue(source.parent_folder_id) ?? idValue(objectValue(source.parent)?.id);
  if (parentId) output.parent_folder_id = parentId;
  for (const key of ["created_at", "modified_at", "deleted_at"] as const) {
    if (typeof source[key] === "number") {
      output[`${key}_unix`] = source[key];
      output[`${key}_iso`] = new Date(source[key] * 1000).toISOString();
    }
  }
  for (const key of ["in_trash", "is_deleted", "shared", "current"] as const) {
    if (typeof source[key] === "boolean") output[key] = source[key];
  }
  const pathChain = projectPath(source.path);
  if (pathChain.length > 0) {
    output.path_chain = pathChain;
    output.ancestor_folder_ids = pathChain.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
  }
  if (typeof source.path === "string") output.path = source.path;
  if (view !== "summary") {
    const owner = projectUser(source.owned_by, false);
    const modifiedBy = projectUser(source.modified_by, false);
    if (Object.keys(owner).length) output.owned_by = owner;
    if (Object.keys(modifiedBy).length) output.modified_by = modifiedBy;
    const space = objectValue(source.space);
    if (space) {
      output.space = {
        ...(idValue(space.id) ? { id: idValue(space.id)! } : {}),
        ...(typeof space.name === "string" ? { name: space.name } : {}),
        ...(typeof space.type === "string" ? { type: space.type } : {})
      };
    }
  }
  if (view === "full") {
    for (const key of ["comments_count", "sequence_id", "remark"] as const) {
      const field = source[key];
      if (field === null || typeof field === "string" || typeof field === "number" || typeof field === "boolean") output[key] = field;
    }
  }
  return output;
}

export function projectPage(value: JsonValue | undefined, fallback: { itemCount: number; pageCapacity: number; pageId: number }): JsonObject {
  const source = objectValue(value) ?? {};
  const pageId = typeof source.page_id === "number" && Number.isSafeInteger(source.page_id) && source.page_id >= 0 ? source.page_id : fallback.pageId;
  const pageCapacity = typeof source.page_capacity === "number" && Number.isSafeInteger(source.page_capacity) && source.page_capacity > 0 ? source.page_capacity : fallback.pageCapacity;
  const reportedPageCount = typeof source.page_count === "number" && Number.isSafeInteger(source.page_count) && source.page_count >= 0 ? source.page_count : undefined;
  const reportedTotalCount = typeof source.total_count === "number" && Number.isSafeInteger(source.total_count) && source.total_count >= 0 ? source.total_count : undefined;
  const pageCountConsistent = reportedPageCount === undefined || fallback.itemCount === 0 || pageId < reportedPageCount;
  const totalCountConsistent = reportedTotalCount === undefined || reportedTotalCount >= pageId * pageCapacity + fallback.itemCount;
  const metadataInconsistent = !pageCountConsistent || !totalCountConsistent;
  const pageCount = pageCountConsistent ? reportedPageCount : undefined;
  const totalCount = totalCountConsistent ? reportedTotalCount : undefined;
  const signals = [
    typeof source.has_more === "boolean" ? source.has_more : undefined,
    pageCount !== undefined ? pageId + 1 < pageCount : undefined,
    totalCount !== undefined ? pageId * pageCapacity + fallback.itemCount < totalCount : undefined
  ].filter((signal): signal is boolean => signal !== undefined);
  const hasMore = metadataInconsistent || signals.some(Boolean) || (signals.length === 0 && fallback.itemCount >= pageCapacity);
  const providerNextPageId = typeof source.next_page_id === "number" && source.next_page_id === pageId + 1 ? source.next_page_id : undefined;
  const nextPageId = hasMore ? providerNextPageId ?? pageId + 1 : undefined;
  return {
    page_id: pageId,
    page_capacity: pageCapacity,
    ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
    has_more: hasMore,
    ...(nextPageId !== undefined ? { next_page_id: nextPageId } : {})
  };
}

export function projectItemPage(value: JsonValue | undefined, view: "summary" | "evidence" | "full" = "summary", fallback = { pageCapacity: 50, pageId: 0 }): JsonObject {
  const source = objectValue(value) ?? {};
  const files = arrayValue(source.files).map((entry) => projectItem(entry, view)).filter((entry) => Object.keys(entry).length > 0);
  const folders = arrayValue(source.folders).map((entry) => projectItem(entry, view)).filter((entry) => Object.keys(entry).length > 0);
  return {
    files,
    folders,
    page: projectPage(value, { itemCount: files.length + folders.length, pageCapacity: fallback.pageCapacity, pageId: fallback.pageId })
  };
}

export function projectUser(value: JsonValue | undefined, includeContact: boolean): JsonObject {
  const source = objectValue(value);
  if (!source) return {};
  const output: JsonObject = {};
  const id = idValue(source.id);
  if (id) output.id = id;
  if (typeof source.name === "string") output.name = source.name;
  if (typeof source.full_name === "string") output.name = source.full_name;
  if (typeof source.active === "boolean") output.active = source.active;
  if (typeof source.is_active === "boolean") output.active = source.is_active;
  if (includeContact) {
    for (const key of ["email", "phone"] as const) {
      if (typeof source[key] === "string") output[key] = source[key];
    }
  }
  return output;
}

export function projectDepartment(value: JsonValue | undefined): JsonObject {
  const source = objectValue(value);
  if (!source) return {};
  const output: JsonObject = {};
  const id = idValue(source.id);
  const parentId = idValue(source.parent_id);
  if (id) output.id = id;
  if (parentId) output.parent_id = parentId;
  if (typeof source.name === "string") output.name = source.name;
  if (typeof source.permission_type === "string") output.permission_type = source.permission_type;
  for (const key of ["space_total", "space_used", "user_count", "children_departments_count", "direct_item_count"] as const) {
    if (typeof source[key] === "number") output[key] = source[key];
  }
  return output;
}

export function projectGroup(value: JsonValue | undefined): JsonObject {
  const source = objectValue(value);
  if (!source) return {};
  const output: JsonObject = {};
  const id = idValue(source.id);
  if (id) output.id = id;
  for (const key of ["name", "description"] as const) {
    if (typeof source[key] === "string") output[key] = source[key];
  }
  if (typeof source.visible === "boolean") output.visible = source.visible;
  return output;
}

export function provenance(meta: ApiResponseMeta, accessContext?: string): JsonObject {
  return {
    source: "yifangyun_openapi",
    endpoint: meta.endpoint,
    observed_at: meta.fetchedAtIso,
    status_code: meta.statusCode,
    ...(meta.requestId ? { request_id: meta.requestId } : {}),
    ...(accessContext ? { access_context: accessContext } : {})
  };
}
