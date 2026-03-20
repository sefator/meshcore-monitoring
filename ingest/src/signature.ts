import crypto from "crypto";
import type { SignatureAlgo } from "./config.js";

type VerifyInput = {
  body: Uint8Array;
  signatureBase64: string;
  publicKey: string;
  algo: SignatureAlgo;
};

export function verifySignature({ body, signatureBase64, publicKey, algo }: VerifyInput) {
  if (algo === "ed25519") {
    return crypto.verify(null, body, { key: publicKey, format: "pem" }, Buffer.from(signatureBase64, "base64"));
  }
  if (algo === "ecdsa") {
    return crypto.verify("sha256", body, { key: publicKey, format: "pem" }, Buffer.from(signatureBase64, "base64"));
  }
  return false;
}
