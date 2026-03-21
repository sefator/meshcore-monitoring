import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlEncode } from "./base64url.js";

export function buildJwtSigningInput(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const headerJson = JSON.stringify(header);
  const payloadJson = JSON.stringify(payload);
  const encodedHeader = base64urlEncode(new TextEncoder().encode(headerJson));
  const encodedPayload = base64urlEncode(new TextEncoder().encode(payloadJson));
  return `${encodedHeader}.${encodedPayload}`;
}

export function signJwt(signingInput: string, privateKeyHex: string) {
  const message = new TextEncoder().encode(signingInput);
  const privateKey = Buffer.from(privateKeyHex, "hex");
  const signature = ed25519.sign(message, privateKey);
  return Buffer.from(signature).toString("hex");
}
