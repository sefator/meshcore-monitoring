export type ServerConfig = {
  port: number;
  host: string;
};

export type SignatureAlgo = "ed25519" | "ecdsa" | "unknown";

export type CompanionDevice = {
  deviceId: string;
  locationId: string;
  publicKey: string;
  signatureAlgo: SignatureAlgo;
  revokedAt: Date | null;
};

const env = Bun.env;

export const config = {
  server: {
    port: Number(env.INGEST_PORT ?? 8080),
    host: env.INGEST_HOST ?? "0.0.0.0",
  },
  auth: {
    allowedSkewSeconds: Number(env.AUTH_ALLOWED_SKEW_SECONDS ?? 5 * 60),
  },
  database: {
    url:
      env.DATABASE_URL ??
      "postgresql://meshcore:meshcore@timescaledb:5432/meshcore",
  },
};
