import {
  TCPConnection,
  NodeJSSerialConnection,
} from "@liamcottle/meshcore.js";
import type {
  CompanionContact,
  CompanionSelfInfo,
  CompanionStats,
  MeshcoreConnection,
  MeshcoreNeighbour,
} from "@liamcottle/meshcore.js";
import type { MetricSample, NeighborSample, Repeater } from "./types.js";
import { config } from "./config.js";
import { log } from "./log.js";

export type DeviceIdentity = {
  publicKeyHex: string;
  deviceId: string;
};

// @liamcottle/meshcore.js 1.11.0 parses each neighbor from getNeighbours() as:
// - publicKeyPrefix: readBytes(pubKeyPrefixLength)
// - heardSecondsAgo: uint32
// - snr: int8 / 4
// No per-neighbor rssi, link_quality, or hops are exposed by this API.
type NeighborFetchResult = {
  neighbors: NeighborSample[];
  neighborsCount?: number;
};

function derivePublicKeyPrefix(hexKey: string) {
  return hexToBytes(hexKey).subarray(0, 6);
}

let connectionPromise: Promise<CompanionConnection> | null = null;
let deviceIdentityPromise: Promise<DeviceIdentity> | null = null;

type CompanionConnection = MeshcoreConnection;

async function withConnection<T>(
  fn: (conn: CompanionConnection) => Promise<T>,
): Promise<T> {
  const conn = await ensureConnection();
  try {
    return await fn(conn);
  } catch (err) {
    log.error("companion call failed, resetting connection", err);
    connectionPromise = null;
    deviceIdentityPromise = null;
    throw err;
  }
}

function hexToBytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex").toUpperCase();
}

function mapSelfInfoToDeviceIdentity(selfInfo: CompanionSelfInfo): DeviceIdentity {
  const publicKeyHex = bytesToHex(selfInfo.publicKey);
  return {
    publicKeyHex,
    deviceId: publicKeyHex,
  };
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
    return new NodeJSSerialConnection(config.companion.serialPath);
  }
  return new TCPConnection(
    config.companion.host,
    config.companion.port,
  );
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

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  if (deviceIdentityPromise) {
    return deviceIdentityPromise;
  }

  deviceIdentityPromise = withConnection(async (conn) => {
    const selfInfo = await conn.getSelfInfo(config.companion.statusTimeoutMs);
    return mapSelfInfoToDeviceIdentity(selfInfo);
  }).catch((err) => {
    deviceIdentityPromise = null;
    throw err;
  });

  return deviceIdentityPromise;
}

export async function signWithDevice(data: Uint8Array) {
  return withConnection((conn) => conn.sign(data));
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

function mapMeshcoreNeighbourToSample(
  neighbor: MeshcoreNeighbour,
  repeater: Repeater,
  now: Date,
): NeighborSample {
  return {
    time: now.toISOString(),
    repeater_id: repeater.repeaterId,
    neighbor_id: Buffer.from(neighbor.publicKeyPrefix).toString("hex"),
    snr: Number.isFinite(neighbor.snr) ? neighbor.snr : undefined,
  };
}

async function fetchNeighborSamples(
  conn: CompanionConnection,
  contact: CompanionContact,
  repeater: Repeater,
  now: Date,
): Promise<NeighborFetchResult> {
  try {
    const firstPage = await conn.getNeighbours(contact.publicKey);
    const neighbours = [...firstPage.neighbours];
    let offset = neighbours.length;

    while (offset < firstPage.totalNeighboursCount) {
      const page = await conn.getNeighbours(
        contact.publicKey,
        Math.min(255, firstPage.totalNeighboursCount - offset),
        offset,
      );
      if (!page.neighbours.length) {
        log.warn(
          "neighbor paging returned no results",
          repeater.repeaterId,
          `offset=${offset}`,
          `reported_total=${firstPage.totalNeighboursCount}`,
        );
        break;
      }
      neighbours.push(...page.neighbours);
      offset += page.neighbours.length;
    }

    const neighbors = neighbours.map((neighbor) =>
      mapMeshcoreNeighbourToSample(neighbor, repeater, now),
    );
    const neighborsCount =
      neighbors.length === firstPage.totalNeighboursCount
        ? firstPage.totalNeighboursCount
        : neighbors.length;

    if (neighbors.length !== firstPage.totalNeighboursCount) {
      log.warn(
        "neighbor count mismatch",
        repeater.repeaterId,
        `reported=${firstPage.totalNeighboursCount}`,
        `collected=${neighbors.length}`,
      );
    } else if (neighbors.length === 0) {
      log.info("neighbor list empty", repeater.repeaterId);
    } else {
      log.info(
        "neighbor list fetched",
        repeater.repeaterId,
        `${neighbors.length} neighbors`,
      );
    }

    return { neighbors, neighborsCount };
  } catch (err) {
    if (err === "timeout") {
      log.warn("neighbor fetch timeout", repeater.repeaterId);
    } else {
      log.error("neighbor fetch failed", repeater.repeaterId, err);
    }
    return { neighbors: [] };
  }
}

export async function readRepeaterMetrics(
  repeater: Repeater,
): Promise<{ metrics: MetricSample; neighbors: NeighborSample[] }> {
  const publicKeyPrefix = derivePublicKeyPrefix(repeater.publicKeyHex);
  const now = new Date();

  log.info("reading meshcore status", repeater.repeaterId);
  const [status, neighborResult] = await withConnection(async (conn) => {
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

    const neighbors = await fetchNeighborSamples(conn, contact, repeater, now);
    return [status, neighbors];
  });

  const metrics = mapStatusToMetric(repeater, status, now);
  metrics.neighbors_count = neighborResult.neighborsCount;
  const neighbors = neighborResult.neighbors;
  return { metrics, neighbors };
}
