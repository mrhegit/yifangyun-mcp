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
  continuationFixedKeys?: readonly string[];
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
  return requireObjectType ? { type: "object", ...generated } : generated;
}

const ERROR_CATEGORY_BY_CODE: Readonly<Record<string, string>> = {
  YFY_DOWNLOAD_CLEANUP_FAILED: "local_storage",
  YFY_DOWNLOAD_READ_CAPACITY: "capacity_limit",
  YFY_FILE_VERSIONS_EXTERNAL_IDENTITY_UNSUPPORTED: "provider_contract",
  YFY_LOCAL_STORAGE_INSUFFICIENT: "capacity_limit",
  YFY_LOCAL_STORAGE_WRITE_FAILED: "local_storage",
  YFY_LOCAL_UPLOAD_DISABLED: "configuration",
  YFY_PACK_DOWNLOAD_INVALID: "provider_contract",
  YFY_PACK_DOWNLOAD_EXTERNAL_IDENTITY_UNSUPPORTED: "provider_contract",
  YFY_PROVIDER_DECLARED_FAILURE: "provider_contract",
  YFY_TEMP_STORAGE_CONFIG_UNSAFE: "configuration",
  YFY_TRANSFER_REDIRECT_INVALID: "provider_contract",
  YFY_TRANSFER_REDIRECT_LIMIT: "provider_contract",
  YFY_TRANSFER_REDIRECT_REJECTED: "provider_contract",
  YFY_TRANSFER_URL_INVALID: "provider_contract",
  YFY_TRANSFER_URL_PRIVATE_ADDRESS: "provider_contract",
  YFY_TRANSFER_URL_REJECTED: "provider_contract",
  YFY_UPLOAD_SOURCE_CHANGED: "stale_state",
  YFY_UPLOAD_SOURCE_INVALID: "invalid_input",
  YFY_UPLOAD_SOURCE_OUT_OF_SCOPE: "authorization",
  YFY_UPLOAD_TICKET_INVALID: "provider_contract"
};

export function installToolListHandler(server: McpServer): void {
  const protocol = (server as unknown as { server?: McpServer["server"] }).server;
  if (!protocol) return;
  protocol.removeRequestHandler("tools/list");
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(listedTools.get(server)?.values() ?? [])]
  }));
}

function normalizedErrorCode(error: YifangyunError, providerCode?: string): string {
  if (error.code === "YFY_HISTORICAL_DOWNLOAD_UNAVAILABLE") return error.code;
  const code = providerCode?.toLowerCase() ?? "";
  if (code.includes("file_version_not_found")) return "YFY_VERSION_NOT_FOUND";
  if (code.includes("folder_not_found")) return "YFY_FOLDER_NOT_FOUND";
  if (code.includes("file_not_locked")) return "YFY_FILE_UNAVAILABLE";
  if (code.includes("file_not_found")) return "YFY_FILE_NOT_FOUND";
  if (code.includes("permission") || code.includes("forbidden")) return "YFY_PERMISSION_DENIED";
  return error.code;
}

function errorCategory(error: YifangyunError, normalizedCode: string): string {
  const explicit = ERROR_CATEGORY_BY_CODE[normalizedCode];
  if (explicit) return explicit;
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
  if (normalizedCode.includes("CONFIG") || normalizedCode.includes("DELIVERY_CHANNEL")) return "configuration";
  if (normalizedCode === "YFY_DOWNLOAD_TICKET_INVALID") return "provider_contract";
  if (normalizedCode === "YFY_DOWNLOAD_STREAM_FAILED") return "provider_unavailable";
  if (normalizedCode.includes("REF_IDENTITY_MISMATCH")) return "stale_state";
  if (normalizedCode.endsWith("_CURSOR_STALE") || normalizedCode.includes("STALE") || normalizedCode.includes("REVISION_CONFLICT")) return "stale_state";
  if (normalizedCode.includes("TOO_LARGE") || normalizedCode.includes("QUOTA") || normalizedCode.includes("CAPACITY") || normalizedCode.includes("STORAGE_INSUFFICIENT")) return "capacity_limit";
  if (normalizedCode.includes("LOCAL_STORAGE") || normalizedCode.includes("TEMP_STORAGE")) return "local_storage";
  if (normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("HISTORICAL_DOWNLOAD")) return "provider_contract";
  if (normalizedCode.includes("CONFLICT") || normalizedCode.includes("DRIFT") || normalizedCode.includes("CONTENT_MISMATCH") || normalizedCode.includes("EXPECTATION_MISMATCH") || normalizedCode.includes("INTEGRITY_FAILED") || normalizedCode.includes("IDENTITY_AMBIGUOUS")) return "conflict";
  if (normalizedCode.includes("PROVIDER") || normalizedCode.includes("VERSION_ORDER") || normalizedCode.includes("METADATA_INCOMPLETE") || normalizedCode.includes("UNAVAILABLE")) return "provider_contract";
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
  const inputValidator = definition.inputValidator ?? inputSchema;
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
  const sdkInputSchema = (server as unknown as { server?: unknown }).server
    ? z.object({}).passthrough()
    : inputSchema;
  let registry = listedTools.get(server);
  if (!registry) {
    registry = new Map();
    listedTools.set(server, registry);
  }
  registry.set(name, {
    annotations,
    description: definition.description,
    inputSchema: protocolJsonSchema(inputValidator, true),
    name,
    outputSchema: protocolJsonSchema(outputValidator, true),
    title: definition.title
  });
  // tools/list exposes the strict public contract. The SDK receives an object-only schema so
  // execution errors can use the same actionable YFY envelope instead of JSON-RPC InvalidParams.
  sdkRegisterTool(name, {
    title: definition.title,
    description: definition.description,
    inputSchema: sdkInputSchema,
    outputSchema: definition.outputSchema,
    annotations
  }, async (args, extra) => {
    let produced: Record<string, unknown> | undefined;
    let cleanupRequired = false;
    try {
      let validatedArgs = args;
      {
        const parsed = inputValidator.safeParse(args);
        if (!parsed.success) {
          const hasCursor = typeof (args as { cursor?: unknown }).cursor === "string" && String((args as { cursor?: unknown }).cursor).trim().length > 0;
          const continuationFixedKeys = new Set(definition.continuationFixedKeys ?? []);
          const mixedKeys = Object.entries(args as Record<string, unknown>)
            .filter(([key, value]) => value !== undefined && key !== "cursor" && !continuationFixedKeys.has(key))
            .map(([key]) => key);
          throw new YifangyunError("Tool input is invalid.", {
            code: "YFY_INPUT_INVALID",
            phase: `${name}_input`,
            agentDetails: {
              issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })),
              ...(hasCursor && mixedKeys.length > 0
                ? { reason: "pagination_mixed_args", unexpected_keys: mixedKeys }
                : {})
            },
            suggestedAction: hasCursor
              ? "Continuation: pass only cursor plus the fixed fields returned by next_action. Do not mix first-page fields with cursor. Or restart with first-page fields and omit cursor."
              : "Use the fields shown by tools/list. For pagination, pass first-page business fields or execute next_action with cursor exactly."
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
      const text = serializeToolText(name, output);
      cleanupRequired = false;
      return {
        content: [{ type: "text" as const, text }],
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
