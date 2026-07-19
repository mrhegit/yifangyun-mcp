import type { JsonObject } from "./types.js";

export class YifangyunError extends Error {
  readonly agentDetails?: JsonObject;
  readonly code: string;
  readonly details?: JsonObject;
  readonly phase?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly scanId?: string;
  readonly statusCode?: number;
  readonly suggestedAction?: string;

  constructor(
    message: string,
    options: {
      agentDetails?: JsonObject;
      details?: JsonObject;
      code?: string;
      phase?: string;
      retryAfterMs?: number;
      retryable?: boolean;
      scanId?: string;
      statusCode?: number;
      suggestedAction?: string;
    } = {}
  ) {
    super(message);
    this.name = "YifangyunError";
    this.agentDetails = options.agentDetails;
    this.code = options.code ?? "YFY_UNEXPECTED_ERROR";
    this.details = options.details;
    this.phase = options.phase;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
    this.scanId = options.scanId;
    this.statusCode = options.statusCode;
    this.suggestedAction = options.suggestedAction;
  }
}
