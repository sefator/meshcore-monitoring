const env = Bun.env;

const startupModes = [
  "scheduled",
  "immediate-once",
  "immediate-staggered",
] as const;

export type StartupMode = (typeof startupModes)[number];

const DEFAULT_STARTUP_MODE: StartupMode = "scheduled";
const DEFAULT_STARTUP_STAGGER_DELAY_MS = 1000;

function readStartupMode(value: string | undefined): StartupMode {
  if (value && startupModes.includes(value as StartupMode)) {
    return value as StartupMode;
  }

  return DEFAULT_STARTUP_MODE;
}

function readNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.trunc(parsed);
}

export const config = {
  locationId: env.LOCATION_ID ?? "demo-location",
  windowHours: Number(env.WINDOW_HOURS ?? 8),
  ingestUrl: env.INGEST_URL ?? "http://localhost:8080/ingest",
  pollConcurrency: Number(env.POLL_CONCURRENCY ?? 1),
  repeatersConfigPath: env.REPEATERS_CONFIG_PATH ?? "config/repeaters.json",
  startup: {
    mode: readStartupMode(env.STARTUP_MODE),
    staggerDelayMs: readNonNegativeInteger(
      env.STARTUP_STAGGER_DELAY_MS,
      DEFAULT_STARTUP_STAGGER_DELAY_MS,
    ),
  },
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
