import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import type { BatchPayload, MetricSample, NeighborSample } from "../edge/src/types.js";
import { createSignedAuthToken, deriveSigningKeyPair } from "../edge/src/signing.js";

type Options = {
  endpoint: string;
  intervalMs: number;
  iterations?: number;
  durationSeconds?: number;
  repeaters: number;
  deviceId: string;
  locationId: string;
  seed: string;
  privateKeyHex?: string;
  publicKeyHex?: string;
  tokenTtlSeconds: number;
  dryRun: boolean;
  printReferenceSql: boolean;
};

type RepeaterState = {
  repeaterId: string;
  neighborId: string;
  power: MetricSample["power"];
  uptimeSeconds: number;
  battery: number;
  baseRssi: number;
  baseSnr: number;
  packetsSent: number;
  packetsRecv: number;
};

type IterationData = {
  metrics: MetricSample[];
  neighbors: NeighborSample[];
  degraded: boolean;
};

const HELP_TEXT = `Generate synthetic repeater batches and post them directly to ingest.

Usage:
  bun run mock-ingest -- [options]

Options:
  --endpoint <url>             Ingest endpoint URL (default: http://localhost:8080/ingest)
  --interval-ms <ms>           Delay between batches in milliseconds (default: 5000)
  --iterations <count>         Number of batches to send (default: 12)
  --duration-seconds <secs>    Send until the duration elapses; cannot be used with --iterations
  --repeaters <count>          Number of mock repeaters per batch (default: 4)
  --device-id <id>             Device identifier carried in the batch and auth token
  --location-id <id>           Uppercase three-letter IATA location identifier carried in the batch and auth token
  --seed <value>               Deterministic seed for repeaters and default signing keys
  --private-key-hex <hex>      Ed25519 private key; overrides seed-derived key
  --public-key-hex <hex>       Ed25519 public key; overrides seed-derived key
  --token-ttl-seconds <secs>   Auth token TTL (default: 86400)
  --dry-run                    Build batches and print summaries without POSTing
  --print-reference-sql        Print SQL to seed the matching location/repeaters, then exit
  --help                       Show this help

Examples:
  bun run mock-ingest -- --iterations 6 --interval-ms 2000
  bun run mock-ingest -- --duration-seconds 60 --repeaters 8 --seed LAX --location-id LAX
  bun run mock-ingest -- --dry-run --iterations 1 --repeaters 3
  bun run mock-ingest -- --print-reference-sql --location-id SFO --repeaters 4
`;

const DEFAULTS = {
  endpoint: "http://localhost:8080/ingest",
  intervalMs: 5000,
  iterations: 12,
  repeaters: 4,
  deviceId: "mock-device",
  locationId: "SFO",
  seed: "mock-ingest-demo-seed",
  tokenTtlSeconds: 24 * 60 * 60
} satisfies Omit<Options, "durationSeconds" | "privateKeyHex" | "publicKeyHex" | "dryRun" | "printReferenceSql">;

function fail(message: string): never {
  console.error(`mock-ingest: ${message}`);
  process.exit(1);
}

function parsePositiveInt(value: string, flag: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${flag} must be a positive integer`);
  }
  return parsed;
}

function validateHexKey(value: string, flag: string) {
  if (!/^[0-9A-F]+$/i.test(value) || value.length !== 64) {
    fail(`${flag} must be a 64-character hex string`);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sqlQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function hashBytes(input: string) {
  return createHash("sha256").update(input).digest();
}

function hashNumber(input: string) {
  return hashBytes(input).readUInt32BE(0);
}

function createRng(seed: string) {
  let state = hashNumber(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      endpoint: { type: "string" },
      "interval-ms": { type: "string" },
      iterations: { type: "string" },
      "duration-seconds": { type: "string" },
      repeaters: { type: "string" },
      "device-id": { type: "string" },
      "location-id": { type: "string" },
      seed: { type: "string" },
      "private-key-hex": { type: "string" },
      "public-key-hex": { type: "string" },
      "token-ttl-seconds": { type: "string" },
      "dry-run": { type: "boolean" },
      "print-reference-sql": { type: "boolean" },
      help: { type: "boolean" }
    },
    strict: true,
    allowPositionals: false
  });

  if (values.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const iterations = values.iterations ? parsePositiveInt(values.iterations, "--iterations") : undefined;
  const durationSeconds = values["duration-seconds"]
    ? parsePositiveInt(values["duration-seconds"], "--duration-seconds")
    : undefined;

  if (iterations && durationSeconds) {
    fail("use either --iterations or --duration-seconds, not both");
  }

  const privateKeyHex = values["private-key-hex"]?.toUpperCase();
  const publicKeyHex = values["public-key-hex"]?.toUpperCase();

  if ((privateKeyHex && !publicKeyHex) || (!privateKeyHex && publicKeyHex)) {
    fail("--private-key-hex and --public-key-hex must be provided together");
  }

  if (privateKeyHex && publicKeyHex) {
    validateHexKey(privateKeyHex, "--private-key-hex");
    validateHexKey(publicKeyHex, "--public-key-hex");
  }

  return {
    endpoint: values.endpoint ?? DEFAULTS.endpoint,
    intervalMs: values["interval-ms"] ? parsePositiveInt(values["interval-ms"], "--interval-ms") : DEFAULTS.intervalMs,
    iterations: iterations ?? (durationSeconds ? undefined : DEFAULTS.iterations),
    durationSeconds,
    repeaters: values.repeaters ? parsePositiveInt(values.repeaters, "--repeaters") : DEFAULTS.repeaters,
    deviceId: values["device-id"] ?? DEFAULTS.deviceId,
    locationId: values["location-id"] ?? DEFAULTS.locationId,
    seed: values.seed ?? DEFAULTS.seed,
    privateKeyHex,
    publicKeyHex,
    tokenTtlSeconds: values["token-ttl-seconds"]
      ? parsePositiveInt(values["token-ttl-seconds"], "--token-ttl-seconds")
      : DEFAULTS.tokenTtlSeconds,
    dryRun: values["dry-run"] ?? false,
    printReferenceSql: values["print-reference-sql"] ?? false
  };
}

function createRepeaterStates(seed: string, count: number): RepeaterState[] {
  const powerModes: MetricSample["power"][] = ["mains", "battery", "solar"];
  return Array.from({ length: count }, (_, index) => {
    const prefix = hashBytes(`${seed}:repeater:${index}`).subarray(0, 6).toString("hex").toUpperCase();
    const rng = createRng(`${seed}:repeater:${index}`);
    return {
      repeaterId: `mock-rpt-${String(index + 1).padStart(2, "0")}-${prefix.slice(0, 4)}`,
      neighborId: prefix,
      power: powerModes[index % powerModes.length],
      uptimeSeconds: 12 * 60 * 60 + Math.floor(rng() * 36 * 60 * 60),
      battery: 52 + Math.floor(rng() * 44),
      baseRssi: -88 + rng() * 22,
      baseSnr: -2 + rng() * 12,
      packetsSent: 800 + Math.floor(rng() * 600),
      packetsRecv: 780 + Math.floor(rng() * 560)
    };
  });
}

function buildIterationData(
  states: RepeaterState[],
  options: Options,
  iteration: number,
  windowStart: Date,
  windowEnd: Date
): IterationData {
  const metrics: MetricSample[] = [];
  const neighbors: NeighborSample[] = [];
  let degraded = false;
  const intervalSeconds = Math.max(1, Math.round(options.intervalMs / 1000));
  const windowSpanMs = Math.max(1, windowEnd.getTime() - windowStart.getTime());

  for (const [index, state] of states.entries()) {
    const rng = createRng(`${options.seed}:iter:${iteration}:repeater:${index}`);
    state.uptimeSeconds += intervalSeconds + Math.floor(rng() * 3);
    state.packetsSent += 18 + Math.floor(rng() * 40);
    state.packetsRecv += 16 + Math.floor(rng() * 36);

    if (state.power === "battery") {
      state.battery = clamp(state.battery - (rng() > 0.85 ? 1 : 0), 15, 100);
    } else if (state.power === "solar") {
      state.battery = clamp(state.battery + (rng() > 0.6 ? 1 : -1), 25, 100);
    } else {
      state.battery = clamp(98 + Math.round(rng() * 2), 97, 100);
    }

    const elapsedFactor = iteration / Math.max(1, states.length);
    const rssi = round(
      clamp(state.baseRssi + Math.sin(elapsedFactor + index) * 4 + (rng() - 0.5) * 5, -110, -42),
      1
    );
    const snr = round(clamp(state.baseSnr + Math.cos(elapsedFactor + index / 2) * 3 + (rng() - 0.5) * 4, -12, 18), 1);
    const linkQuality = round(
      clamp(0.2 + (snr + 12) / 36 + (rssi + 110) / 90 + (rng() - 0.5) * 0.12, 0.12, 0.99),
      2
    );
    const queueLen = rng() > 0.92 ? 1 + Math.floor(rng() * 2) : 0;
    const time = new Date(windowStart.getTime() + Math.floor(rng() * windowSpanMs)).toISOString();
    const neighborIndexes = Array.from(
      new Set([
        (index + 1) % states.length,
        (index + states.length - 1) % states.length,
        states.length > 4 && index % 2 === 0 ? (index + 2) % states.length : undefined
      ].filter((value): value is number => value !== undefined && value !== index))
    );

    metrics.push({
      time,
      repeater_id: state.repeaterId,
      rssi,
      snr,
      battery: Math.round(state.battery),
      power: state.power,
      uptime: state.uptimeSeconds,
      link_quality: linkQuality,
      neighbors_count: neighborIndexes.length,
      packets_sent: state.packetsSent,
      packets_recv: state.packetsRecv,
      queue_len: queueLen
    });

    degraded ||= linkQuality < 0.35 || queueLen > 1;

    for (const neighborIndex of neighborIndexes) {
      const neighbor = states[neighborIndex];
      const distance = Math.min(
        (neighborIndex - index + states.length) % states.length,
        (index - neighborIndex + states.length) % states.length
      );
      neighbors.push({
        time,
        repeater_id: state.repeaterId,
        neighbor_id: neighbor.neighborId,
        link_quality: round(clamp(linkQuality - 0.06 * distance + (rng() - 0.5) * 0.08, 0.05, 0.99), 2),
        hops: distance > 1 ? 2 : 1,
        rssi: round(clamp(rssi - distance * 4 + (rng() - 0.5) * 3, -118, -45), 1),
        snr: round(clamp(snr - distance * 0.8 + (rng() - 0.5) * 2, -15, 18), 1)
      });
    }
  }

  if (states.length === 1) {
    metrics[0].neighbors_count = 0;
  }

  return { metrics, neighbors, degraded };
}

function buildBatch(
  options: Options,
  iteration: number,
  windowStart: Date,
  windowEnd: Date,
  states: RepeaterState[]
): BatchPayload {
  const iterationData = buildIterationData(states, options, iteration, windowStart, windowEnd);
  return {
    device_id: options.deviceId,
    location_id: options.locationId,
    batch_id: `mock-${crypto.randomUUID()}`,
    sent_at: new Date().toISOString(),
    window: {
      from: windowStart.toISOString(),
      to: windowEnd.toISOString()
    },
    metrics: iterationData.metrics,
    neighbors: iterationData.neighbors,
    heartbeat: {
      time: windowEnd.toISOString(),
      status: iterationData.degraded ? "degraded" : "ok",
      version: "mock-ingest/1"
    }
  };
}

function summarizeBatch(batch: BatchPayload) {
  const avgRssi =
    batch.metrics.reduce((sum, sample) => sum + (sample.rssi ?? 0), 0) / Math.max(1, batch.metrics.length);
  const avgLink =
    batch.metrics.reduce((sum, sample) => sum + (sample.link_quality ?? 0), 0) / Math.max(1, batch.metrics.length);
  return `metrics=${batch.metrics.length} neighbors=${batch.neighbors.length} avg_rssi=${round(avgRssi, 1)} avg_link=${round(avgLink, 2)}`;
}

function printReferenceSql(options: Options, states: RepeaterState[]) {
  const locationId = sqlQuote(options.locationId);
  const locationName = sqlQuote(`Mock location ${options.locationId}`);
  const networkId = sqlQuote(`mock-${options.seed}`);
  const repeaterValues = states
    .map((state, index) => {
      const repeaterId = sqlQuote(state.repeaterId);
      const label = sqlQuote(`Mock repeater ${index + 1}`);
      return `  (${repeaterId}, ${locationId}, ${label})`;
    })
    .join(",\n");

  console.log(`INSERT INTO locations (location_id, name, network_id)
VALUES (${locationId}, ${locationName}, ${networkId})
ON CONFLICT (location_id) DO UPDATE
SET
  name = EXCLUDED.name,
  network_id = EXCLUDED.network_id;

INSERT INTO repeaters (repeater_id, location_id, label)
VALUES
${repeaterValues}
ON CONFLICT (repeater_id) DO UPDATE
SET
  location_id = EXCLUDED.location_id,
  label = EXCLUDED.label;`);
}

async function postBatch(batch: BatchPayload, options: Options, publicKeyHex: string, privateKeyHex: string) {
  const token = createSignedAuthToken({
    publicKeyHex,
    privateKeyHex,
    deviceId: options.deviceId,
    locationId: options.locationId,
    tokenTtlSeconds: options.tokenTtlSeconds
  });

  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": options.deviceId,
      "X-Auth-Token": token
    },
    body: JSON.stringify(batch)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ingest returned ${response.status}: ${body || response.statusText}`);
  }
}

async function main() {
  const options = parseOptions();
  const keyPair =
    options.privateKeyHex && options.publicKeyHex
      ? { privateKeyHex: options.privateKeyHex, publicKeyHex: options.publicKeyHex }
      : deriveSigningKeyPair(options.seed);
  const states = createRepeaterStates(options.seed, options.repeaters);
  const runUntil = options.durationSeconds ? Date.now() + options.durationSeconds * 1000 : undefined;

  if (options.printReferenceSql) {
    printReferenceSql(options, states);
    return;
  }

  console.log(
    `[mock-ingest] target=${options.endpoint} repeaters=${options.repeaters} interval_ms=${options.intervalMs} mode=${
      options.durationSeconds ? `duration:${options.durationSeconds}s` : `iterations:${options.iterations}`
    } dry_run=${options.dryRun} device=${options.deviceId} location=${options.locationId} public_key=${keyPair.publicKeyHex.slice(0, 16)}...`
  );

  let iteration = 0;
  let windowStart = new Date(Date.now() - options.intervalMs);

  while (true) {
    if (options.iterations !== undefined && iteration >= options.iterations) {
      break;
    }
    if (runUntil !== undefined && Date.now() >= runUntil) {
      break;
    }

    const windowEnd = new Date();
    const batch = buildBatch(options, iteration, windowStart, windowEnd, states);
    const summary = summarizeBatch(batch);

    if (options.dryRun) {
      console.log(`[mock-ingest] dry-run batch=${iteration + 1} ${summary}`);
    } else {
      await postBatch(batch, options, keyPair.publicKeyHex, keyPair.privateKeyHex);
      console.log(`[mock-ingest] posted batch=${iteration + 1} id=${batch.batch_id} ${summary}`);
    }

    iteration += 1;
    windowStart = windowEnd;

    if (options.iterations !== undefined && iteration >= options.iterations) {
      break;
    }
    if (runUntil !== undefined && Date.now() >= runUntil) {
      break;
    }

    await Bun.sleep(options.intervalMs);
  }

  console.log(`[mock-ingest] complete batches=${iteration}`);
}

await main();
