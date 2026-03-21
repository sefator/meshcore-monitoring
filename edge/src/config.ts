const env = Bun.env;

export const config = {
  locationId: env.LOCATION_ID ?? "demo-location",
  windowHours: Number(env.WINDOW_HOURS ?? 8),
  ingestUrl: env.INGEST_URL ?? "http://localhost:8080/ingest",
  pollConcurrency: Number(env.POLL_CONCURRENCY ?? 1),
  repeatersConfigPath: env.REPEATERS_CONFIG_PATH ?? "config/repeaters.json",
  companion: {
    connection: (env.COMPANION_CONNECTION ?? "tcp") as "tcp" | "serial",
    host: env.COMPANION_TCP_HOST ?? "127.0.0.1",
    port: Number(env.COMPANION_TCP_PORT ?? 5000),
    serialPath: env.COMPANION_SERIAL_PATH ?? "/dev/ttyACM0",
    telemetryTimeoutMs: Number(env.COMPANION_TELEMETRY_TIMEOUT_MS ?? 15000),
    statusTimeoutMs: Number(env.COMPANION_STATUS_TIMEOUT_MS ?? 30000),
  },
  auth: {
    tokenTtlSeconds: Number(env.AUTH_TOKEN_TTL_SECONDS ?? 24 * 60 * 60),
  },
};
