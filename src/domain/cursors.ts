import crypto from "node:crypto";
import { YifangyunError } from "../client.js";
import type { JsonObject } from "../types.js";
import { decodeCanonicalBase64Url } from "./base64url.js";

export interface CursorEnvelope<T extends JsonObject = JsonObject> {
  operation: string;
  payload: T;
  version: 1;
}

export function encodeCursor<T extends JsonObject>(secret: string, operation: string, payload: T): string {
  const envelope: CursorEnvelope<T> = { operation, payload, version: 1 };
  const serialized = JSON.stringify(envelope);
  const signature = crypto.createHmac("sha256", secret).update(serialized).digest("hex");
  return Buffer.from(JSON.stringify({ ...envelope, signature }), "utf8").toString("base64url");
}

export function decodeCursor<T extends JsonObject>(secret: string, operation: string, value: string): T {
  try {
    const decoded = JSON.parse(decodeCanonicalBase64Url(value).toString("utf8")) as CursorEnvelope<T> & { signature?: unknown };
    if (decoded.version !== 1 || decoded.operation !== operation || typeof decoded.signature !== "string" || typeof decoded.payload !== "object" || decoded.payload === null) {
      throw new Error("cursor envelope is invalid");
    }
    const serialized = JSON.stringify({ operation: decoded.operation, payload: decoded.payload, version: decoded.version });
    const expected = Buffer.from(crypto.createHmac("sha256", secret).update(serialized).digest("hex"), "utf8");
    const actual = Buffer.from(decoded.signature, "utf8");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("cursor signature is invalid");
    return decoded.payload;
  } catch (error) {
    throw new YifangyunError(`Invalid cursor: ${error instanceof Error ? error.message : String(error)}`, {
      code: "YFY_CURSOR_INVALID",
      phase: "cursor_decode",
      suggestedAction: "Restart the same operation without cursor."
    });
  }
}
