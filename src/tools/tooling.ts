import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactSensitiveText, YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";

type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: unknown) => Promise<void>;
  signal: AbortSignal;
};

type ToolHandler = (args: Record<string, unknown>, extra: ToolExtra) => Promise<Record<string, unknown>>;

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny> | z.ZodObject<z.ZodRawShape>;
  title: string;
}

export interface ToolRegistrationOptions {
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  readOnly: boolean;
}

function errorResult(error: unknown) {
  const yfy = error instanceof YifangyunError
    ? error
    : new YifangyunError(error instanceof Error ? error.message : String(error));
  const details: JsonObject = {
    code: yfy.code,
    message: redactSensitiveText(yfy.message),
    retryable: yfy.retryable,
    ...(yfy.phase ? { phase: yfy.phase } : {}),
    ...(yfy.retryAfterMs !== undefined ? { retry_after_ms: yfy.retryAfterMs } : {}),
    ...(yfy.statusCode !== undefined ? { status_code: yfy.statusCode } : {}),
    ...(yfy.scanId ? { operation_id: yfy.scanId } : {}),
    ...(yfy.suggestedAction ? { suggested_action: yfy.suggestedAction } : {}),
    ...(yfy.details ? { details: yfy.details } : {})
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: details }) }],
    isError: true
  };
}

export function registerTool(
  server: McpServer,
  name: string,
  definition: ToolDefinition,
  options: ToolRegistrationOptions,
  handler: ToolHandler
): void {
  server.registerTool(name, {
    ...definition,
    outputSchema: definition.outputSchema,
    annotations: {
      destructiveHint: options.destructive ?? false,
      idempotentHint: options.idempotent ?? options.readOnly,
      openWorldHint: options.openWorld ?? true,
      readOnlyHint: options.readOnly
    }
  }, async (args, extra) => {
    try {
      const result = await handler(args as Record<string, unknown>, extra as ToolExtra);
      const evidence = result.evidence && typeof result.evidence === "object" && !Array.isArray(result.evidence) ? result.evidence as Record<string, unknown> : undefined;
      const resourceUri = typeof evidence?.resource_uri === "string" ? evidence.resource_uri : undefined;
      const serialized = JSON.stringify(result);
      return {
        content: [
          { type: "text" as const, text: serialized },
          ...(resourceUri ? [{ type: "resource_link" as const, uri: resourceUri, name: typeof evidence?.file_name === "string" ? evidence.file_name : "Yifangyun evidence", ...(typeof evidence?.content_type === "string" ? { mimeType: evidence.content_type } : {}) }] : [])
        ],
        structuredContent: result
      };
    } catch (error) {
      return errorResult(error);
    }
  });
}
