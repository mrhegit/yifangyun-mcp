#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { YifangyunClient } from "./client.js";
import { registerTools } from "./tools/registerTools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new YifangyunClient(config);
  const server = new McpServer({
    name: "yifangyun-mcp-server",
    version: "0.1.0"
  });

  registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("yifangyun-mcp-server running on stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`yifangyun-mcp-server failed: ${message}`);
  process.exit(1);
});
