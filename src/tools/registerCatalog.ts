import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerAdminTools } from "./adminTools.js";
import { registerAuthorityEvidenceTools } from "./authorityEvidenceTools.js";
import { registerCoreTools, registerOrganizationTools } from "./coreTools.js";
import { registerMutationTools } from "./mutationTools.js";
import { registerSnapshotTools } from "./snapshotTools.js";
import { registerTransferTools } from "./transferTools.js";

export function registerCatalog(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("core")) {
    registerCoreTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("organization")) {
    registerOrganizationTools(server, runtime);
  }
  registerAuthorityEvidenceTools(server, runtime);
  registerSnapshotTools(server, runtime);
  registerMutationTools(server, runtime);
  registerAdminTools(server, runtime);
  registerTransferTools(server, runtime);
}
