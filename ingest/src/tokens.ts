import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlDecode } from "./utils/base64.js";
import { config } from "./config.js";

type JwtPayload = {
  publicKey: string;
  iat: number;
  exp: number;
  deviceId?: string;
  locationId?: string;
};

export function verifyJwtToken(token: string): { valid: boolean; payload: JwtPayload; error?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, payload: {} as JwtPayload, error: "invalid token format" };
  }
  const [encodedHeader, encodedPayload, signatureHex] = parts;
  try {
    const header = JSON.parse(base64urlDecode(encodedHeader).toString("utf8"));
    const payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
    if (header.alg !== "Ed25519" || header.typ !== "JWT") {
      return { valid: false, payload: {} as JwtPayload, error: "unsupported token" };
    }
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
