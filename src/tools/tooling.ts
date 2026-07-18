import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { redactSensitiveText, YifangyunError } from "../client.js";
import { logEvent } from "../observability.js";
import type { JsonObject } from "../types.js";
import { serializeToolText } from "./resultDelivery.js";

type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: unknown) => Promise<void>;
  signal: AbortSignal;
};

type ToolHandler = (args: Record<string, unknown>, extra: ToolExtra) => Promise<Record<string, unknown>>;

export interface ToolDefinition {
  description: string;
  inputSchema: z.ZodRawShape;
  inputValidator?: z.ZodTypeAny;
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

interface ListedToolDefinition {
  annotations: {
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
  };
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  outputSchema: Record<string, unknown>;
  title: string;
}

const listedTools = new WeakMap<object, Map<string, ListedToolDefinition>>();

function protocolJsonSchema(schema: z.ZodTypeAny, requireObjectType: boolean): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    $refStrategy: "none",
    strictUnions: true,
    target: "jsonSchema7"
  }) as Record<string, unknown>;
  delete generated.$schema;
  return requireObjectType ? { type: "object", ...generated } : generated;
}

export function installToolListHandler(server: McpServer): void {
  const protocol = (server as unknown as { server?: McpServer["server"] }).server;
  if (!protocol) return;
  protocol.removeRequestHandler("tools/list");
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(listedTools.get(server)?.values() ?? [])]
  }));
}

function normalizedErrorCode(error: YifangyunError, providerCode?: string): string {
  const code = providerCode?.toLowerCase() ?? "";
  if (code.includes("file_version_not_found")) return "YFY_VERSION_NOT_FOUND";
  if (code.includes("folder_not_found")) return "YFY_FOLDER_NOT_FOUND";
  if (code.includes("file_not_locked")) return "YFY_FILE_UNAVAILABLE";
  if (code.includes("file_not_found")) return "YFY_FILE_NOT_FOUND";
  if (code.includes("permission") || code.includes("forbidden")) return "YFY_PERMISSION_DENIED";
  return error.code;
}

function errorCategory(error: YifangyunError, normalizedCode: string): string {
  if (normalizedCode.endsWith("_CURSOR_INVALID") || normalizedCode === "YFY_INVENTORY_QUERY_EMPTY") return "invalid_input";
  if (["YFY_INVENTORY_QUERY_TOO_SHORT", "YFY_INVENTORY_QUERY_TOO_BROAD"].includes(normalizedCode)) return "capacity_limit";
  if (normalizedCode.includes("CANCEL")) return "cancelled";
  if (normalizedCode.includes("TIMEOUT")) return "timeout";
  if (normalizedCode.includes("NOT_FOUND") || error.statusCode === 404) return "not_found";
  if (normalizedCode === "YFY_WORKSPACE_MEMBERSHIP_UNAVAILABLE") return "provider_contract";
  if (error.statusCode === 401 || normalizedCode.includes("AUTHENTICATION")) return "authentication";
  if (error.statusCode === 403 || normalizedCode.includes("PERMISSION") || normalizedCode.includes("MEMBERSHIP") || normalizedCode.includes("ACCESS_DENIED") || normalizedCode.includes("FORBIDDEN")) return "authorization";
  if (error.statusCode === 429) return "rate_limited";
  if (error.statusCode !== undefined && error.statusCode >= 500) return "provider_unavailable";
  if (normalizedCode.includes("INPUT") || normalizedCode.includes("PATH_INVALID")) return "invalid_input";
  if (normalizedCode.includes("REF_IDENTITY_MISMATCH")) return "stale_state";
  if (normalizedCode.endsWith("_CURSOR_STALE") || normalizedCode.includes("STALE") || normalizedCode.includes("REVISION_CONFLICT")) return "stale_state";
  if (normalizedCode.includes("TOO_LARGE") || normalizedCode.includes("QUOTA") || normalizedCode.includes("CAPACITY") || normalizedCode.includes("STORAGE_INSUFFICIENT")) return "capacity_limit";
  if (normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("FALLBACK_DETECTED") || normalizedCode.includes("HISTORICAL_CAPTURE")) return "provider_contract";
  if (normalizedCode.includes("CONFLICT") || normalizedCode.includes("DRIFT") || normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("EXPECTATION_MISMATCH") || normalizedCode.includes("ARTIFACT_INTEGRITY") || normalizedCode.includes("IDENTITY_AMBIGUOUS")) return "conflict";
  if (normalizedCode.includes("PROVIDER") || normalizedCode.includes("VERSION_ORDER") || normalizedCode.includes("METADATA_INCOMPLETE") || normalizedCode.includes("FALLBACK_DETECTED") || normalizedCode.includes("UNAVAILABLE")) return "provider_contract";
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
  const inputSchema = z.object(definition.inputSchema).strict();
  const outputValidator = definition.outputSchema instanceof z.ZodObject
    ? definition.outputSchema.strict()
    : z.object(definition.outputSchema).strict();
  const sdkRegisterTool = server.registerTool.bind(server) as unknown as (
    toolName: string,
    toolDefinition: Record<string, unknown>,
    toolHandler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<Record<string, unknown>>
  ) => void;
  const annotations = {
    destructiveHint: options.destructive ?? false,
    idempotentHint: options.idempotent ?? options.readOnly,
    openWorldHint: options.openWorld ?? true,
    readOnlyHint: options.readOnly
  };
  let registry = listedTools.get(server);
  if (!registry) {
    registry = new Map();
    listedTools.set(server, registry);
  }
  registry.set(name, {
    annotations,
    description: definition.description,
    inputSchema: protocolJsonSchema(definition.inputValidator ?? inputSchema, true),
    name,
    outputSchema: protocolJsonSchema(outputValidator, true),
    title: definition.title
  });
  sdkRegisterTool(name, {
    title: definition.title,
    description: definition.description,
    inputSchema,
    outputSchema: definition.outputSchema,
    annotations
  }, async (args, extra) => {
    let produced: Record<string, unknown> | undefined;
    let cleanupRequired = false;
    try {
      let validatedArgs = args;
      if (definition.inputValidator) {
        const parsed = definition.inputValidator.safeParse(args);
        if (!parsed.success) {
          throw new YifangyunError("Tool input is invalid.", {
            code: "YFY_INPUT_INVALID",
            phase: `${name}_input`,
            agentDetails: { issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })) },
            suggestedAction: "Use the fields shown by tools/list. For pagination, pass first-page business fields or execute next_action with cursor exactly."
          });
        }
        validatedArgs = parsed.data as Record<string, unknown>;
      }
      produced = await handler(validatedArgs, extra);
      cleanupRequired = true;
      const validated = outputValidator.safeParse(produced);
      if (!validated.success) {
        logEvent("error", "tool_output_schema_invalid", { issues: validated.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })), tool: name });
        throw new YifangyunError("The tool produced a result that violates its declared output contract.", {
          code: "YFY_TOOL_OUTPUT_INVALID",
          phase: "tool_output_validation",
          suggestedAction: "Upgrade or fix the MCP server before retrying. Do not treat this call as valid business data."
        });
      }
      const output = validated.data as Record<string, unknown>;
      const resource = output.resource && typeof output.resource === "object" && !Array.isArray(output.resource) ? output.resource as Record<string, unknown> : undefined;
      const artifact = output.artifact && typeof output.artifact === "object" && !Array.isArray(output.artifact) ? output.artifact as Record<string, unknown> : undefined;
      const legacyEvidence = output.evidence && typeof output.evidence === "object" && !Array.isArray(output.evidence) ? output.evidence as Record<string, unknown> : undefined;
      const resourceUri = typeof resource?.resource_uri === "string" ? resource.resource_uri : typeof artifact?.resource_uri === "string" ? artifact.resource_uri : typeof legacyEvidence?.resource_uri === "string" ? legacyEvidence.resource_uri : undefined;
      const delivery = resource?.delivery ?? artifact?.delivery;
      const resourceReadable = delivery === undefined || delivery === "mcp_resource" || delivery === "multipart_resource";
      const embeddedText = delivery === "mcp_resource" && typeof resource?.preview_text === "string" ? resource.preview_text : undefined;
      const text = serializeToolText(name, output);
      cleanupRequired = false;
      return {
        content: [
          { type: "text" as const, text },
          ...(resourceUri && embeddedText !== undefined ? [{ type: "resource" as const, resource: { uri: resourceUri, mimeType: typeof resource?.media_type === "string" ? resource.media_type : "text/plain", text: embeddedText } }] : []),
          ...(resourceUri && resourceReadable ? [{ type: "resource_link" as const, uri: resourceUri, name: typeof resource?.file_name === "string" ? resource.file_name : typeof artifact?.file_name === "string" ? artifact.file_name : typeof legacyEvidence?.file_name === "string" ? legacyEvidence.file_name : "Yifangyun content", mimeType: delivery === "multipart_resource" ? "application/json" : typeof resource?.media_type === "string" ? resource.media_type : typeof artifact?.media_type === "string" ? artifact.media_type : "application/octet-stream" }] : [])
        ],
        structuredContent: output
      };
    } catch (error) {
      if (cleanupRequired && produced && options.onInvalidOutput) {
        await options.onInvalidOutput(produced).catch((cleanupError) => {
          logEvent("error", "tool_output_cleanup_failed", { error: redactSensitiveText(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)), tool: name });
        });
      }
      if (!(error instanceof YifangyunError)) {
        logEvent("error", "tool_unexpected_error", { error: redactSensitiveText(error instanceof Error ? error.message : String(error)), tool: name });
      }
      return errorResult(error);
    }
  });
}
