import { config } from "./config.js";
import { buildJwtSigningInput, signJwt } from "./utils/jwt.js";
export function createAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.auth.tokenTtlSeconds;
  const header = { alg: "Ed25519", typ: "JWT" } as const;
  const payload = {
    publicKey: config.auth.publicKeyHex.toUpperCase(),
    iat: now,
    exp,
    deviceId: config.deviceId,
    locationId: config.locationId
  };
  const signingInput = buildJwtSigningInput(header, payload);
  const signatureHex = signJwt(signingInput, config.auth.privateKeyHex);
  return `${signingInput}.${signatureHex}`;
}
