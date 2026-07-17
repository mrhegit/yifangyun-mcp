import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { objectValue, provenance } from "../domain/projectors.js";
import { normalizeFileVersions, selectFileVersion } from "../domain/fileVersions.js";
import { YifangyunError } from "../client.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerTool } from "./tooling.js";
import { ProvenanceSchema } from "./schemas.js";

export function registerTransferTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("transfer")) {
    return;
  }
  registerTool(server, "yfy_transfer_ticket_get", {
    title: "Get Current Transfer Ticket",
    description: "Return a short-lived Provider URL for the current version only. This result has no content-integrity guarantee; use yfy_evidence_capture for evidence. Historical transfer tickets are intentionally unsupported.",
    inputSchema: { file_id: z.string().regex(/^\d+$/), access_context: z.string().trim().min(1).optional() },
    outputSchema: { download_url: z.string().url(), selection: z.object({ kind: z.literal("current"), provider_selector: z.literal(0), validation_level: z.literal("metadata_only") }), sensitive: z.literal(true), expires_quickly: z.literal(true), provenance: z.array(ProvenanceSchema) }
  }, { readOnly: true }, async ({ file_id, access_context }, extra) => {
    const resolved = runtime.access.resolveContext(typeof access_context === "string" ? access_context : undefined);
    const versionsResponse = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/versions`, resolved.context.id, {}, extra.signal);
    selectFileVersion(normalizeFileVersions(versionsResponse.data).versions, { kind: "current" });
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/download_v2`, resolved.context.id, {
      version: 0,
      external_enterprise_id: resolved.context.externalEnterpriseId
    }, extra.signal);
    const data = objectValue(response.data);
    if (!data || typeof data.download_url !== "string") {
      throw new YifangyunError("Download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "transfer_ticket" });
    }
    return { download_url: data.download_url, selection: { kind: "current", provider_selector: 0, validation_level: "metadata_only" }, sensitive: true, expires_quickly: true, provenance: [provenance(versionsResponse.meta, resolved.context.id), provenance(response.meta, resolved.context.id)] };
  });
}
