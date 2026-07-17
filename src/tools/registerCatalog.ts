import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerAdminTools } from "./adminTools.js";
import { registerWorkspaceContentTools } from "./workspaceContentTools.js";
import { registerDriveTools } from "./driveTools.js";
import { registerMutationTools } from "./mutationTools.js";
import { registerOrganizationTools } from "./organizationTools.js";
import { registerInventoryTools } from "./inventoryTools.js";
import { registerTransferTools } from "./transferTools.js";

export function registerCatalog(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("drive")) {
    registerDriveTools(server, runtime);
  }
  if (runtime.config.toolsets.includes("organization")) {
    registerOrganizationTools(server, runtime);
  }
  registerWorkspaceContentTools(server, runtime);
  registerInventoryTools(server, runtime);
  registerMutationTools(server, runtime);
  registerAdminTools(server, runtime);
  registerTransferTools(server, runtime);
}
