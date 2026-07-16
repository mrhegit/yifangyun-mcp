#!/usr/bin/env node

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { YifangyunClient } from "./client.js";
import { registerGuidance, SERVER_INSTRUCTIONS } from "./guidance.js";
import { registerTools } from "./tools/registerTools.js";
import { registerWorkflowTools } from "./tools/registerWorkflowTools.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { configureObservability, logEvent, metrics } from "./observability.js";

function createServer(config: ReturnType<typeof loadConfig>, client: YifangyunClient): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  }, {
    instructions: SERVER_INSTRUCTIONS
  });

  registerGuidance(server, config);
  registerTools(server, client, config);
  registerWorkflowTools(server, client, config);
  return server;
}

function bearerMatches(header: string | undefined, expectedToken: string): boolean {
  const actual = Buffer.from(header ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function runStdio(config: ReturnType<typeof loadConfig>, client: YifangyunClient): Promise<void> {
  const server = createServer(config, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logEvent("info", "server_started", { transport: "stdio", version: SERVER_VERSION });
}

async function runHttp(config: ReturnType<typeof loadConfig>, client: YifangyunClient): Promise<void> {
  const host = config.httpHost ?? "127.0.0.1";
  const port = config.httpPort ?? 3000;
  const isLocalHost = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLocalHost && !config.httpBearerToken) {
    throw new Error("YFY_HTTP_BEARER_TOKEN is required when HTTP transport binds to a non-localhost address.");
  }
  if (!isLocalHost && (!config.httpAllowedHosts?.length || !config.httpAllowedOrigins?.length)) {
    throw new Error("YFY_HTTP_ALLOWED_HOSTS and YFY_HTTP_ALLOWED_ORIGINS are required for non-localhost HTTP transport.");
  }
  const app = createMcpExpressApp({ host, ...(config.httpAllowedHosts ? { allowedHosts: config.httpAllowedHosts } : {}) });
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && config.httpAllowedOrigins?.length && !config.httpAllowedOrigins.includes(origin)) {
      response.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    if (config.httpBearerToken && !bearerMatches(request.headers.authorization, config.httpBearerToken)) {
      response.status(401).json({ error: "Unauthorized." });
      return;
    }
    next();
  });
  app.post("/mcp", async (request, response) => {
    const server = createServer(config, client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  app.get("/health", (_request, response) => response.json({ ok: true, server_version: SERVER_VERSION }));
  app.get("/metrics", (_request, response) => response.json(metrics.snapshot()));
  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      logEvent("info", "server_started", { host, port, transport: "http", version: SERVER_VERSION });
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  configureObservability(config.logLevel);
  const client = new YifangyunClient(config);
  if (config.transport === "http") {
    await runHttp(config, client);
    return;
  }
  await runStdio(config, client);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`yifangyun-mcp-server failed: ${message}`);
  process.exit(1);
});
