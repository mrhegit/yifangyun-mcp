import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReadiness } from "./capabilities.js";
import type { AppRuntime } from "./runtime/runtime.js";

export function serverInstructions(runtime: AppRuntime): string {
  const instructions = [
    "Yifangyun MCP is an authority-scoped cloud evidence server."
  ];
  if (runtime.config.toolsets.includes("core")) instructions.push("Call yfy_context_get before multi-step work. Prefer configured scopes over raw folder IDs.", "Indexed search is hint-only and never proves absence.");
  if (runtime.config.toolsets.includes("snapshot") && runtime.config.authorityScopes.length > 0) instructions.push("Use one reusable snapshot for exhaustive scope work, then query it with explicit terms.");
  if (runtime.config.toolsets.includes("evidence") && runtime.config.authorityScopes.length > 0) instructions.push("Use yfy_evidence_capture for authority-bound current or historical bytes, and release artifacts when finished.");
  return instructions.join(" ");
}

function textResource(uri: URL, text: string) {
  return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
}

export function registerGuidance(server: McpServer, runtime: AppRuntime): void {
  server.registerResource("yfy_overview", "yfy://guide/overview", {
    title: "Yifangyun MCP Overview",
    description: "Runtime toolsets, access contexts, authority scopes and recommended selection rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Yifangyun MCP Runtime Guide",
    "",
    `Enabled toolsets: ${runtime.config.toolsets.join(", ")}`,
    `Workflow profiles: ${runtime.config.workflowProfiles.join(", ")}`,
    `Access contexts: ${runtime.access.listContexts().map((context) => context.id).join(", ")}`,
    `Authority scopes: ${runtime.access.listScopes().map((scope) => scope.id).join(", ") || "none"}`,
    `Profile readiness: ${JSON.stringify(profileReadiness(runtime.config))}`,
    "",
    "",
    "## Tool selection order",
    ...(runtime.config.toolsets.includes("core") ? ["1. Known exact path: use `yfy_path_resolve`.", "2. Unknown location: use `yfy_item_search` for candidates only."] : []),
    ...(runtime.config.toolsets.includes("snapshot") && runtime.config.authorityScopes.length > 0 ? ["3. Completeness or absence question: create one `yfy_snapshot_create`, wait for terminal state, then call `yfy_snapshot_query`."] : []),
    ...(runtime.config.toolsets.includes("evidence") && runtime.config.authorityScopes.length > 0 ? ["4. Need original bytes: use `yfy_evidence_capture` with a scope and release the returned resource when done."] : []),
    "",
    "Never substitute a nearby candidate, current version, or partial snapshot for the requested authority claim."
  ].join("\n")));

  server.registerResource("yfy_safety", "yfy://guide/safety", {
    title: "Yifangyun MCP Safety",
    description: "Authority, evidence and mutation safety rules.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Yifangyun Safety Contract",
    "",
    "## Non-negotiable rules",
    "- Indexed search cannot prove absence.",
    "- A snapshot may prove absence only when `safe_to_claim_absence=true`; the claim is limited to its scope and observation window.",
    "- Evidence is valid only when every returned integrity check is true.",
    "- A historical capture failure must be reported as unavailable; never substitute current bytes.",
    "- Release evidence artifacts after use.",
    "- Permanent deletion, collaboration removal, platform synchronization, transfer tickets, and admin login material require explicit user intent.",
    "",
    "## Recovery rules",
    "- `stale_state`: restart the requested query as instructed; do not reuse the old cursor.",
    "- `provider_contract`: preserve the error diagnostics and do not weaken integrity checks.",
    "- `capacity_limit`: narrow the scope or raise an explicit bounded limit; do not claim completeness."
  ].join("\n")));

  if (runtime.config.workflowProfiles.includes("tender") && runtime.config.authorityScopes.length > 0 && ["core", "organization", "authority", "snapshot", "evidence"].every((toolset) => runtime.config.toolsets.includes(toolset as AppRuntime["config"]["toolsets"][number]))) {
    registerTenderProfile(server);
  }
}

function registerTenderProfile(server: McpServer): void {
  server.registerResource("yfy_tender_profile", "yfy://profile/tender", {
    title: "Tender Document Workflow Profile",
    description: "Reusable tender-document workflows built on generic authority, snapshot and evidence tools.",
    mimeType: "text/markdown"
  }, async (uri) => textResource(uri, [
    "# Tender Workflow Profile",
    "",
    "## Material completeness audit",
    "1. Validate the configured scope.",
    "2. Create one reusable snapshot with bounded depth and item limits.",
    "3. Poll until `terminal=true`.",
    "4. Query the same snapshot separately for each required material category.",
    "5. Report confirmed matches, ambiguous candidates, missing categories, and completeness limitations.",
    "",
    "## Capture an original",
    "1. Resolve an exact path when available; otherwise discover candidates.",
    "2. Call `yfy_evidence_capture` with the same scope. The tool performs scope checks internally.",
    "3. Return authority proof, exact version, integrity checks, SHA-256, size, observation time, and artifact URI.",
    "4. Release the artifact after downstream processing."
  ].join("\n")));

  server.registerPrompt("yfy_tender_material_audit", {
    title: "Audit Tender Materials",
    description: "Audit a configured tender scope for required material categories.",
    argsSchema: {
      scope_id: z.string().min(1),
      required_materials: z.string().min(1).describe("Comma-separated or newline-separated required material names."),
      max_item_depth: z.string().regex(/^\d+$/).default("20"),
      max_items: z.string().regex(/^\d+$/).default("50000")
    }
  }, ({ scope_id, required_materials, max_item_depth, max_items }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    "# Objective",
    `Audit required tender materials in authority scope \`${scope_id}\`.`,
    `Required material categories:\n${required_materials}`,
    "",
    "# Hard rules",
    "- Indexed search is candidate discovery only.",
    "- Do not claim a category is absent unless the terminal snapshot reports `safe_to_claim_absence=true`.",
    "- Do not merge ambiguous candidates into confirmed matches.",
    "",
    "# Procedure",
    "1. Call `yfy_authority_validate`.",
    `2. Call \`yfy_snapshot_create\` once with \`max_item_depth=${Math.min(100, Math.max(1, Number(max_item_depth)))}\` and \`max_items=${Math.min(1000000, Math.max(1, Number(max_items)))}\`.`,
    "3. Poll `yfy_snapshot_get` until `terminal=true`.",
    "4. Query the same snapshot separately for every required category.",
    "",
    "# Stop conditions",
    "- Stop and report configuration failure when the authority scope is invalid.",
    "- Stop absence claims when the snapshot is partial, failed, cancelled, or expired.",
    "",
    "# Output contract",
    "Return: scope validation, observation window, snapshot completeness, confirmed matches, ambiguous candidates, missing categories, and explicit limitations."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_lock_evidence", {
    title: "Lock Tender Evidence",
    description: "Locate and capture authority-bound evidence for one tender document.",
    argsSchema: { scope_id: z.string().min(1), file_hint: z.string().min(1) }
  }, ({ scope_id, file_hint }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Find the tender document matching: ${file_hint}`,
    `Authority scope: ${scope_id}`,
    "",
    "# Hard rules",
    "- Prefer exact path resolution over indexed search.",
    "- Never substitute a similar file or another version.",
    "- Do not perform a separate scope assertion: `yfy_evidence_capture` enforces the scope before and after download.",
    "",
    "# Procedure",
    "1. Resolve the exact path when possible; otherwise discover and disambiguate candidates.",
    "2. Call `yfy_evidence_capture` with the selected file ID, scope ID, and `{kind:\"current\"}`.",
    "3. Return file ID, path proof, version, integrity checks, SHA-256, size, artifact delivery, and resource URI.",
    "4. Release the artifact after downstream processing."
  ].join("\n") } }] }));

  server.registerPrompt("yfy_tender_compare_versions", {
    title: "Compare Tender Document Versions",
    description: "Inspect version history and verify a tender document against expected evidence.",
    argsSchema: { file_id: z.string().regex(/^\d+$/), scope_id: z.string().min(1), expected_sha256: z.string().optional() }
  }, ({ file_id, scope_id, expected_sha256 }) => ({ messages: [{ role: "user", content: { type: "text", text: [
    `Inspect version history for file ${file_id}.`,
    `Authority scope: ${scope_id}`,
    "Call `yfy_context_get` and use the scope's access context for `yfy_file_versions`. Historical versions must be selected by the returned `provider_version_id`.",
    expected_sha256 ? `Capture current evidence in scope \`${scope_id}\` with \`yfy_evidence_capture\` and expected.sha256=${expected_sha256}.` : "Report version metadata first; capture bytes only when comparison requires content.",
    "If historical capture returns a provider-contract error, report that version as unavailable and preserve the diagnostics. Never substitute current bytes."
  ].join("\n") } }] }));
}
