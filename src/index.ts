#!/usr/bin/env node

import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { registerGuidance, serverInstructions } from "./guidance.js";
import { configureObservability, logEvent, metrics } from "./observability.js";
import { AppRuntime } from "./runtime/runtime.js";
import { registerCatalog } from "./tools/registerCatalog.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

interface RunningServer {
  close(): Promise<void>;
}

function createServer(runtime: AppRuntime): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: serverInstructions(runtime) });
  registerGuidance(server, runtime);
  registerCatalog(server, runtime);
  return server;
}

function bearerMatches(header: string | undefined, expectedToken: string): boolean {
  const actual = Buffer.from(header ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${expectedToken}`, "utf8");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function mcpRequestId(body: unknown): unknown {
  return typeof body === "object" && body !== null && "id" in body ? (body as { id?: unknown }).id ?? null : null;
}

async function runStdio(runtime: AppRuntime): Promise<RunningServer> {
  const server = createServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logEvent("info", "server_started", { transport: "stdio", version: SERVER_VERSION });
  return { close: async () => server.close() };
}

async function runHttp(runtime: AppRuntime): Promise<RunningServer> {
  const config = runtime.config;
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
  app.disable("x-powered-by");
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
  type HttpSession = { activeRequests: number; lastUsedAt: number; server: McpServer; transport: StreamableHTTPServerTransport };
  const sessions = new Map<string, HttpSession>();
  let acceptingRequests = true;
  let pendingSessions = 0;
  const closeSession = async (id: string, session: HttpSession): Promise<void> => {
    if (sessions.get(id) !== session) return;
    sessions.delete(id);
    await session.server.close().catch(() => undefined);
  };
  const sessionCleanupTimer = setInterval(() => {
    const idleBefore = Date.now() - (config.httpSessionIdleSeconds ?? 1800) * 1000;
    for (const [id, session] of sessions) {
      if (session.activeRequests === 0 && session.lastUsedAt <= idleBefore) void closeSession(id, session);
    }
  }, Math.min(60000, (config.httpSessionIdleSeconds ?? 1800) * 1000));
  sessionCleanupTimer.unref();
  app.use("/mcp", (request, response, next) => {
    if (!["POST", "GET", "DELETE"].includes(request.method)) {
      response.status(405).set("Allow", "POST, GET, DELETE").json({ error: "Method not allowed." });
      return;
    }
    next();
  });
  app.all("/mcp", async (request, response) => {
    if (!acceptingRequests) {
      response.status(503).json({ jsonrpc: "2.0", id: mcpRequestId(request.body), error: { code: -32003, message: "MCP server is shutting down." } });
      return;
    }
    const sessionId = request.header("mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      response.status(404).json({ jsonrpc: "2.0", id: mcpRequestId(request.body), error: { code: -32001, message: "MCP session not found." } });
      return;
    }
    if (!session && request.method !== "POST") {
      response.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "MCP session id is required." } });
      return;
    }
    let pendingAdmission = false;
    if (!session) {
      if (!isInitializeRequest(request.body)) {
        response.status(400).json({ jsonrpc: "2.0", id: mcpRequestId(request.body), error: { code: -32600, message: "An initialize request is required to create an MCP session." } });
        return;
      }
      const maxSessions = config.httpMaxSessions ?? 100;
      if (sessions.size + pendingSessions >= maxSessions) {
        const oldest = [...sessions.entries()]
          .filter(([, candidate]) => candidate.activeRequests === 0)
          .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
        if (!oldest) {
          response.status(503).json({ jsonrpc: "2.0", id: mcpRequestId(request.body), error: { code: -32002, message: "MCP session capacity is exhausted." } });
          return;
        }
        pendingSessions += 1;
        pendingAdmission = true;
        await closeSession(oldest[0], oldest[1]);
      } else {
        pendingSessions += 1;
        pendingAdmission = true;
      }
      const server = createServer(runtime);
      let transport!: StreamableHTTPServerTransport;
      const created = { activeRequests: 0, lastUsedAt: Date.now(), server, transport: undefined as unknown as StreamableHTTPServerTransport };
      transport = new StreamableHTTPServerTransport({
        enableJsonResponse: false,
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, created); },
        onsessionclosed: (id) => { sessions.delete(id); }
      });
      created.transport = transport;
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.get(id)?.transport === transport) sessions.delete(id);
      };
      try {
        await server.connect(transport);
      } catch (error) {
        if (pendingAdmission) pendingSessions = Math.max(0, pendingSessions - 1);
        await transport.close().catch(() => undefined);
        throw error;
      }
      session = created;
    }
    session.activeRequests += 1;
    session.lastUsedAt = Date.now();
    try {
      await session.transport.handleRequest(request, response, request.body);
    } catch (error) {
      logEvent("error", "http_transport_failed", { error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: "2.0", id: mcpRequestId(request.body), error: { code: -32603, message: "Internal server error." } });
      }
    } finally {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
      session.lastUsedAt = Date.now();
      if (pendingAdmission) {
        pendingSessions = Math.max(0, pendingSessions - 1);
        if (!session.transport.sessionId) await session.server.close().catch(() => undefined);
      }
    }
  });
  app.get("/health", (_request, response) => response.json({ status: "ok", version: SERVER_VERSION }));
  app.get("/metrics", (_request, response) => response.json(metrics.snapshot()));
  const httpServer = await new Promise<HttpServer>((resolve) => {
    const httpServer = app.listen(port, host, () => {
      logEvent("info", "server_started", { host, port, transport: "http", version: SERVER_VERSION });
      resolve(httpServer);
    });
  });
  return {
    close: async () => {
      acceptingRequests = false;
      clearInterval(sessionCleanupTimer);
      const closed = new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
      sessions.clear();
      await closed;
    }
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  configureObservability(config.logLevel);
  const runtime = await AppRuntime.create(config);
  let runningServer: RunningServer | undefined;
  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    logEvent("info", "server_stopping", { signal });
    const failures: string[] = [];
    if (runningServer) try { await runningServer.close(); } catch { failures.push("transport"); }
    try { await runtime.close(); } catch { failures.push("runtime"); }
    if (failures.length > 0) throw new Error(`Server cleanup failed: ${failures.join(",")}`);
  };
  const onSignal = (signal: string) => void close(signal).then(
    () => process.exit(0),
    () => { logEvent("error", "server_stop_failed", { signal }); process.exit(1); }
  );
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  if (config.transport === "http") {
    runningServer = await runHttp(runtime);
  } else {
    runningServer = await runStdio(runtime);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`yifangyun-mcp-server failed: ${message}`);
  process.exit(1);
});
