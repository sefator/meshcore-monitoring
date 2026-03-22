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
    log.warn("companion contact missing", repeater.repeaterId);
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

function formatOptionalMetric(value: number | undefined) {
  return value == null ? "n/a" : String(value);
}

function summarizeStatus(stats: CompanionStats) {
  const battery =
    stats.batt_milli_volts == null
      ? "n/a"
      : `${Math.round(stats.batt_milli_volts / 10) / 100}V`;
  const snr = stats.last_snr == null ? "n/a" : `${stats.last_snr / 4}`;
  return [
    `battery=${battery}`,
    `rssi=${formatOptionalMetric(stats.last_rssi)}`,
    `snr=${snr}`,
    `queue_len=${formatOptionalMetric(stats.curr_tx_queue_len)}`,
    `uptime=${formatOptionalMetric(stats.total_up_time_secs)}`,
    `packets_sent=${formatOptionalMetric(stats.n_packets_sent)}`,
    `packets_recv=${formatOptionalMetric(stats.n_packets_recv)}`,
  ].join(" ");
}

async function fetchNeighborSamples(
  conn: CompanionConnection,
  contact: CompanionContact,
  repeater: Repeater,
  now: Date,
): Promise<NeighborFetchResult> {
  let currentOffset = 0;
  let currentPageSize: number | "default" = "default";
  try {
    log.info(
      "requesting repeater neighbors page",
      repeater.repeaterId,
      `offset=${currentOffset}`,
      `page_size=${currentPageSize}`,
    );
    const firstPage = await conn.getNeighbours(contact.publicKey);
    log.info(
      "repeater neighbors page received",
      repeater.repeaterId,
      `offset=${currentOffset}`,
      `page_size=${currentPageSize}`,
      `received=${firstPage.neighbours.length}`,
      `reported_total=${firstPage.totalNeighboursCount}`,
    );
    const neighbours = [...firstPage.neighbours];
    let offset = neighbours.length;

    while (offset < firstPage.totalNeighboursCount) {
      currentOffset = offset;
      currentPageSize = Math.min(255, firstPage.totalNeighboursCount - offset);
      log.info(
        "requesting repeater neighbors page",
        repeater.repeaterId,
        `offset=${currentOffset}`,
        `page_size=${currentPageSize}`,
      );
      const page = await conn.getNeighbours(
        contact.publicKey,
        currentPageSize,
        offset,
      );
      log.info(
        "repeater neighbors page received",
        repeater.repeaterId,
        `offset=${currentOffset}`,
        `page_size=${currentPageSize}`,
        `received=${page.neighbours.length}`,
      );
      if (!page.neighbours.length) {
        log.warn(
          "neighbor paging returned no results",
          repeater.repeaterId,
          `offset=${currentOffset}`,
          `page_size=${currentPageSize}`,
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
      log.warn(
        "neighbor fetch timeout",
        repeater.repeaterId,
        `offset=${currentOffset}`,
        `page_size=${currentPageSize}`,
      );
    } else {
      log.warn(
        "neighbor fetch failed",
        repeater.repeaterId,
        `offset=${currentOffset}`,
        `page_size=${currentPageSize}`,
        err,
      );
    }
    return { neighbors: [] };
  }
}

export async function readRepeaterMetrics(
  repeater: Repeater,
): Promise<{ metrics: MetricSample; neighbors: NeighborSample[] }> {
  const publicKeyPrefix = derivePublicKeyPrefix(repeater.publicKeyHex);
  const now = new Date();

  log.info("starting repeater radio read", repeater.repeaterId);
  try {
    const [status, neighborResult] = await withConnection(async (conn) => {
      log.info("resolving repeater contact", repeater.repeaterId);
      const contact = await resolveContact(conn, repeater, publicKeyPrefix);
      log.info(
        "repeater contact resolved",
        repeater.repeaterId,
        contact.advName ? `adv_name=${contact.advName}` : "adv_name=unknown",
      );
      log.debug(contact);

      const password = repeater.password ?? "";
      log.info("sending meshcore login", repeater.repeaterId);
      try {
        await conn.login(
          contact.publicKey,
          password,
          config.companion.statusTimeoutMs,
        );
      } catch (err) {
        log.warn("meshcore login failed", repeater.repeaterId, err);
        throw err;
      }
      log.info("meshcore login succeeded", repeater.repeaterId);

      log.info("requesting repeater status", repeater.repeaterId);
      const status: CompanionStats = await conn
        .getStatus(contact.publicKey, config.companion.statusTimeoutMs)
        .then((stats: CompanionStats) => {
          log.info(
            "repeater status received",
            repeater.repeaterId,
            summarizeStatus(stats),
          );
          log.debug("status received", repeater.repeaterId, stats);
          return stats;
        })
        .catch((err) => {
          log.warn("repeater status request failed", repeater.repeaterId, err);
          throw err;
        });

      const neighbors = await fetchNeighborSamples(conn, contact, repeater, now);
      return [status, neighbors];
    });

    const metrics = mapStatusToMetric(repeater, status, now);
    metrics.neighbors_count = neighborResult.neighborsCount;
    const neighbors = neighborResult.neighbors;
    log.info(
      "repeater radio read complete",
      repeater.repeaterId,
      summarizeStatus(status),
      `neighbors=${neighbors.length}`,
      `reported_neighbors=${neighborResult.neighborsCount ?? "n/a"}`,
    );
    return { metrics, neighbors };
  } catch (err) {
    log.warn("repeater radio read failed", repeater.repeaterId, err);
    throw err;
  }
}
