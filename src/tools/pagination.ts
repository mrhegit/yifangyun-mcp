import { z } from "zod";
import { YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";

export const ContinuationRequestSchema = z.object({
  mode: z.literal("continuation"),
  cursor: z.string().trim().min(1)
}).strict();

export function paginatedRequestSchema<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("first_request"), ...shape }).strict(),
    ContinuationRequestSchema
  ]);
}

export function parsePaginatedRequest<T extends z.ZodTypeAny>(schema: T, value: unknown, phase: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new YifangyunError("Paginated request is invalid.", {
      code: "YFY_INPUT_INVALID",
      phase,
      agentDetails: { issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join(".") })) },
      suggestedAction: "Use request.mode=first_request with initial parameters, or request.mode=continuation with only the returned cursor."
    });
  }
  return parsed.data;
}

export function pageOutput(returnedCount: number, cursor?: string): JsonObject {
  return { returned_count: returnedCount, has_more: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}) };
}

export function continuationAction(tool: string, cursor?: string, fixed: JsonObject = {}): JsonObject | undefined {
  return cursor ? { tool, arguments: { ...fixed, request: { mode: "continuation", cursor } } } : undefined;
}
