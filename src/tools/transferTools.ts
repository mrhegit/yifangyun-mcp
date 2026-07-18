import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { objectValue, provenance } from "../domain/projectors.js";
import { normalizeFileVersions, selectFileVersion } from "../domain/fileVersions.js";
import { YifangyunError } from "../client.js";
import { parseItemRef } from "../domain/refs.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerTool } from "./tooling.js";
import { FileRefSchema, ProvenanceSchema } from "./schemas.js";

export function registerTransferTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("transfer")) {
    return;
  }
  registerTool(server, "yfy_transfer_ticket_get", {
    title: "Get Current Transfer Ticket",
    description: "Special-integration only (usage_policy=special_integration_only, not_for_evidence). Return a short-lived Provider transfer URL for the current version only. Do not use this for ordinary agent reads or as the tender evidence path—prefer yfy_open for bytes and yfy_capture for workspace-bound evidence. The URL is sensitive (do_not_echo_url): never log, store, or echo it. This result has no content-integrity guarantee. Historical transfer tickets are intentionally unsupported.",
    inputSchema: { file: FileRefSchema },
    outputSchema: {
      download_url: z.string().url(),
      selection: z.object({ kind: z.literal("current"), provider_selector: z.literal(0), validation_level: z.literal("metadata_only") }),
      sensitive: z.literal(true),
      expires_quickly: z.literal(true),
      usage_policy: z.literal("special_integration_only"),
      not_for_evidence: z.literal(true),
      do_not_echo_url: z.literal(true),
      preferred_alternatives: z.object({ ordinary_read: z.literal("yfy_open"), workspace_evidence: z.literal("yfy_capture") }).strict(),
      provenance: z.array(ProvenanceSchema)
    }
  }, { readOnly: true }, async ({ file }, extra) => {
    const item = parseItemRef(String(file));
    const resolved = runtime.access.resolveContext(item.accessContextId);
    if (item.type !== "file" || item.identityRef !== resolved.identityRef) throw new YifangyunError("A valid context-bound file ref is required.", { code: "YFY_REF_IDENTITY_MISMATCH", phase: "transfer_ticket" });
    const versionsResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/versions`, resolved.context.id, {}, extra.signal);
    selectFileVersion(normalizeFileVersions(versionsResponse.data).versions, { kind: "current" });
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(item.id)}/download_v2`, resolved.context.id, {
      version: 0,
      external_enterprise_id: resolved.context.externalEnterpriseId
    }, extra.signal);
    const data = objectValue(response.data);
    if (!data || typeof data.download_url !== "string") {
      throw new YifangyunError("Download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "transfer_ticket" });
    }
    return {
      download_url: data.download_url,
      selection: { kind: "current", provider_selector: 0, validation_level: "metadata_only" },
      sensitive: true,
      expires_quickly: true,
      usage_policy: "special_integration_only",
      not_for_evidence: true,
      do_not_echo_url: true,
      preferred_alternatives: { ordinary_read: "yfy_open", workspace_evidence: "yfy_capture" },
      provenance: [provenance(versionsResponse.meta, resolved.context.id), provenance(response.meta, resolved.context.id)]
    };
  });
}
