import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { config } from "./config.js";
import { buildJwtSigningInput, signJwt } from "./utils/jwt.js";

type SignedAuthTokenOptions = {
  publicKeyHex: string;
  privateKeyHex: string;
  deviceId: string;
  locationId: string;
  tokenTtlSeconds?: number;
  nowSeconds?: number;
};

export function deriveSigningKeyPair(seed: string) {
  const privateKey = createHash("sha256").update(seed).digest();
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKeyHex: privateKey.toString("hex").toUpperCase(),
    publicKeyHex: Buffer.from(publicKey).toString("hex").toUpperCase()
  };
}

export function createSignedAuthToken(options: SignedAuthTokenOptions) {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + (options.tokenTtlSeconds ?? 24 * 60 * 60);
  const header = { alg: "Ed25519", typ: "JWT" } as const;
  const payload = {
    publicKey: options.publicKeyHex.toUpperCase(),
    iat: now,
    exp,
    deviceId: options.deviceId,
    locationId: options.locationId
  };
  const signingInput = buildJwtSigningInput(header, payload);
  const signatureHex = signJwt(signingInput, options.privateKeyHex);
  return `${signingInput}.${signatureHex}`;
}

export function createAuthToken() {
  return createSignedAuthToken({
    publicKeyHex: config.auth.publicKeyHex,
    privateKeyHex: config.auth.privateKeyHex,
    deviceId: config.deviceId,
    locationId: config.locationId,
    tokenTtlSeconds: config.auth.tokenTtlSeconds
  });
}
