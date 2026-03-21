import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { config } from "./config.js";
import { getDeviceIdentity, signWithDevice } from "./companion.js";
import { buildJwtSigningInput, signJwt } from "./utils/jwt.js";

type SignedAuthTokenOptions = {
  publicKeyHex: string;
  privateKeyHex: string;
  deviceId: string;
  locationId: string;
  tokenTtlSeconds?: number;
  nowSeconds?: number;
};

type AuthTokenPayloadOptions = {
  publicKeyHex: string;
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
  const signingInput = buildAuthTokenSigningInput(options);
  const signatureHex = signJwt(signingInput, options.privateKeyHex);
  return `${signingInput}.${signatureHex}`;
}

function buildAuthTokenSigningInput(options: AuthTokenPayloadOptions) {
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
  return buildJwtSigningInput(header, payload);
}

export async function createAuthToken(identity?: {
  publicKeyHex: string;
  deviceId: string;
}) {
  const resolvedIdentity = identity ?? (await getDeviceIdentity());
  const signingInput = buildAuthTokenSigningInput({
    publicKeyHex: resolvedIdentity.publicKeyHex,
    deviceId: resolvedIdentity.deviceId,
    locationId: config.locationId,
    tokenTtlSeconds: config.auth.tokenTtlSeconds
  });
  const signature = await signWithDevice(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString("hex")}`;
}
