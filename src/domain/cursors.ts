import crypto from "node:crypto";
import { YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";
import { decodeCanonicalBase64Url } from "./base64url.js";
import { z } from "zod";

export interface CursorEnvelope<T extends JsonObject = JsonObject> {
  config_fingerprint: string;
  operation: string;
  payload: T;
  version: 2;
}

export type CursorInvalidReason = "envelope_invalid" | "signature_invalid" | "payload_invalid" | "not_base64url";

export function encodeCursor<T extends JsonObject>(secret: string, configFingerprint: string, operation: string, payload: T): string {
  const envelope: CursorEnvelope<T> = { config_fingerprint: configFingerprint, operation, payload, version: 2 };
  const serialized = JSON.stringify(envelope);
  const signature = crypto.createHmac("sha256", secret).update(serialized).digest("hex");
  return Buffer.from(JSON.stringify({ ...envelope, signature }), "utf8").toString("base64url");
}

export function decodeCursor<T extends z.ZodTypeAny>(secret: string, configFingerprint: string, operation: string, value: string, payloadSchema: T): z.output<T> {
  let reason: CursorInvalidReason = "envelope_invalid";
  try {
    let raw: Buffer;
    try {
      raw = decodeCanonicalBase64Url(value);
    } catch {
      reason = "not_base64url";
      throw new Error("not_base64url");
    }

    let decoded: CursorEnvelope<JsonObject> & { signature?: unknown };
    try {
      decoded = JSON.parse(raw.toString("utf8")) as CursorEnvelope<JsonObject> & { signature?: unknown };
    } catch {
      reason = "envelope_invalid";
      throw new Error("envelope_invalid");
    }

    if (decoded.version !== 2 || decoded.config_fingerprint !== configFingerprint || decoded.operation !== operation || typeof decoded.signature !== "string" || typeof decoded.payload !== "object" || decoded.payload === null) {
      reason = "envelope_invalid";
      throw new Error("envelope_invalid");
    }

    const serialized = JSON.stringify({ config_fingerprint: decoded.config_fingerprint, operation: decoded.operation, payload: decoded.payload, version: decoded.version });
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(serialized).digest("hex"), "utf8");
    const actual = Buffer.from(decoded.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      reason = "signature_invalid";
      throw new Error("signature_invalid");
    }

    try {
      return payloadSchema.parse(decoded.payload);
    } catch {
      reason = "payload_invalid";
      throw new Error("payload_invalid");
    }
  } catch {
    throw new YifangyunError("Cursor is invalid or expired.", {
      code: "YFY_CURSOR_INVALID",
      phase: "cursor_decode",
      suggestedAction: "Restart the same operation with request.mode=first_request.",
      agentDetails: { reason }
    });
  }
}
