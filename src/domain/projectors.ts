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

export function projectPage(value: JsonValue | undefined, fallback: { fileCount?: number; filteredCount?: number; folderCount?: number; invalidCount?: number; itemCount: number; pageCapacity: number; pageId: number; providerCount?: number; requestedPageCapacity?: number; truncatedCount?: number }): JsonObject {
  const source = objectValue(value) ?? {};
  const pageId = typeof source.page_id === "number" && Number.isSafeInteger(source.page_id) && source.page_id >= 0 ? source.page_id : fallback.pageId;
  const pageCapacity = typeof source.page_capacity === "number" && Number.isSafeInteger(source.page_capacity) && source.page_capacity > 0 ? source.page_capacity : fallback.pageCapacity;
  const reportedPageCount = typeof source.page_count === "number" && Number.isSafeInteger(source.page_count) && source.page_count >= 0 ? source.page_count : undefined;
  const reportedTotalCount = typeof source.total_count === "number" && Number.isSafeInteger(source.total_count) && source.total_count >= 0 ? source.total_count : undefined;
  const providerCount = fallback.providerCount ?? fallback.itemCount + (fallback.filteredCount ?? 0) + (fallback.invalidCount ?? 0);
  const explicitHasMore = typeof source.has_more === "boolean" ? source.has_more : undefined;
  const pageStart = pageId * pageCapacity;
  const pageCountHasMore = reportedPageCount !== undefined ? pageId + 1 < reportedPageCount : undefined;
  const totalCountHasMore = reportedTotalCount !== undefined ? pageStart + providerCount < reportedTotalCount : undefined;
  const terminalEmptyPage = providerCount === 0
    && explicitHasMore !== true
    && pageCountHasMore !== true
    && totalCountHasMore !== true
    && ((reportedPageCount !== undefined && pageId >= reportedPageCount) || (reportedTotalCount !== undefined && pageStart >= reportedTotalCount));
  const pageCountConsistent = reportedPageCount === undefined || terminalEmptyPage || pageId < reportedPageCount;
  const totalCountConsistent = reportedTotalCount === undefined || terminalEmptyPage || reportedTotalCount >= pageStart + providerCount;
  const metadataInconsistent = !pageCountConsistent || !totalCountConsistent;
  const pageCount = pageCountConsistent ? reportedPageCount : undefined;
  const totalCount = totalCountConsistent ? reportedTotalCount : undefined;
  const signals = [
    explicitHasMore,
    pageCount !== undefined ? pageId + 1 < pageCount : undefined,
    totalCount !== undefined ? pageStart + providerCount < totalCount : undefined
  ].filter((signal): signal is boolean => signal !== undefined);
  const hasMore = !terminalEmptyPage && (metadataInconsistent || signals.some(Boolean) || (signals.length === 0 && providerCount >= pageCapacity));
  const providerNextPageId = typeof source.next_page_id === "number" && source.next_page_id === pageId + 1 ? source.next_page_id : undefined;
  const nextPageId = hasMore ? providerNextPageId ?? pageId + 1 : undefined;
  const continuationBasis = metadataInconsistent ? "inconsistent"
    : explicitHasMore === true ? "provider"
      : pageCount !== undefined && pageId + 1 < pageCount ? "page_count"
        : totalCount !== undefined && pageStart + providerCount < totalCount ? "total_count"
          : signals.length === 0 && providerCount >= pageCapacity ? "full_page"
            : "none";
  return {
    requested: { page_id: fallback.pageId, page_capacity: fallback.requestedPageCapacity ?? fallback.pageCapacity },
    effective: { page_id: pageId, page_capacity: pageCapacity, page_capacity_source: typeof source.page_capacity === "number" ? "provider" : "request_sent" },
    returned: {
      provider_count: providerCount,
      item_count: fallback.itemCount,
      ...(fallback.fileCount !== undefined ? { file_count: fallback.fileCount } : {}),
      ...(fallback.folderCount !== undefined ? { folder_count: fallback.folderCount } : {}),
      filtered_count: fallback.filteredCount ?? 0,
      invalid_count: fallback.invalidCount ?? 0,
      ...(fallback.truncatedCount !== undefined ? { truncated_count: fallback.truncatedCount } : {})
    },
    ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
    has_more: hasMore,
    ...(nextPageId !== undefined ? { next_page_id: nextPageId } : {}),
    continuation_basis: continuationBasis,
    metadata_consistent: !metadataInconsistent
  };
}

export function projectItemPage(value: JsonValue | undefined, view: "summary" | "evidence" | "full" = "summary", fallback: { filteredCount?: number; pageCapacity: number; pageId: number; providerCount?: number; requestedPageCapacity?: number } = { pageCapacity: 50, pageId: 0 }): JsonObject {
  const source = objectValue(value) ?? {};
  const rawFiles = arrayValue(source.files);
  const rawFolders = arrayValue(source.folders);
  const files = rawFiles.map((entry) => projectItem(entry, view)).filter((entry) => Object.keys(entry).length > 0);
  const folders = rawFolders.map((entry) => projectItem(entry, view)).filter((entry) => Object.keys(entry).length > 0);
  const providerCount = fallback.providerCount ?? rawFiles.length + rawFolders.length + (fallback.filteredCount ?? 0);
  const invalidCount = Math.max(0, providerCount - (fallback.filteredCount ?? 0) - files.length - folders.length);
  return {
    files,
    folders,
    page: projectPage(value, { itemCount: files.length + folders.length, fileCount: files.length, folderCount: folders.length, providerCount, filteredCount: fallback.filteredCount, invalidCount, pageCapacity: fallback.pageCapacity, pageId: fallback.pageId, requestedPageCapacity: fallback.requestedPageCapacity })
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

export function provenance(meta: ApiResponseMeta, _accessContext?: string, operation = "provider_request"): JsonObject {
  return {
    source: "yifangyun_openapi",
    operation,
    observed_at: meta.fetchedAtIso,
    ...(meta.requestId ? { request_id: meta.requestId } : {})
  };
}
