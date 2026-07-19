import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppRuntime } from "../runtime/runtime.js";
import { registerAdminTools } from "./adminTools.js";
import { registerWorkspaceTools } from "./workspaceTools.js";
import { registerDriveTools, registerStatusTool } from "./driveTools.js";
import { registerMutationTools } from "./mutationTools.js";
import { registerOrganizationTools } from "./organizationTools.js";
import { registerInventoryTools } from "./inventoryTools.js";
import { registerDownloadTools } from "./downloadTools.js";
import { registerTransferTools } from "./transferTools.js";
import { installToolListHandler } from "./tooling.js";

export function registerCatalog(server: McpServer, runtime: AppRuntime): void {
  if (runtime.config.toolsets.includes("drive")) {
    registerDriveTools(server, runtime);
    registerDownloadTools(server, runtime);
  } else {
    registerStatusTool(server, runtime);
  }
  if (runtime.config.toolsets.includes("organization")) {
    registerOrganizationTools(server, runtime);
  }
  registerWorkspaceTools(server, runtime);
  registerInventoryTools(server, runtime);
  registerMutationTools(server, runtime);
  registerAdminTools(server, runtime);
  registerTransferTools(server, runtime);
  installToolListHandler(server);
}
