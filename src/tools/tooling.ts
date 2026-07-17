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
  onInvalidOutput?: (result: Record<string, unknown>) => Promise<void>;
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
  if (["YFY_SNAPSHOT_QUERY_EMPTY", "YFY_SNAPSHOT_CURSOR_INVALID"].includes(normalizedCode)) return "invalid_input";
  if (["YFY_SNAPSHOT_QUERY_TOO_SHORT", "YFY_SNAPSHOT_QUERY_TOO_BROAD"].includes(normalizedCode)) return "capacity_limit";
  if (normalizedCode.includes("CANCEL")) return "cancelled";
  if (normalizedCode.includes("TIMEOUT")) return "timeout";
  if (normalizedCode.includes("NOT_FOUND") || error.statusCode === 404) return "not_found";
  if (error.statusCode === 401 || normalizedCode.includes("AUTHENTICATION")) return "authentication";
  if (error.statusCode === 403 || normalizedCode.includes("PERMISSION") || normalizedCode.includes("SCOPE_ASSERTION")) return "authorization";
  if (error.statusCode === 429) return "rate_limited";
  if (error.statusCode !== undefined && error.statusCode >= 500) return "provider_unavailable";
  if (normalizedCode.includes("INPUT") || normalizedCode.includes("PATH_INVALID")) return "invalid_input";
  if (normalizedCode.includes("STALE") || normalizedCode.includes("REVISION_CONFLICT")) return "stale_state";
  if (normalizedCode.includes("TOO_LARGE") || normalizedCode.includes("QUOTA") || normalizedCode.includes("CAPACITY") || normalizedCode.includes("STORAGE_INSUFFICIENT")) return "capacity_limit";
  if (normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("FALLBACK_DETECTED") || normalizedCode.includes("HISTORICAL_CAPTURE")) return "provider_contract";
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
    ...(yfy.agentDetails ? { diagnostics: yfy.agentDetails } : {}),
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
  const outputValidator = definition.outputSchema instanceof z.ZodObject
    ? definition.outputSchema.strict()
    : z.object(definition.outputSchema).strict();
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
      const validated = outputValidator.safeParse(result);
      if (!validated.success) {
        await options.onInvalidOutput?.(result).catch(() => undefined);
        logEvent("error", "tool_output_schema_invalid", { issues: validated.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })), tool: name });
        throw new YifangyunError("The tool produced a result that violates its declared output contract.", {
          code: "YFY_TOOL_OUTPUT_INVALID",
          phase: "tool_output_validation",
          suggestedAction: "Upgrade or fix the MCP server before retrying. Do not treat this call as valid business data."
        });
      }
      const output = validated.data as Record<string, unknown>;
      const artifact = output.artifact && typeof output.artifact === "object" && !Array.isArray(output.artifact) ? output.artifact as Record<string, unknown> : undefined;
      const legacyEvidence = output.evidence && typeof output.evidence === "object" && !Array.isArray(output.evidence) ? output.evidence as Record<string, unknown> : undefined;
      const resourceUri = typeof artifact?.resource_uri === "string" ? artifact.resource_uri : typeof legacyEvidence?.resource_uri === "string" ? legacyEvidence.resource_uri : undefined;
      const resourceReadable = artifact?.delivery === undefined || artifact.delivery === "mcp_resource";
      const serialized = JSON.stringify(output);
      const text = serialized.length <= 12_000
        ? serialized
        : JSON.stringify({ status: "success", tool: name, structured_content_only: true, top_level_fields: Object.keys(output) });
      return {
        content: [
          { type: "text" as const, text },
          ...(resourceUri && resourceReadable ? [{ type: "resource_link" as const, uri: resourceUri, name: typeof artifact?.file_name === "string" ? artifact.file_name : typeof legacyEvidence?.file_name === "string" ? legacyEvidence.file_name : "Yifangyun evidence", mimeType: typeof artifact?.media_type === "string" ? artifact.media_type : "application/octet-stream" }] : [])
        ],
        structuredContent: output
      };
    } catch (error) {
      if (!(error instanceof YifangyunError)) {
        logEvent("error", "tool_unexpected_error", { error: redactSensitiveText(error instanceof Error ? error.message : String(error)), tool: name });
      }
      return errorResult(error);
    }
  });
}
