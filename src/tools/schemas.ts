import { z } from "zod";

export const JsonObjectSchema = z.record(z.unknown());
export const JsonValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown())]);
const BoundItemRefPattern = /^(file|folder):\d+@[A-Za-z0-9_-]+\.[a-f0-9]{24}$/;
export const WorkspaceRefSchema = z.string().trim().regex(/^workspace:[A-Za-z0-9_-]+$/).describe("Copy the workspace:<id> ref returned by yfy_status.");
export const ItemRefSchema = z.string().trim().regex(BoundItemRefPattern).describe("Context-bound item ref returned by this server. Copy it exactly; legacy numeric IDs are invalid.");
export const FileRefSchema = z.string().trim().regex(/^file:\d+@[A-Za-z0-9_-]+\.[a-f0-9]{24}$/).describe("Context-bound file ref returned by this server.");
export const FolderRefSchema = z.string().trim().regex(/^folder:\d+@[A-Za-z0-9_-]+\.[a-f0-9]{24}$/).describe("Context-bound folder ref returned by this server.");
export const PlaceRefSchema = z.union([z.enum(["personal", "collaboration"]), z.string().trim().regex(/^department:\d+$/), FolderRefSchema, WorkspaceRefSchema]).describe("Copy a place ref returned by this server.");
export const VersionRefSchema = z.string().trim().regex(/^version:\d+@[A-Za-z0-9_-]+$/).describe("Historical version ref returned by yfy_versions. Omit it for the current version.");
export const SimplePageSchema = z.object({
  returned_count: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().optional()
}).strict();
export const NextActionSchema = z.object({ tool: z.string(), arguments: z.record(z.unknown()) }).strict();
export const VerificationStatusSchema = z.enum(["pass", "not_applicable", "unavailable"]);
export const CheckStatusSchema = z.enum(["pass", "fail", "unavailable"]);
export const ProvenanceSchema = z.object({
  source: z.literal("yifangyun_openapi"),
  operation: z.string(),
  observed_at: z.string(),
  request_id: z.string().optional()
}).strict();
export const PathEntrySchema = z.object({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional() }).strict();
export const UserSchema = z.object({ id: z.string().optional(), name: z.string().optional(), active: z.boolean().optional(), email: z.string().optional(), phone: z.string().optional() }).strict();
export const DepartmentSchema = z.object({
  id: z.string().optional(), parent_id: z.string().optional(), name: z.string().optional(), permission_type: z.string().optional(),
  space_total: z.number().optional(), space_used: z.number().optional(), user_count: z.number().optional(), children_departments_count: z.number().optional(), direct_item_count: z.number().optional()
}).strict();
export const GroupSchema = z.object({ id: z.string().optional(), name: z.string().optional(), description: z.string().optional(), visible: z.boolean().optional() }).strict();
export const ItemSchema = z.object({
  id: z.string().optional(), name: z.string().optional(), type: z.string().optional(), extension: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  extension_category: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), folder_type: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  description: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), file_version_key: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  sha1: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), size_bytes: z.number().optional(), parent_folder_id: z.string().optional(),
  created_at_unix: z.number().optional(), created_at_iso: z.string().optional(), modified_at_unix: z.number().optional(), modified_at_iso: z.string().optional(),
  deleted_at_unix: z.number().optional(), deleted_at_iso: z.string().optional(), in_trash: z.boolean().optional(), is_deleted: z.boolean().optional(), shared: z.boolean().optional(), current: z.boolean().optional(),
  provider_path_chain: z.array(PathEntrySchema).optional(), path_basis: z.literal("provider_supplied").optional(), ancestor_folder_ids: z.array(z.string()).optional(), path: z.string().optional(), owned_by: UserSchema.optional(), modified_by: UserSchema.optional(),
  space: z.object({ id: z.string().optional(), name: z.string().optional(), type: z.string().optional() }).strict().optional(), comments_count: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  sequence_id: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(), remark: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()
}).strict();
export const VersionSelectionProofSchema = z.object({
  kind: z.enum(["current", "historical"]),
  generation: z.number().int().min(0),
  provider_version_id: z.string().optional(),
  download_strategy: z.enum(["current_ordinal", "historical_reverse_ordinal", "historical_ordinal", "historical_version_id"]),
  validation_level: z.literal("content_and_metadata")
}).strict();
export const FileVersionSchema = z.object({
  generation: z.number().int().min(0), provider_version_id: z.string().optional(), current: z.boolean(), name: z.string().optional(),
  sha1: z.string().regex(/^[a-f\d]{40}$/i).optional(), size_bytes: z.number().int().nonnegative().optional(), modified_at_unix: z.number().int().nonnegative().optional(),
  modified_at_iso: z.string().optional(), remark: z.string().optional(), evidence_ready: z.boolean()
}).strict();
export const DomainErrorSchema = z.object({
  code: z.string(), category: z.enum(["invalid_input", "authentication", "authorization", "not_found", "rate_limited", "timeout", "provider_unavailable", "provider_contract", "stale_state", "capacity_limit", "cancelled", "conflict", "internal"]),
  message: z.string(), retryable: z.boolean(), phase: z.string().optional(), retry_after_ms: z.number().int().nonnegative().optional(), suggested_action: z.string().optional(),
  diagnostics: z.record(JsonValueSchema).optional(),
  provider: z.object({ status_code: z.number().int().optional(), code: z.string().optional(), request_id: z.string().optional() }).strict().optional()
}).strict();
