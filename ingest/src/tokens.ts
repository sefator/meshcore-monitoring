import { ed25519 } from "@noble/curves/ed25519.js";
import { z } from "zod";
import { base64urlDecode } from "./utils/base64.js";
import { config } from "./config.js";
import { locationIdSchema } from "./types.js";

const jwtPayloadSchema = z
  .object({
    publicKey: z.string(),
    iat: z.number(),
    exp: z.number(),
    deviceId: z.string().optional(),
    locationId: locationIdSchema.optional()
  })
  .passthrough();

type JwtPayload = z.infer<typeof jwtPayloadSchema>;

function getTokenPayloadError(error: z.ZodError<JwtPayload>) {
  const locationIssue = error.issues.find((issue) => issue.path[0] === "locationId");
  if (locationIssue) {
    return `invalid token locationId: ${locationIssue.message}`;
  }

  return "invalid token payload";
}

export function verifyJwtToken(token: string): { valid: boolean; payload: JwtPayload; error?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, payload: {} as JwtPayload, error: "invalid token format" };
  }
  const [encodedHeader, encodedPayload, signatureHex] = parts;
  try {
    const header = JSON.parse(base64urlDecode(encodedHeader).toString("utf8"));
    const parsedPayload = jwtPayloadSchema.safeParse(
      JSON.parse(base64urlDecode(encodedPayload).toString("utf8"))
    );
    if (header.alg !== "Ed25519" || header.typ !== "JWT") {
      return { valid: false, payload: {} as JwtPayload, error: "unsupported token" };
    }
    if (!parsedPayload.success) {
      return {
        valid: false,
        payload: {} as JwtPayload,
        error: getTokenPayloadError(parsedPayload.error)
      };
    }
    const payload = parsedPayload.data;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = Buffer.from(signatureHex, "hex");
    const publicKey = Buffer.from(payload.publicKey, "hex");
    const message = new TextEncoder().encode(signingInput);
    const isValid = ed25519.verify(signature, message, publicKey);
    if (!isValid) {
      return { valid: false, payload: {} as JwtPayload, error: "signature mismatch" };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - payload.iat) > config.auth.allowedSkewSeconds) {
      return { valid: false, payload: {} as JwtPayload, error: "iat skew" };
    }
    if (payload.exp && payload.exp < now) {
      return { valid: false, payload: {} as JwtPayload, error: "token expired" };
    }
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, payload: {} as JwtPayload, error: err instanceof Error ? err.message : "token parse error" };
  }
}
