import type { JsonObject } from "../types.js";
import type { ScopePageReceipt, ScopeScanPolicy } from "./types.js";

export function projectInventoryPolicy(policy: ScopeScanPolicy): JsonObject {
  return {
    case_sensitive: policy.caseSensitive,
    include_files: policy.includeFiles,
    include_folders: policy.includeFolders,
    match_fields: policy.matchFields,
    max_item_depth: policy.maxItemDepth,
    max_items: policy.maxItems,
    page_capacity: policy.pageCapacity
  };
}

export function projectInventoryReceipt(receipt: ScopePageReceipt): JsonObject {
  return {
    attempt: receipt.attempt,
    folder_id: receipt.folderId,
    has_more: receipt.hasMore,
    item_count: receipt.itemCount,
    latency_ms: receipt.latencyMs,
    ...(receipt.nextPageId !== undefined ? { next_page_id: receipt.nextPageId } : {}),
    observed_at: receipt.observedAt,
    page_capacity: receipt.pageCapacity,
    ...(receipt.pageCount !== undefined ? { page_count: receipt.pageCount } : {}),
    page_id: receipt.pageId,
    pagination_reliable: receipt.paginationReliable,
    ...(receipt.providerRequestId ? { provider_request_id: receipt.providerRequestId } : {}),
    response_digest: receipt.responseDigest,
    stored_item_count: receipt.storedItemCount,
    ...(receipt.totalCount !== undefined ? { total_count: receipt.totalCount } : {})
  };
}
