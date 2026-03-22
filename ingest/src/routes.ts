import { FastifyInstance } from "fastify";
import { batchSchema, resolveIngestLocationId } from "./types.js";
import { ensureLocationExists, upsertDeviceByPublicKey } from "./device-store.js";
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

function getForeignKeyConflictMessage(error: PostgresErrorLike) {
  switch (getConstraintName(error)) {
    case "metrics_repeater_id_fkey":
    case "neighbors_repeater_id_fkey":
      return "unknown repeater_id; seed the referenced repeaters before ingesting batches";
    case "device_heartbeats_device_id_fkey":
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
  switch (getConstraintName(error)) {
    case "metrics_repeater_id_fkey":
    case "neighbors_repeater_id_fkey":
    case "device_heartbeats_device_id_fkey":
      return true;
    default:
      return false;
  }
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
          for (const metric of batch.metrics) {
            const rssi = metric.rssi ?? null;
            const snr = metric.snr ?? null;
            const battery = metric.battery ?? null;
            const power = metric.power ?? null;
            const uptime = metric.uptime ?? null;
            const linkQuality = metric.link_quality ?? null;
            const neighborsCount = metric.neighbors_count ?? null;
            const packetsSent = metric.packets_sent ?? null;
            const packetsRecv = metric.packets_recv ?? null;
            const queueLen = metric.queue_len ?? null;
            await tx`
              INSERT INTO metrics (time, repeater_id, location_id, rssi, snr, battery, power, uptime, link_quality, neighbors_count, packets_sent, packets_recv, queue_len)
              VALUES (${metric.time}, ${metric.repeater_id}, ${locationId}, ${rssi}, ${snr}, ${battery}, ${power}, ${uptime}, ${linkQuality}, ${neighborsCount}, ${packetsSent}, ${packetsRecv}, ${queueLen})
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
