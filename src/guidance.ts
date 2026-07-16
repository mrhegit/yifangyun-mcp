import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const IdArg = z.union([z.string().trim().regex(/^\d+$/, "id must contain digits only"), z.number().int().nonnegative()]);

export const SERVER_INSTRUCTIONS = [
  "Yifangyun MCP is an OpenAPI-first cloud-drive authority server.",
  "Prefer read-only discovery, metadata, scope proof, then download/hash workflows.",
  "Pass user_id only when the caller specifies an access identity; otherwise use the configured default strategy.",
  "Mutation/admin tools are gated by environment variables and may be absent.",
  "For new automation prefer atomic tools and explicit scope-bounded workflows, and prefer temp_path+sha256 over exposing download_url.",
  "Use durable scope scans for large folders; official indexed search is hint-only and cannot prove absence."
].join(" ");

function asIdText(value: string | number | undefined): string {
  return value === undefined ? "<optional>" : String(value);
}

function textResource(uri: URL, text: string) {
  return {
    contents: [{ uri: uri.href, mimeType: "text/markdown", text }]
  };
}

export function registerGuidance(server: McpServer, config: AppConfig): void {
  server.registerResource(
    "yfy_overview",
    "yfy://guide/overview",
    {
      title: "Yifangyun MCP Overview",
      description: "Short runtime guide for tool selection and capability gates.",
      mimeType: "text/markdown"
    },
    async (uri) => textResource(uri, [
      "# Yifangyun MCP",
      "",
      "Use yfy_resolve_path when you know the exact relative path under a personal, department, or folder root.",
      "Use yfy_search_items for official indexed search across accessible spaces, and pass search_in_folder when you want server-side search within a known folder scope.",
      "Use yfy_start_scope_scan, yfy_advance_scope_scan and yfy_search_scope_snapshot for large or resumable descendant searches.",
      "Treat yfy_search_items and yfy_search_items_advanced as hint-only official index searches.",
      "Download URL exposure is disabled by default; use temp download tools for evidence workflows.",
      "Mutation tools are registered only when YFY_ENABLE_MUTATION_TOOLS is enabled.",
      "Admin tools are registered only when YFY_ENABLE_ADMIN_TOOLS is enabled.",
      "Prefer atomic admin/collab tools for new agents.",
      "",
      `Capabilities: mutation=${config.enableMutationTools ? "enabled" : "disabled"}, admin=${config.enableAdminTools ? "enabled" : "disabled"}, download_url=${config.allowDownloadUrl ? "enabled" : "disabled"}.`
    ].join("\n"))
  );

  server.registerResource(
    "yfy_workflows",
    "yfy://guide/workflows",
    {
      title: "Yifangyun MCP Workflows",
      description: "Minimal recommended tool chains for common agent tasks.",
      mimeType: "text/markdown"
    },
    async (uri) => textResource(uri, [
      "# Workflows",
      "",
      "## Find and lock original",
      "1. Exact path -> yfy_resolve_path; candidate discovery -> yfy_search_items_advanced; exhaustive bounded scope -> yfy_start_scope_scan + repeated yfy_advance_scope_scan + yfy_search_scope_snapshot",
      "2. yfy_get_file_info_full",
      "3. yfy_assert_file_in_scope",
      "4. yfy_lock_current_original",
      "",
      "## Snapshot a folder",
      "1. yfy_get_folder_info",
      "2. yfy_start_scope_scan",
      "3. Repeat yfy_advance_scope_scan with expected_revision until complete or partial",
      "4. Read yfy_get_scope_scan or the manifest resource; use yfy_batch_get_file_info only for selected candidates",
      "",
      "## Safe upload/new version",
      "1. Confirm mutation tools are registered",
      "2. yfy_upload_file or yfy_upload_new_version",
      "3. yfy_get_file_info_full or yfy_get_file_versions to verify"
    ].join("\n"))
  );

  server.registerResource(
    "yfy_safety",
    "yfy://guide/safety",
    {
      title: "Yifangyun MCP Safety",
      description: "Short safety rules for authority, download, mutation, and admin operations.",
      mimeType: "text/markdown"
    },
    async (uri) => textResource(uri, [
      "# Safety",
      "",
      "Use user-token file tools for cloud-drive access; enterprise token tools are for organization/admin planes.",
      "Do not assume an enterprise/admin token can read files.",
      "For evidence work, keep root_folder_id scope proof with sha256 and size_bytes.",
      "Treat admin delete, sync, and permanent trash deletion as destructive operations requiring explicit user intent."
    ].join("\n"))
  );

  server.registerPrompt(
    "yfy_find_and_lock_original",
    {
      title: "Find And Lock Original",
      description: "Guide an agent to locate a Yifangyun file, prove folder scope, and download+hash the original.",
      argsSchema: {
        file_hint: z.string().min(1).describe("File name, path, or search keyword."),
        root_folder_id: IdArg.describe("Authorized root folder id used for scope proof."),
        user_id: IdArg.optional().describe("Optional file-access user id."),
        external_enterprise_id: IdArg.optional().describe("Optional external collaboration enterprise id.")
      }
    },
    ({ file_hint, root_folder_id, user_id, external_enterprise_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Find the Yifangyun file matching: ${file_hint}.`,
            `Use root_folder_id=${root_folder_id} to prove scope before downloading.`,
            `Use user_id=${asIdText(user_id)} and external_enterprise_id=${asIdText(external_enterprise_id)} when applicable.`,
            "Recommended tools: use yfy_resolve_path for an exact relative path; use yfy_search_items_advanced only for candidate discovery; use durable scope scan tools when absence or pagination completeness matters; then yfy_get_file_info_full, yfy_assert_file_in_scope, yfy_lock_current_original.",
            "Return the file id, path/ancestor proof, sha256, size_bytes, and temp_path."
          ].join("\n")
        }
      }]
    })
  );

  server.registerPrompt(
    "yfy_snapshot_folder",
    {
      title: "Snapshot Folder",
      description: "Guide an agent to build a bounded flat snapshot for a Yifangyun folder.",
      argsSchema: {
        root_folder_id: IdArg.describe("Folder id to snapshot."),
        max_depth: z.number().int().min(0).max(20).default(3).describe("Maximum recursion depth."),
        max_items: z.number().int().min(1).max(1000000).default(50000).describe("Maximum descendants observed by the durable scan."),
        user_id: IdArg.optional().describe("Optional file-access user id.")
      }
    },
    ({ root_folder_id, max_depth, max_items, user_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Build a bounded Yifangyun folder snapshot for root_folder_id=${root_folder_id}.`,
            `Use max_depth=${max_depth}, max_items=${max_items}, user_id=${asIdText(user_id)}.`,
            "Recommended tools: yfy_validate_authority_root, yfy_start_scope_scan, repeated yfy_advance_scope_scan, then yfy_get_scope_scan.",
            "Report pagination_complete, safe_to_claim_absence, incomplete_reasons and the artifact URI."
          ].join("\n")
        }
      }]
    })
  );

  server.registerPrompt(
    "yfy_safe_upload_new_version",
    {
      title: "Safe Upload New Version",
      description: "Guide an agent to upload a local file as a new Yifangyun version and verify it.",
      argsSchema: {
        file_id: IdArg.describe("Existing file id to receive the new version."),
        local_path: z.string().min(1).describe("Absolute local path to upload."),
        user_id: IdArg.optional().describe("Optional file-access user id.")
      }
    },
    ({ file_id, local_path, user_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `Upload local_path=${local_path} as a new version of file_id=${file_id}.`,
            `Use user_id=${asIdText(user_id)} when applicable.`,
            "First confirm mutation tools are available. Then call yfy_upload_new_version and verify with yfy_get_file_info_full or yfy_get_file_versions.",
            "Return upload delivery metadata and current file/version proof."
          ].join("\n")
        }
      }]
    })
  );
}
