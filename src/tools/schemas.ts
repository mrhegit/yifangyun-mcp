import { z } from "zod";

export const JsonObjectSchema = z.record(z.unknown());
export const JsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown())]);
export const ProvenanceSchema = z.object({
  source: z.literal("yifangyun_openapi"),
  endpoint: z.string(),
  observed_at: z.string(),
  status_code: z.number().int(),
  request_id: z.string().optional(),
  access_context: z.string().optional()
});
export const PathEntrySchema = z.object({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional() });
export const UserSchema = z.object({ id: z.string().optional(), name: z.string().optional(), active: z.boolean().optional(), email: z.string().optional(), phone: z.string().optional() });
export const DepartmentSchema = z.object({
  id: z.string().optional(), parent_id: z.string().optional(), name: z.string().optional(), permission_type: z.string().optional(),
  space_total: z.number().optional(), space_used: z.number().optional(), user_count: z.number().optional(), children_departments_count: z.number().optional(), direct_item_count: z.number().optional()
});
export const GroupSchema = z.object({ id: z.string().optional(), name: z.string().optional(), description: z.string().optional(), visible: z.boolean().optional() });
export const ItemSchema = z.object({
  id: z.string().optional(), name: z.string().optional(), type: z.string().optional(), extension: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  extension_category: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), folder_type: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  description: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), file_version_key: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  sha1: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), size_bytes: z.number().optional(), parent_folder_id: z.string().optional(),
  created_at_unix: z.number().optional(), created_at_iso: z.string().optional(), modified_at_unix: z.number().optional(), modified_at_iso: z.string().optional(),
  deleted_at_unix: z.number().optional(), deleted_at_iso: z.string().optional(), in_trash: z.boolean().optional(), is_deleted: z.boolean().optional(), shared: z.boolean().optional(), current: z.boolean().optional(),
  path_chain: z.array(PathEntrySchema).optional(), ancestor_folder_ids: z.array(z.string()).optional(), path: z.string().optional(), owned_by: UserSchema.optional(), modified_by: UserSchema.optional(),
  space: z.object({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional() }).optional(), comments_count: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  sequence_id: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), remark: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()
});
export const RootRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }),
  z.object({ kind: z.literal("collaboration") }),
  z.object({ kind: z.literal("department"), department_id: z.string().trim().regex(/^\d+$/) }),
  z.object({ kind: z.literal("folder"), folder_id: z.string().trim().regex(/^\d+$/) }),
  z.object({ kind: z.literal("scope"), scope_id: z.string().trim().min(1) })
]);
export const CandidateSchema = z.object({
  item: z.object({
    id: z.string(), name: z.string(), type: z.enum(["file", "folder"]), parent_folder_id: z.string().optional(), path: z.string().optional()
  }),
  verification: z.object({ folder_scope: z.enum(["not_requested", "verified"]), exact_name: z.enum(["not_requested", "verified"]) })
});
export const VersionSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).describe("Capture the current version."),
  z.object({
    kind: z.literal("historical"),
    version_id: z.string().trim().regex(/^\d+$/).describe("Historical provider_version_id returned by yfy_file_versions.")
  }).describe("Capture one exact historical version by stable version ID.")
]);
export const VersionSelectionProofSchema = z.object({
  kind: z.enum(["current", "historical"]),
  generation: z.number().int().min(0),
  provider_version_id: z.string().optional(),
  download_strategy: z.enum(["current_ordinal", "historical_reverse_ordinal", "historical_ordinal", "historical_version_id"]),
  validation_level: z.literal("content_and_metadata")
});
export const FileVersionSchema = z.object({
  generation: z.number().int().min(0), provider_version_id: z.string().optional(), current: z.boolean(), name: z.string().optional(),
  sha1: z.string().regex(/^[a-f\d]{40}$/i).optional(), size_bytes: z.number().int().nonnegative().optional(), modified_at_unix: z.number().int().nonnegative().optional(),
  modified_at_iso: z.string().optional(), remark: z.string().optional(), evidence_ready: z.boolean()
});
export const DomainErrorSchema = z.object({
  code: z.string(), category: z.enum(["invalid_input", "authentication", "authorization", "not_found", "rate_limited", "timeout", "provider_unavailable", "provider_contract", "stale_state", "capacity_limit", "cancelled", "conflict", "internal"]),
  message: z.string(), retryable: z.boolean(), phase: z.string().optional(), retry_after_ms: z.number().int().nonnegative().optional(), suggested_action: z.string().optional(),
  diagnostics: z.record(JsonValueSchema).optional(),
  provider: z.object({ status_code: z.number().int().optional(), code: z.string().optional(), request_id: z.string().optional() }).optional()
});
export const PageInputShape = {
  page_id: z.number().int().min(0).default(0),
  page_capacity: z.number().int().min(1).max(500).default(50)
};
export const PageSchema = z.object({
  requested: z.object({ page_id: z.number().int().min(0), page_capacity: z.number().int().min(1) }),
  effective: z.object({ page_id: z.number().int().min(0), page_capacity: z.number().int().min(1), page_capacity_source: z.enum(["provider", "request_sent"]) }),
  returned: z.object({ provider_count: z.number().int().min(0), item_count: z.number().int().min(0), file_count: z.number().int().min(0).optional(), folder_count: z.number().int().min(0).optional(), filtered_count: z.number().int().min(0), invalid_count: z.number().int().min(0), truncated_count: z.number().int().min(0).optional() }),
  page_count: z.number().int().min(0).optional(),
  total_count: z.number().int().min(0).optional(),
  has_more: z.boolean(),
  next_page_id: z.number().int().min(0).optional(),
  continuation_basis: z.enum(["provider", "page_count", "total_count", "full_page", "none", "inconsistent"]),
  metadata_consistent: z.boolean()
});
