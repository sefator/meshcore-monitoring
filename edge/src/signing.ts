import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { config } from "./config.js";
import {
  exportDevicePrivateKey,
  getDeviceIdentity,
  signWithDevice
} from "./companion.js";
import { log } from "./log.js";
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

type DeviceSigningIdentity = {
  publicKeyHex: string;
  deviceId: string;
};

export type SigningSelfCheckResult = {
  verified: boolean;
  deviceId: string;
  claimedPublicKeyFingerprint: string;
  verifiedWithPublicKeyFingerprint: string | null;
  publicKeySource: "self-info" | "exported-private-key";
  messageLength: number;
  messageSha256: string;
  signatureLength: number;
  signatureSha256: string;
};

const SIGNING_SELF_CHECK_CONTEXT = "meshcore-monitoring:signing-self-test:v1";
let localSigningMaterialPromise: Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
}> | null = null;
let localSigningMaterialClaimedHex: string | null = null;
let resolvedSigningPublicKeyPromise: Promise<{
  publicKeyHex: string;
  source: "self-info" | "exported-private-key";
}> | null = null;
let resolvedSigningPublicKeyClaimedHex: string | null = null;

function toSha256Hex(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function toPublicKeyFingerprint(publicKeyHex: string) {
  const normalizedKey = publicKeyHex.toUpperCase();
  if (normalizedKey.length <= 16) {
    return normalizedKey;
  }

  return `${normalizedKey.slice(0, 8)}…${normalizedKey.slice(-8)}`;
}

function buildSigningSelfCheckMessage(identity: DeviceSigningIdentity) {
  return `${SIGNING_SELF_CHECK_CONTEXT}:${identity.deviceId}:${identity.publicKeyHex.toUpperCase()}`;
}

function toPublicKeyHex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex").toUpperCase();
}

function tryDerivePublicKeyFromSecretKey(secretKey: Uint8Array) {
  try {
    return toPublicKeyHex(ed25519.getPublicKey(secretKey));
  } catch {
    return null;
  }
}

function getExportedPrivateKeyCandidates(exportedPrivateKey: Uint8Array) {
  const candidates = new Map<string, "exported-private-key">();
  if (exportedPrivateKey.length >= 32) {
    const derivedPublicKey = tryDerivePublicKeyFromSecretKey(exportedPrivateKey.subarray(0, 32));
    if (derivedPublicKey) {
      candidates.set(derivedPublicKey, "exported-private-key");
    }
  }
  if (exportedPrivateKey.length >= 64) {
    candidates.set(toPublicKeyHex(exportedPrivateKey.subarray(32, 64)), "exported-private-key");
  }
  return candidates;
}

function verifySignature(signature: Uint8Array, messageBytes: Uint8Array, publicKeyHex: string) {
  return ed25519.verify(signature, messageBytes, Buffer.from(publicKeyHex, "hex"));
}

async function resolveLocalSigningMaterial(identity?: DeviceSigningIdentity) {
  const resolvedIdentity = identity ?? (await getDeviceIdentity());
  const claimedPublicKeyHex = resolvedIdentity.publicKeyHex.toUpperCase();
  if (localSigningMaterialPromise && localSigningMaterialClaimedHex === claimedPublicKeyHex) {
    return localSigningMaterialPromise;
  }

  localSigningMaterialClaimedHex = claimedPublicKeyHex;
  localSigningMaterialPromise = (async () => {
    const exportedPrivateKey = await exportDevicePrivateKey();
    if (exportedPrivateKey.length < 32) {
      throw new Error("exported private key too short");
    }

    const secretKey = exportedPrivateKey.subarray(0, 32);
    const privateKeyHex = Buffer.from(secretKey).toString("hex").toUpperCase();
    const publicKeyHex = toPublicKeyHex(ed25519.getPublicKey(secretKey));

    if (exportedPrivateKey.length >= 64) {
      const trailingPublicKeyHex = toPublicKeyHex(exportedPrivateKey.subarray(32, 64));
      if (trailingPublicKeyHex !== publicKeyHex) {
        log.warn("exported companion key material is internally inconsistent", {
          deviceId: resolvedIdentity.deviceId,
          derivedPublicKeyFingerprint: toPublicKeyFingerprint(publicKeyHex),
          trailingPublicKeyFingerprint: toPublicKeyFingerprint(trailingPublicKeyHex)
        });
      }
    }

    if (publicKeyHex !== claimedPublicKeyHex) {
      log.warn("companion exported signing key differs from self-reported key", {
        deviceId: resolvedIdentity.deviceId,
        claimedPublicKeyFingerprint: toPublicKeyFingerprint(claimedPublicKeyHex),
        signingPublicKeyFingerprint: toPublicKeyFingerprint(publicKeyHex)
      });
    }

    return { privateKeyHex, publicKeyHex };
  })().catch((err) => {
    localSigningMaterialPromise = null;
    localSigningMaterialClaimedHex = null;
    throw err;
  });

  return localSigningMaterialPromise;
}

async function resolveSigningPublicKey(identity?: DeviceSigningIdentity) {
  const resolvedIdentity = identity ?? (await getDeviceIdentity());
  const claimedPublicKeyHex = resolvedIdentity.publicKeyHex.toUpperCase();
  if (resolvedSigningPublicKeyPromise && resolvedSigningPublicKeyClaimedHex === claimedPublicKeyHex) {
    return resolvedSigningPublicKeyPromise;
  }

  resolvedSigningPublicKeyClaimedHex = claimedPublicKeyHex;
  resolvedSigningPublicKeyPromise = (async () => {
    const messageBytes = new TextEncoder().encode(buildSigningSelfCheckMessage(resolvedIdentity));
    const signature = await signWithDevice(messageBytes);
    if (verifySignature(signature, messageBytes, claimedPublicKeyHex)) {
      return { publicKeyHex: claimedPublicKeyHex, source: "self-info" as const };
    }

    const exportedPrivateKey = await exportDevicePrivateKey();
    const candidates = getExportedPrivateKeyCandidates(exportedPrivateKey);
    for (const [publicKeyHex, source] of candidates.entries()) {
      if (!verifySignature(signature, messageBytes, publicKeyHex)) {
        continue;
      }

      log.warn("companion signing key differs from self-reported key", {
        deviceId: resolvedIdentity.deviceId,
        claimedPublicKeyFingerprint: toPublicKeyFingerprint(claimedPublicKeyHex),
        signingPublicKeyFingerprint: toPublicKeyFingerprint(publicKeyHex)
      });
      return { publicKeyHex, source };
    }

    throw new Error("unable to resolve companion signing public key");
  })().catch((err) => {
    resolvedSigningPublicKeyPromise = null;
    resolvedSigningPublicKeyClaimedHex = null;
    throw err;
  });

  return resolvedSigningPublicKeyPromise;
}

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
  try {
    const localSigningMaterial = await resolveLocalSigningMaterial(resolvedIdentity);
    return createSignedAuthToken({
      publicKeyHex: localSigningMaterial.publicKeyHex,
      privateKeyHex: localSigningMaterial.privateKeyHex,
      deviceId: resolvedIdentity.deviceId,
      locationId: config.locationId,
      tokenTtlSeconds: config.auth.tokenTtlSeconds
    });
  } catch (err) {
    log.warn("falling back to companion sign() for auth token", {
      deviceId: resolvedIdentity.deviceId,
      claimedPublicKeyFingerprint: toPublicKeyFingerprint(resolvedIdentity.publicKeyHex),
      error: err instanceof Error ? err.message : String(err)
    });
    const signingPublicKey = await resolveSigningPublicKey(resolvedIdentity);
    const signingInput = buildAuthTokenSigningInput({
      publicKeyHex: signingPublicKey.publicKeyHex,
      deviceId: resolvedIdentity.deviceId,
      locationId: config.locationId,
      tokenTtlSeconds: config.auth.tokenTtlSeconds
    });
    const signature = await signWithDevice(new TextEncoder().encode(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString("hex")}`;
  }
}

export async function runSigningSelfCheck(
  identity?: DeviceSigningIdentity,
): Promise<SigningSelfCheckResult> {
  const resolvedIdentity = identity ?? (await getDeviceIdentity());
  const message = buildSigningSelfCheckMessage(resolvedIdentity);
  const messageBytes = new TextEncoder().encode(message);
  const signature = await signWithDevice(messageBytes);
  const signingPublicKey = await resolveSigningPublicKey(resolvedIdentity);
  const verified = verifySignature(signature, messageBytes, signingPublicKey.publicKeyHex);

  return {
    verified,
    deviceId: resolvedIdentity.deviceId,
    claimedPublicKeyFingerprint: toPublicKeyFingerprint(resolvedIdentity.publicKeyHex),
    verifiedWithPublicKeyFingerprint: verified
      ? toPublicKeyFingerprint(signingPublicKey.publicKeyHex)
      : null,
    publicKeySource: signingPublicKey.source,
    messageLength: messageBytes.length,
    messageSha256: toSha256Hex(messageBytes),
    signatureLength: signature.length,
    signatureSha256: toSha256Hex(signature)
  };
}
