import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReadiness } from "./capabilities.js";
import type { AppRuntime } from "./runtime/runtime.js";

export function serverInstructions(runtime: AppRuntime): string {
  const instructions = [
    "Yifangyun MCP provides drive access, workspace-bound verification, durable inventories, and content capture.",
    "Use yfy_status when build identity, effective configuration, Provider connectivity, or enabled capabilities are unknown."
  ];
  if (runtime.config.toolsets.includes("drive")) {
    instructions.push(
      "With a context-bound ItemRef use yfy_get for metadata or yfy_open for bytes; with an exact relative path use yfy_resolve; otherwise use yfy_search for candidates.",
      "Indexed search is non-exhaustive and never proves absence. claim_allowed=true only means returned metadata supports the query match; use yfy_get to confirm current existence.",
      "yfy_open may embed a verified small-text MCP resource when include_text_preview=true; inspect content_delivery and always honor must_release. Resource links are not guaranteed to be auto-fetched."
    );
  }
  if (runtime.config.toolsets.includes("inventory") && runtime.config.authorityScopes.length > 0) {
    instructions.push(
      "For completeness or absence, create one workspace inventory with explicit limits and refresh mode (optional root_folder for a verified subtree), follow next_action until terminal, then search it.",
      "Absence is valid only when safe_to_claim_absence=true / agent_guidance.may_claim_absence=true; read agent_guidance and suggested_wait_ms on running/retry_wait. Partial, failed, cancelled, running, and retry_wait inventories do not prove absence."
    );
  }
  if (runtime.config.toolsets.includes("evidence") && runtime.config.authorityScopes.length > 0) {
    instructions.push(
      "Use yfy_capture only when workspace-bound original bytes are required. It may embed a verified small-text MCP resource when include_text_preview=true; inspect content_delivery and always honor must_release. Release every returned resource after use when must_release=true. Binary rendering depends on client attachment support."
    );
  }
  if (runtime.config.toolsets.includes("transfer")) {
    instructions.push("Do not use yfy_transfer_ticket_get as an evidence or ordinary read path; prefer yfy_open/yfy_capture. Transfer URLs are sensitive and must not be logged.");
  }
  return instructions.join(" ");
}

function textResource(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

export function registerGuidance(server: McpServer, runtime: AppRuntime): void {
  server.registerResource("yfy_overview", "yfy://guide/overview", {
    title: "Yifangyun MCP Overview",
    description: "Runtime toolsets, workspaces and recommended selection rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Yifangyun MCP Runtime Guide",
    "",
    `Enabled toolsets: ${runtime.config.toolsets.join(", ")}`,
    `Workflow profiles: ${runtime.config.workflowProfiles.join(", ")}`,
    `Access contexts: ${runtime.access.listContexts().map((context) => context.id).join(", ")}`,
    `Workspaces: ${runtime.access.listScopes().map((scope) => scope.id).join(", ") || "none"}`,
    `Profile readiness: ${JSON.stringify(profileReadiness(runtime.config))}`,
    "",
    "",
    "## Tool selection order",
    ...(runtime.config.toolsets.includes("drive") ? [
      "1. Runtime identity or capability state is unknown: call `yfy_status` once.",
      "2. Existing ItemRef and metadata needed: call `yfy_get`; use `yfy_get_many` for a bounded batch.",
      "3. Existing FileRef and bytes needed without a Workspace claim: call `yfy_open`, inspect whether `content_delivery` embedded a verified text resource or requires `resources/read`, then call `yfy_resource_release`.",
      "4. Known exact relative path: call `yfy_resolve`.",
      "5. Unknown location: call `yfy_search` for candidates only; `claim_allowed=true` supports the query match but current existence still requires `yfy_get`. Disambiguate before opening or capturing."
    ] : []),
    ...(runtime.config.toolsets.includes("inventory") && runtime.config.authorityScopes.length > 0 ? ["6. Completeness or absence question: call `yfy_inventory_create` with `workspace:<id>`, explicit `limits`, and a refresh mode (optional `root_folder` for a verified subtree); follow next_action until terminal, then call `yfy_inventory_search`. Absence is valid only when `safe_to_claim_absence=true` / `agent_guidance.may_claim_absence=true`. Read `agent_guidance` and `suggested_wait_ms`."] : []),
    ...(runtime.config.toolsets.includes("evidence") && runtime.config.authorityScopes.length > 0 ? ["7. Workspace-bound original bytes required: call `yfy_capture`, process the Resource, then call `yfy_resource_release`. Inspect `content_delivery` and honor `must_release`. Binary rendering depends on client attachment support."] : []),
    ...(runtime.config.toolsets.includes("transfer") ? ["8. Never use `yfy_transfer_ticket_get` as an evidence or ordinary read path; prefer `yfy_open`/`yfy_capture`. Do not log transfer URLs."] : []),
    "",
    "Never substitute a nearby candidate, current version, or partial inventory for the requested workspace claim."
  ].join("\n")));

  server.registerResource("yfy_safety", "yfy://guide/safety", {
    title: "Yifangyun MCP Safety",
    description: "Workspace, capture and mutation safety rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Yifangyun Safety Contract",
    "",
    "## Non-negotiable rules",
    "- Indexed search cannot prove absence. `claim_allowed=true` supports the query match from returned metadata; call `yfy_get` before relying on current existence.",
    "- An inventory may prove absence only when `safe_to_claim_absence=true` / `agent_guidance.may_claim_absence=true`; the claim is limited to its scan root and observation window. Read `agent_guidance` and `suggested_wait_ms`.",
    "- `yfy_open` / `yfy_capture` may include a standard embedded text resource; inspect `content_delivery`, do not assume resource links were fetched, and always honor `must_release`.",
    "- Capture checks use pass, not_applicable, or unavailable; only a verified result may be used as evidence.",
    "- A historical capture failure must be reported as unavailable; never substitute current bytes.",
    "- Release content resources after use.",
    "- Never treat transfer tickets as an evidence path; prefer `yfy_open`/`yfy_capture`. Transfer URLs are sensitive and must not be logged.",
    "- Permanent deletion, collaboration removal, platform synchronization, transfer tickets, and admin login material require explicit user intent.",
    "",
    "## Recovery rules",
    "- `stale_state`: restart the requested query as instructed; refs and cursors are contract-version specific.",
    "- `provider_contract`: preserve the error diagnostics and do not weaken integrity checks.",
    "- `capacity_limit`: narrow the workspace or raise an explicit bounded limit; do not claim completeness."
  ].join("\n")));

  if (runtime.config.workflowProfiles.includes("tender") && runtime.config.authorityScopes.length > 0 && ["drive", "workspace", "inventory", "evidence"].every((toolset) => runtime.config.toolsets.includes(toolset as AppRuntime["config"]["toolsets"][number]))) {
    registerTenderProfile(server);
  }
}

function registerTenderProfile(server: McpServer): void {
  server.registerResource("yfy_tender_profile", "yfy://profile/tender", {
    title: "Tender Document Workflow Profile",
    description: "Reusable tender-document workflows built on drive, workspace, inventory, and capture tools.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Tender Workflow Profile",
    "",
    "## Material completeness audit",
    "1. Validate the configured workspace.",
    "2. Create one fresh or reusable inventory with explicit bounded depth and item limits.",
    "3. Poll until `terminal=true`.",
    "4. Search the same inventory separately for each required material category.",
    "5. Report confirmed matches, ambiguous candidates, missing categories, and completeness limitations.",
    "",
    "## Capture an original",
    "1. Resolve an exact path when available; otherwise discover candidates.",
    "2. Call `yfy_capture` with the same workspace. The tool performs membership checks internally.",
    "3. Return workspace proof, exact version, assurance checks, SHA-256, size, observation time, and resource URI.",
    "4. Release the resource with `yfy_resource_release` after downstream processing."
  ].join("\n")));

  server.registerPrompt("yfy_tender_material_audit", {
    title: "Audit Tender Materials",
    description: "Audit a configured tender workspace for required material categories.",
    argsSchema: {
      workspace: z.string().regex(/^workspace:[A-Za-z0-9_-]+$/),
      required_materials: z.string().min(1).describe("Comma-separated or newline-separated required material names."),
      max_item_depth: z.string().regex(/^\d+$/),
      max_items: z.string().regex(/^\d+$/)
    }
  }, ({ workspace, required_materials, max_item_depth, max_items }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    "# Objective",
    `Audit required tender materials in workspace \`${workspace}\`.`,
    `Required material categories:\n${required_materials}`,
    "",
    "# Hard rules",
    "- Indexed search is candidate discovery only.",
    "- Do not claim a category is absent unless the terminal inventory reports `safe_to_claim_absence=true` / `agent_guidance.may_claim_absence=true`.",
    "- Do not merge ambiguous candidates into confirmed matches.",
    "- Do not use transfer tickets as an evidence path.",
    "",
    "# Procedure",
    `1. Call \`yfy_workspace_validate\` with workspace \`${workspace}\`.`,
    `2. Call \`yfy_inventory_create\` once with \`workspace=${workspace}\`, \`refresh={mode:\"reuse_if_fresh\",max_age_seconds:300}\`, and \`limits={max_item_depth:${Math.min(100, Math.max(1, Number(max_item_depth)))},max_items:${Math.min(1000000, Math.max(1, Number(max_items)))}}\`.`,
    "3. Follow `next_action` until `terminal=true`. Honor `suggested_wait_ms` while running or in retry_wait.",
    "4. Call `yfy_inventory_search` separately for every required category.",
    "",
    "# Stop conditions",
    "- Stop and report configuration failure when the workspace is invalid.",
    "- Stop absence claims when the inventory is partial, failed, cancelled, running, or retry_wait.",
    "",
    "# Output contract",
    "Return: workspace validation, observation window, inventory completeness, confirmed matches, ambiguous candidates, missing categories, and explicit limitations."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_lock_evidence", {
    title: "Lock Tender Evidence",
    description: "Locate and capture workspace-bound evidence for one tender document.",
    argsSchema: { workspace: z.string().regex(/^workspace:[A-Za-z0-9_-]+$/), file_hint: z.string().min(1) }
  }, ({ workspace, file_hint }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Find the tender document matching: ${file_hint}`,
    `Workspace: ${workspace}`,
    "",
    "# Hard rules",
    "- Prefer exact path resolution over indexed search.",
    "- Never substitute a similar file or another version.",
    "- Do not perform a separate membership assertion: `yfy_capture` enforces the workspace before and after download.",
    "- Do not use transfer tickets as an evidence path.",
    "",
    "# Procedure",
    "1. Resolve the exact path when possible; otherwise discover and disambiguate candidates.",
    "2. Call `yfy_capture` with the selected file ref and workspace; omit version for current content.",
    "3. Return file ref, path proof, version ref, assurance checks, SHA-256, size, delivery, and resource URI.",
    "4. Release the resource with `yfy_resource_release`."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_compare_versions", {
    title: "Compare Tender Document Versions",
    description: "Inspect version history and verify a tender document against expected evidence.",
    argsSchema: { file: z.string().regex(/^file:\d+@[A-Za-z0-9_-]+\.[a-f0-9]{24}$/), workspace: z.string().regex(/^workspace:[A-Za-z0-9_-]+$/), expected_sha256: z.string().optional() }
  }, ({ file, workspace, expected_sha256 }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Inspect version history for ${file}.`,
    `Workspace: ${workspace}`,
    "Call `yfy_versions` and copy the returned historical version ref when historical bytes are needed.",
    expected_sha256 ? `Capture current content in workspace \`${workspace}\` with \`yfy_capture\` and expected.sha256=${expected_sha256}.` : "Report version metadata first; capture bytes only when comparison requires content.",
    "If historical capture returns a provider-contract error, report that version as unavailable and preserve the diagnostics. Never substitute current bytes."
  ].join("\n") } }] }));
}
