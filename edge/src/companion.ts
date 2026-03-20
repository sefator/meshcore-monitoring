import {
  CayenneLpp,
  TCPConnection,
  NodeJSSerialConnection,
} from "@liamcottle/meshcore.js";
import type { MetricSample, NeighborSample, Repeater } from "./types.js";
import { config } from "./config.js";
import { log } from "./log.js";

type CompanionConnection = {
  connect(): Promise<void>;
  sendCommandAppStart(): Promise<void>;
  getContacts(): Promise<unknown>;
  getStatus(publicKey: Uint8Array, timeoutMs: number): Promise<CompanionStats>;
  login(
    publicKey: Uint8Array,
    password: string,
    timeoutMs?: number,
  ): Promise<unknown>;
  getTelemetry(
    publicKey: Uint8Array,
    timeoutMs: number,
  ): Promise<TelemetryResponse>;
  findContactByPublicKeyPrefix(
    prefix: Uint8Array | Buffer,
  ): Promise<CompanionContact | null>;
};

type CompanionContact = {
  publicKey: Uint8Array;
  advName?: string;
};

type CompanionStats = {
  batt_milli_volts: number;
  curr_tx_queue_len: number;
  noise_floor: number;
  last_rssi: number;
  n_packets_recv: number;
  n_packets_sent: number;
  total_air_time_secs: number;
  total_up_time_secs: number;
  n_sent_flood: number;
  n_sent_direct: number;
  n_recv_flood: number;
  n_recv_direct: number;
  err_events: number;
  last_snr: number;
  n_direct_dups: number;
  n_flood_dups: number;
};

type TelemetryResponse = {
  pubKeyPrefix: Uint8Array;
  lppSensorData: Uint8Array;
};

function derivePublicKeyPrefix(hexKey: string) {
  return hexToBytes(hexKey).subarray(0, 6);
}

let connectionPromise: Promise<CompanionConnection> | null = null;

async function withConnection<T>(
  fn: (conn: CompanionConnection) => Promise<T>,
): Promise<T> {
  const conn = await ensureConnection();
  try {
    return await fn(conn);
  } catch (err) {
    log.error("companion call failed, resetting connection", err);
    connectionPromise = null;
    throw err;
  }
}

function hexToBytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

async function resolveContact(
  conn: CompanionConnection,
  repeater: Repeater,
  publicKeyPrefix: Uint8Array,
): Promise<CompanionContact> {
  const contact = await conn.findContactByPublicKeyPrefix(
    Buffer.from(publicKeyPrefix),
  );
  if (!contact) {
    log.error("companion contact missing", repeater.repeaterId);
    throw new Error(`contact ${repeater.repeaterId} not found on companion`);
  }
  return contact;
}

function createConnection(): CompanionConnection {
  if (config.companion.connection === "serial") {
    return new NodeJSSerialConnection(
      config.companion.serialPath,
    ) as unknown as CompanionConnection;
  }
  return new TCPConnection(
    config.companion.host,
    config.companion.port,
  ) as unknown as CompanionConnection;
}

async function ensureConnection(): Promise<CompanionConnection> {
  if (connectionPromise) {
    log.debug("reusing companion connection");
    return connectionPromise;
  }
  connectionPromise = (async () => {
    const connectionInfo =
      config.companion.connection === "serial"
        ? `serial@${config.companion.serialPath}`
        : `tcp://${config.companion.host}:${config.companion.port}`;
    log.info("connecting to meshcore companion", connectionInfo);
    const conn = createConnection();
    await conn.connect();
    log.info("meshcore companion connected", connectionInfo);
    await conn.sendCommandAppStart();
    log.info("meshcore companion app started");
    await conn.getContacts();
    log.info("meshcore companion contacts cached");
    return conn;
  })();
  return connectionPromise;
}

function mapStatusToMetric(
  repeater: Repeater,
  stats: CompanionStats,
  now: Date,
): MetricSample {
  return {
    time: now.toISOString(),
    repeater_id: repeater.repeaterId,
    battery: stats.batt_milli_volts
      ? Math.round(stats.batt_milli_volts / 10) / 100
      : undefined,
    rssi: stats.last_rssi,
    snr: stats.last_snr ? stats.last_snr / 4 : undefined,
    uptime: stats.total_up_time_secs,
    link_quality:
      stats.n_packets_sent && stats.n_packets_sent > 0
        ? stats.n_recv_direct / stats.n_packets_sent
        : undefined,
    neighbors_count: undefined,
    packets_sent: stats.n_packets_sent,
    packets_recv: stats.n_packets_recv,
    queue_len: stats.curr_tx_queue_len,
  };
}

function decodeTelemetry(
  neighborPayload: Uint8Array,
  repeater: Repeater,
  now: Date,
): NeighborSample[] {
  const telemetry = CayenneLpp.parse(neighborPayload);
  const samples: NeighborSample[] = [];
  let currentNeighbor: NeighborSample | null = null;
  for (const record of telemetry) {
    if (record.type === CayenneLpp.LPP_GENERIC_SENSOR && record.channel === 1) {
      if (currentNeighbor) {
        samples.push(currentNeighbor);
      }
      const neighborIdHex = record.value.toString(16).padStart(8, "0");
      currentNeighbor = {
        time: now.toISOString(),
        repeater_id: repeater.repeaterId,
        neighbor_id: neighborIdHex,
      };
    } else if (currentNeighbor && record.type === CayenneLpp.LPP_PERCENTAGE) {
      currentNeighbor.link_quality = record.value / 100;
    } else if (currentNeighbor && record.type === CayenneLpp.LPP_VOLTAGE) {
      currentNeighbor.rssi = record.value;
    }
  }
  if (currentNeighbor) {
    samples.push(currentNeighbor);
  }
  return samples;
}

export async function readRepeaterMetrics(
  repeater: Repeater,
): Promise<{ metrics: MetricSample; neighbors: NeighborSample[] }> {
  const publicKeyPrefix = derivePublicKeyPrefix(repeater.publicKeyHex);
  const now = new Date();

  log.info("reading meshcore status", repeater.repeaterId);
  const [status, telemetry] = await withConnection(async (conn) => {
    const contact = await resolveContact(conn, repeater, publicKeyPrefix);
    log.debug(contact);
    if (contact.advName) {
      log.debug("resolved contact", repeater.repeaterId, contact.advName);
    }
    const password = repeater.password ?? "";
    log.info("sending meshcore login", repeater.repeaterId);
    await conn.login(
      contact.publicKey,
      password,
      config.companion.statusTimeoutMs,
    );
    log.debug("login command sent", repeater.repeaterId);

    const status: CompanionStats = await conn
      .getStatus(contact.publicKey, config.companion.statusTimeoutMs)
      .then((stats: CompanionStats) => {
        log.debug(
          "status received",
          repeater.repeaterId,
          stats.last_rssi,
          stats.curr_tx_queue_len,
        );
        return stats;
      });

    const telemetry:TelemetryResponse | null =  await conn
      .getTelemetry(contact.publicKey, config.companion.telemetryTimeoutMs)
      .then((payload) => {
        if (payload) {
          log.debug(
            "telemetry payload received",
            repeater.repeaterId,
            payload.lppSensorData.length,
          );
        }
        return payload;
      })
      .catch((err: unknown) => {
        if (err === "timeout") {
          log.warn("telemetry timeout", repeater.repeaterId);
          return null;
        }
        log.error("telemetry error", repeater.repeaterId, err);
        throw err;
      });
    return [status, telemetry];
  });

  const metrics = mapStatusToMetric(repeater, status, now);
  const neighbors =
    telemetry?.lppSensorData &&
    Buffer.from(telemetry.pubKeyPrefix).equals(Buffer.from(publicKeyPrefix))
      ? decodeTelemetry(telemetry.lppSensorData, repeater, now)
      : [];
  if (neighbors.length) {
    log.info(
      "decoded neighbor telemetry",
      repeater.repeaterId,
      `${neighbors.length} neighbors`,
    );
  } else {
    log.debug("no neighbor telemetry", repeater.repeaterId);
  }
  return { metrics, neighbors };
}
