import { FastifyInstance } from "fastify";
import { batchSchema, resolveIngestLocationId } from "./types.js";
import type { BatchPayload } from "./types.js";
import {
  ensureLocationExists,
  ensureRepeatersExist,
  upsertDeviceByPublicKey
} from "./device-store.js";
import { verifyJwtToken } from "./tokens.js";
import { sql } from "./database.js";
import { log } from "./log.js";

type IngestHeaders = {
  "x-device-id"?: string;
  "x-auth-token"?: string;
};

type PostgresErrorLike = {
  code?: string;
  constraint_name?: string;
  constraint?: string;
  message?: string;
};

function getConstraintName(error: PostgresErrorLike) {
  return error.constraint_name ?? error.constraint;
}

function matchesConstraintName(error: PostgresErrorLike, constraintName: string) {
  const actualConstraintName = getConstraintName(error);
  return actualConstraintName?.endsWith(constraintName) ?? false;
}

function getForeignKeyViolationKind(error: PostgresErrorLike) {
  if (
    matchesConstraintName(error, "metrics_repeater_id_fkey") ||
    matchesConstraintName(error, "neighbors_repeater_id_fkey")
  ) {
    return "repeater";
  }
  if (matchesConstraintName(error, "device_heartbeats_device_id_fkey")) {
    return "device";
  }
  return null;
}

function getForeignKeyConflictMessage(error: PostgresErrorLike) {
  switch (getForeignKeyViolationKind(error)) {
    case "repeater":
      return "repeater reference could not be prepared before ingest; retry or inspect repeater data";
    case "device":
      return "device registration did not complete before heartbeat insert";
    default:
      return "missing referenced location or repeater data; seed reference rows before ingesting batches";
  }
}

function isForeignKeyViolation(error: unknown): error is PostgresErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23503"
  );
}

function isHandledForeignKeyViolation(error: PostgresErrorLike) {
  return getForeignKeyViolationKind(error) !== null;
}

function getBatchRepeaterIds(batch: BatchPayload) {
  const repeaterIds = new Set<string>();
  for (const metric of batch.metrics) {
    repeaterIds.add(metric.repeater_id);
  }
  for (const neighbor of batch.neighbors) {
    repeaterIds.add(neighbor.repeater_id);
  }
  return repeaterIds;
}

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));

  app.post(
    "/ingest",
    {
      config: {
        rawBody: true
      }
    },
    async (request, reply) => {
      const headers = request.headers as IngestHeaders;
      const rawBody = request.rawBody as Buffer | undefined;
      if (!rawBody) {
        return reply.status(400).send({ error: "missing body" });
      }

      const authToken = headers["x-auth-token"];
      if (!authToken) {
        return reply.status(401).send({ error: "missing auth token" });
      }

      const tokenInfo = verifyJwtToken(authToken);

      if (!tokenInfo.valid) {
        return reply.status(401).send({ error: tokenInfo.error ?? "invalid token" });
      }

      const publicKey = tokenInfo.payload.publicKey;
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch (error) {
        log.warn("invalid json payload", error);
        return reply.status(400).send({ error: "invalid json" });
      }

      const parsed = batchSchema.safeParse(payload);
      if (!parsed.success) {
        log.warn("invalid payload", parsed.error.flatten());
        const locationIssue = parsed.error.issues.find((issue) => issue.path[0] === "location_id");
        if (locationIssue) {
          return reply
            .status(400)
            .send({ error: `invalid location_id: ${locationIssue.message}` });
        }
        return reply.status(400).send({ error: "invalid payload" });
      }
      const batch = parsed.data;
      const locationResolution = resolveIngestLocationId({
        batchLocationId: batch.location_id,
        tokenLocationId: tokenInfo.payload.locationId
      });
      if (!locationResolution.ok) {
        return reply.status(400).send({ error: locationResolution.error });
      }
      const locationId = locationResolution.locationId;

      try {
        await ensureLocationExists(locationId);
        await upsertDeviceByPublicKey({
          publicKey,
          deviceId: tokenInfo.payload.deviceId ?? headers["x-device-id"] ?? batch.device_id,
          locationId
        });

        const tx = await sql.reserve();
        try {
          await tx`BEGIN`;
          await ensureRepeatersExist(getBatchRepeaterIds(batch), locationId, tx);
          for (const metric of batch.metrics) {
            const rssi = metric.rssi ?? null;
            const snr = metric.snr ?? null;
            const snrRaw = metric.snr_raw ?? null;
            const battery = metric.battery ?? null;
            const batteryMilliVolts = metric.battery_milli_volts ?? null;
            const power = metric.power ?? null;
            const uptime = metric.uptime ?? null;
            const noiseFloor = metric.noise_floor ?? null;
            const totalAirTimeSecs = metric.air_time ?? null;
            const linkQuality = metric.link_quality ?? null;
            const neighborsCount = metric.neighbors_count ?? null;
            const packetsSent = metric.packets_sent ?? null;
            const packetsSentFlood = metric.packets_sent_flood ?? null;
            const packetsSentDirect = metric.packets_sent_direct ?? null;
            const packetsRecv = metric.packets_recv ?? null;
            const packetsRecvFlood = metric.packets_recv_flood ?? null;
            const packetsRecvDirect = metric.packets_recv_direct ?? null;
            const queueLen = metric.queue_len ?? null;
            const errEvents = metric.error_events ?? null;
            const directDuplicates = metric.direct_duplicates ?? null;
            const floodDuplicates = metric.flood_duplicates ?? null;
            await tx`
              INSERT INTO metrics (
                time,
                repeater_id,
                location_id,
                rssi,
                snr,
                snr_raw,
                battery,
                battery_milli_volts,
                power,
                uptime,
                noise_floor,
                total_air_time_secs,
                link_quality,
                neighbors_count,
                packets_sent,
                packets_recv,
                queue_len,
                n_sent_flood,
                n_sent_direct,
                n_recv_flood,
                n_recv_direct,
                err_events,
                n_direct_dups,
                n_flood_dups
              )
              VALUES (
                ${metric.time},
                ${metric.repeater_id},
                ${locationId},
                ${rssi},
                ${snr},
                ${snrRaw},
                ${battery},
                ${batteryMilliVolts},
                ${power},
                ${uptime},
                ${noiseFloor},
                ${totalAirTimeSecs},
                ${linkQuality},
                ${neighborsCount},
                ${packetsSent},
                ${packetsRecv},
                ${queueLen},
                ${packetsSentFlood},
                ${packetsSentDirect},
                ${packetsRecvFlood},
                ${packetsRecvDirect},
                ${errEvents},
                ${directDuplicates},
                ${floodDuplicates}
              )
            `;
          }
          for (const neighbor of batch.neighbors) {
            const linkQuality = neighbor.link_quality ?? null;
            const hops = neighbor.hops ?? null;
            const rssi = neighbor.rssi ?? null;
            const snr = neighbor.snr ?? null;
            await tx`
              INSERT INTO neighbors (time, repeater_id, neighbor_id, link_quality, hops, rssi, snr)
              VALUES (${neighbor.time}, ${neighbor.repeater_id}, ${neighbor.neighbor_id}, ${linkQuality}, ${hops}, ${rssi}, ${snr})
            `;
          }
          if (batch.heartbeat) {
            await tx`
              INSERT INTO device_heartbeats (time, device_id, status, version)
              VALUES (${batch.heartbeat.time}, ${batch.device_id}, ${batch.heartbeat.status}, ${batch.heartbeat.version})
            `;
          }
          await tx`COMMIT`;
        } catch (error) {
          await tx`ROLLBACK`;
          throw error;
        } finally {
          tx.release();
        }
      } catch (error) {
        if (isForeignKeyViolation(error) && isHandledForeignKeyViolation(error)) {
          const message = getForeignKeyConflictMessage(error);
          log.warn(
            "ingest rejected due to missing reference data",
            `batch_id=${batch.batch_id}`,
            `location_id=${locationId}`,
            `constraint=${getConstraintName(error) ?? "unknown"}`,
          );
          return reply.status(409).send({ error: message });
        }
        throw error;
      }

      return reply.status(202).send({ accepted: true });
    }
  );
}
