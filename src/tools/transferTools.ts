import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { objectValue, provenance } from "../domain/projectors.js";
import { YifangyunError } from "../client.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerTool } from "./tooling.js";
import { ProvenanceSchema } from "./schemas.js";

export function registerTransferTools(server: McpServer, runtime: AppRuntime): void {
  if (!runtime.config.toolsets.includes("transfer")) {
    return;
  }
  registerTool(server, "yfy_transfer_ticket_get", {
    title: "Get Yifangyun Transfer Ticket",
    description: "Return a short-lived Provider download URL. This sensitive tool is disabled unless the transfer toolset is enabled.",
    inputSchema: { file_id: z.string().regex(/^\d+$/), version_id: z.string().regex(/^\d+$/).optional(), access_context: z.string().trim().min(1).optional() },
    outputSchema: { download_url: z.string().url(), sensitive: z.boolean(), expires_quickly: z.boolean(), provenance: ProvenanceSchema }
  }, { readOnly: true }, async ({ file_id, version_id, access_context }, extra) => {
    const resolved = runtime.access.resolveContext(typeof access_context === "string" ? access_context : undefined);
    const response = await runtime.gateway.getUser(`/v2/file/${encodeURIComponent(String(file_id))}/download_v2`, resolved.context.id, {
      version: typeof version_id === "string" ? version_id : undefined,
      external_enterprise_id: resolved.context.externalEnterpriseId
    }, extra.signal);
    const data = objectValue(response.data);
    if (!data || typeof data.download_url !== "string") {
      throw new YifangyunError("Download API did not return a transfer URL.", { code: "YFY_DOWNLOAD_TICKET_INVALID", phase: "transfer_ticket" });
    }
    return { download_url: data.download_url, sensitive: true, expires_quickly: true, provenance: provenance(response.meta, resolved.context.id) };
  });
}
