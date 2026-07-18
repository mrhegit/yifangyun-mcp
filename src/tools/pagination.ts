import { z } from "zod";
import { YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";

export const CursorFieldSchema = z.string().trim().min(1);
export const CursorOnlySchema = z.object({ cursor: CursorFieldSchema }).strict();

export interface PaginatedInputContract {
  inputSchema: z.ZodRawShape;
  validator: z.ZodTypeAny;
}

function firstPagePublicShape<T extends z.ZodRawShape>(firstShape: T): z.ZodRawShape {
  return Object.fromEntries(Object.entries(firstShape).map(([key, schema]) => [
    key,
    schema.optional().describe(schema.description ?? `First-page field '${key}'. Omit when cursor is present.`)
  ]));
}

/**
 * 分页输入：首次页为业务字段（不得含 cursor）；续页仅为 { cursor }。
 * 无兼容层：旧 request.mode 形态由 strict union 拒绝。
 */
export function paginatedInputSchema<T extends z.ZodRawShape>(firstShape: T): PaginatedInputContract {
  return {
    inputSchema: {
      ...firstPagePublicShape(firstShape),
      cursor: CursorFieldSchema.optional().describe("Continuation cursor returned by next_action. When present, omit all first-page fields.")
    },
    validator: z.union([
      z.object(firstShape).strict(),
      CursorOnlySchema
    ])
  };
}

/**
 * 带固定顶层字段的分页输入（如 inventory / action）。
 * 首次：fixed + firstShape；续页：fixed + cursor。
 */
export function paginatedInputSchemaWithFixed<F extends z.ZodRawShape, T extends z.ZodRawShape>(
  fixedShape: F,
  firstShape: T
): PaginatedInputContract {
  return {
    inputSchema: {
      ...fixedShape,
      ...firstPagePublicShape(firstShape),
      cursor: CursorFieldSchema.optional().describe("Continuation cursor returned by next_action. When present, omit all first-page fields.")
    },
    validator: z.union([
      z.object({ ...fixedShape, ...firstShape }).strict(),
      z.object({ ...fixedShape, cursor: CursorFieldSchema }).strict()
    ])
  };
}

/**
 * 根据顶层 cursor 解析分页阶段。
 * 续页仅允许 cursor + fixedKeys；其余键一律拒绝（无兼容层）。
 */
export function resolvePaginationArgs<T extends Record<string, unknown>>(
  args: T,
  phase: string,
  options?: { fixedKeys?: string[] }
): { kind: "first"; data: T } | { kind: "continuation"; cursor: string; fixed: Record<string, unknown> } {
  const fixedKeys = new Set(options?.fixedKeys ?? []);
  const rawCursor = args.cursor;
  const cursor = typeof rawCursor === "string" ? rawCursor.trim() : "";

  if (cursor) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      if (key === "cursor") continue;
      if (fixedKeys.has(key)) continue;
      throw new YifangyunError("Continuation requests may only include cursor and fixed fields.", {
        code: "YFY_INPUT_INVALID",
        phase,
        agentDetails: { reason: "pagination_mixed_args", unexpected_keys: [key] },
        suggestedAction: "Continue with only cursor plus the fixed fields returned by next_action. Do not pass first-page fields together with cursor; or restart with first-page fields and omit cursor."
      });
    }
    const fixed: Record<string, unknown> = {};
    for (const key of fixedKeys) {
      if (args[key] !== undefined) fixed[key] = args[key];
    }
    return { kind: "continuation", cursor, fixed };
  }

  if ("cursor" in args && args.cursor != null && args.cursor !== "") {
    throw new YifangyunError("Paginated cursor must be a non-empty string.", {
      code: "YFY_INPUT_INVALID",
      phase,
      suggestedAction: "Pass a non-empty cursor string for continuation, or omit cursor and provide first-page business fields."
    });
  }

  return { kind: "first", data: args };
}

export function pageOutput(returnedCount: number, cursor?: string): JsonObject {
  return { returned_count: returnedCount, has_more: Boolean(cursor), ...(cursor ? { next_cursor: cursor } : {}) };
}

export function continuationAction(tool: string, cursor?: string, fixed: JsonObject = {}): JsonObject | undefined {
  return cursor ? { tool, arguments: { ...fixed, cursor } } : undefined;
}

export function toolAction(tool: string, args: JsonObject): JsonObject {
  return { tool, arguments: args };
}
