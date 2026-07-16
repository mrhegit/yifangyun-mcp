import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppRuntime } from "./runtime/runtime.js";

export const SERVER_INSTRUCTIONS = [
  "Yifangyun MCP is a general cloud authority and evidence server optimized for tender-document workflows.",
  "Use configured access_context and scope identifiers instead of raw user ids whenever possible.",
  "Use official index search only for candidate discovery; use snapshots when completeness or absence matters.",
  "Use evidence capture with a configured authority scope before relying on an original file.",
  "Mutation, collaboration, admin and transfer capabilities are available only when their toolsets are enabled."
].join(" ");

function textResource(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

export function registerGuidance(server: McpServer, runtime: AppRuntime): void {
  server.registerResource("yfy_overview", "yfy://guide/overview", {
    title: "Yifangyun MCP Overview",
    description: "Runtime toolsets, access contexts, authority scopes and recommended selection rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Yifangyun MCP 1.0",
    "",
    `Enabled toolsets: ${runtime.config.toolsets.join(", ")}`,
    `Workflow profiles: ${runtime.config.workflowProfiles.join(", ")}`,
    `Access contexts: ${runtime.access.listContexts().map((context) => context.id).join(", ")}`,
    `Authority scopes: ${runtime.access.listScopes().map((scope) => scope.id).join(", ") || "none"}`,
    "",
    "Use yfy_item_search for indexed candidate discovery.",
    "Use yfy_path_resolve for an exact known path.",
    "Use yfy_snapshot_create and yfy_snapshot_query for exhaustive bounded scope work.",
    "Use yfy_evidence_capture with current_locked mode for authority-bound originals."
  ].join("\n")));

  server.registerResource("yfy_safety", "yfy://guide/safety", {
    title: "Yifangyun MCP Safety",
    description: "Authority, evidence and mutation safety rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Safety",
    "",
    "Official indexed search cannot prove absence.",
    "Snapshot completeness applies only to the observed accessible scope and observation window.",
    "Evidence capture deletes the downloaded temp file when metadata drift is detected.",
    "Permanent deletion, collaboration removal and platform synchronization require explicit user intent.",
    "Direct transfer tickets and admin login material are sensitive."
  ].join("\n")));

  if (runtime.config.workflowProfiles.includes("tender") && ["core", "authority", "snapshot", "evidence"].every((toolset) => runtime.config.toolsets.includes(toolset as AppRuntime["config"]["toolsets"][number]))) {
    registerTenderProfile(server);
  }
}

function registerTenderProfile(server: McpServer): void {
  server.registerResource("yfy_tender_profile", "yfy://profile/tender", {
    title: "Tender Document Workflow Profile",
    description: "Reusable tender-document workflows built on generic authority, snapshot and evidence tools.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Tender Profile",
    "",
    "## Material completeness audit",
    "1. Validate the configured tender scope.",
    "2. Create a snapshot with qualification and certificate queries.",
    "3. Wait for complete or partial status and report incomplete reasons.",
    "4. Query candidates and group them by expected material category.",
    "",
    "## Lock an original",
    "1. Resolve or search the candidate.",
    "2. Check scope membership.",
    "3. Capture current_locked evidence.",
    "4. Return path proof, version, sha256, size and observation time."
  ].join("\n")));

  server.registerPrompt("yfy_tender_material_audit", {
    title: "Audit Tender Materials",
    description: "Audit a configured tender scope for required material categories.",
    argsSchema: {
      scope_id: z.string().min(1),
      required_materials: z.string().min(1).describe("Comma-separated or newline-separated required material names."),
      max_depth: z.string().regex(/^\d+$/).default("20"),
      max_items: z.string().regex(/^\d+$/).default("50000")
    }
  }, ({ scope_id, required_materials, max_depth, max_items }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Audit tender materials in authority scope ${scope_id}.`,
    `Required materials: ${required_materials}`,
    `Create a snapshot with max_depth=${Math.min(100, Number(max_depth))} and max_items=${Math.min(1000000, Math.max(1, Number(max_items)))}.`,
    "Use yfy_authority_validate, yfy_snapshot_create, yfy_snapshot_get and yfy_snapshot_query.",
    "Separate confirmed matches, ambiguous candidates and missing categories.",
    "Do not claim absence unless safe_to_claim_absence is true."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_lock_evidence", {
    title: "Lock Tender Evidence",
    description: "Locate and capture authority-bound evidence for one tender document.",
    argsSchema: { scope_id: z.string().min(1), file_hint: z.string().min(1) }
  }, ({ scope_id, file_hint }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Find the tender document matching: ${file_hint}`,
    `Authority scope: ${scope_id}`,
    "Use exact path resolution when possible, otherwise indexed search for candidates or a snapshot for exhaustive search.",
    "Call yfy_scope_check in assert mode, then yfy_evidence_capture in current_locked mode.",
    "Return file id, path proof, version id, sha256, size_bytes and the evidence resource_uri; include temp_path only for a local stdio caller."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_compare_versions", {
    title: "Compare Tender Document Versions",
    description: "Inspect version history and verify a tender document against expected evidence.",
    argsSchema: { file_id: z.string().regex(/^\d+$/), expected_sha256: z.string().optional(), access_context: z.string().optional() }
  }, ({ file_id, expected_sha256, access_context }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Inspect version history for file ${file_id}.`,
    `Access context: ${access_context ?? "default"}`,
    "Use yfy_file_versions and yfy_item_get with evidence view.",
    expected_sha256 ? `Verify current content against sha256=${expected_sha256} with yfy_evidence_verify.` : "Report current version metadata and material changes without downloading unless needed."
  ].join("\n") } }] }));
}
