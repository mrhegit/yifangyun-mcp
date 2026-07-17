import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactSensitiveText, YifangyunError } from "../client.js";
import { logEvent } from "../observability.js";
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

function normalizedErrorCode(error: YifangyunError, providerCode?: string): string {
  const code = providerCode?.toLowerCase() ?? "";
  if (code.includes("file_version_not_found")) return "YFY_VERSION_NOT_FOUND";
  if (code.includes("folder_not_found")) return "YFY_FOLDER_NOT_FOUND";
  if (code.includes("file_not_found") || code.includes("file_not_locked")) return "YFY_FILE_NOT_FOUND";
  if (code.includes("permission") || code.includes("forbidden")) return "YFY_PERMISSION_DENIED";
  return error.code;
}

function errorCategory(error: YifangyunError, normalizedCode: string): string {
  if (normalizedCode.includes("CANCEL")) return "cancelled";
  if (normalizedCode.includes("TIMEOUT")) return "timeout";
  if (normalizedCode.includes("NOT_FOUND") || error.statusCode === 404) return "not_found";
  if (error.statusCode === 401 || normalizedCode.includes("AUTHENTICATION")) return "authentication";
  if (error.statusCode === 403 || normalizedCode.includes("PERMISSION") || normalizedCode.includes("SCOPE_ASSERTION")) return "authorization";
  if (error.statusCode === 429) return "rate_limited";
  if (error.statusCode !== undefined && error.statusCode >= 500) return "provider_unavailable";
  if (normalizedCode.includes("INPUT") || normalizedCode.includes("PATH_INVALID")) return "invalid_input";
  if (normalizedCode.includes("CONFLICT") || normalizedCode.includes("DRIFT") || normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("ARTIFACT_INTEGRITY") || normalizedCode.includes("IDENTITY_AMBIGUOUS")) return "conflict";
  if (normalizedCode.includes("PROVIDER") || normalizedCode.includes("VERSION_ORDER") || normalizedCode.includes("METADATA_INCOMPLETE") || normalizedCode.includes("FALLBACK_DETECTED")) return "provider_contract";
  return "internal";
}

export function serializeError(error: unknown): JsonObject {
  const yfy = error instanceof YifangyunError
    ? error
    : new YifangyunError("Unexpected internal error.");
  const providerCode = typeof yfy.details?.api_code === "string" ? yfy.details.api_code : undefined;
  const requestId = typeof yfy.details?.request_id === "string" ? yfy.details.request_id : undefined;
  const code = normalizedErrorCode(yfy, providerCode);
  return {
    code,
    category: errorCategory(yfy, code),
    message: redactSensitiveText(yfy.message),
    retryable: yfy.retryable,
    ...(yfy.phase ? { phase: yfy.phase } : {}),
    ...(yfy.retryable && yfy.retryAfterMs !== undefined ? { retry_after_ms: yfy.retryAfterMs } : {}),
    ...(yfy.scanId ? { operation_id: yfy.scanId } : {}),
    ...(yfy.suggestedAction ? { suggested_action: yfy.suggestedAction } : {}),
    ...(yfy.statusCode !== undefined || providerCode || requestId ? { provider: {
      ...(yfy.statusCode !== undefined ? { status_code: yfy.statusCode } : {}),
      ...(providerCode ? { code: providerCode } : {}),
      ...(requestId ? { request_id: requestId } : {})
    } } : {})
  };
}

function errorResult(error: unknown) {
  const details = serializeError(error);
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
          ...(resourceUri ? [{ type: "resource_link" as const, uri: resourceUri, name: typeof evidence?.file_name === "string" ? evidence.file_name : "Yifangyun evidence", mimeType: "application/octet-stream" }] : [])
        ],
        structuredContent: result
      };
    } catch (error) {
      if (!(error instanceof YifangyunError)) {
        logEvent("error", "tool_unexpected_error", { error: redactSensitiveText(error instanceof Error ? error.message : String(error)), tool: name });
      }
      return errorResult(error);
    }
  });
}
