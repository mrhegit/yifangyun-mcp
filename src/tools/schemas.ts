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
export const PageInputShape = {
  page_id: z.number().int().min(0).default(0),
  page_capacity: z.number().int().min(1).max(500).default(50)
};
export const PageSchema = z.object({
  page_id: z.number().int().min(0),
  page_capacity: z.number().int().min(1),
  page_count: z.number().int().min(0).optional(),
  total_count: z.number().int().min(0).optional(),
  has_more: z.boolean(),
  next_page_id: z.number().int().min(0).optional()
});
