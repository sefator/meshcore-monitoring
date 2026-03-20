import { FastifyInstance } from "fastify";
import { batchSchema } from "./types.js";
import { upsertDeviceByPublicKey } from "./device-store.js";
import { verifyJwtToken } from "./tokens.js";
import { sql } from "./database.js";
import { log } from "./log.js";

type IngestHeaders = {
  "x-device-id"?: string;
  "x-auth-token"?: string;
};

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));

  app.post("/ingest", async (request, reply) => {
    const headers = request.headers as IngestHeaders;
    const rawBody = request.rawBody as Buffer;
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

    await upsertDeviceByPublicKey({
      publicKey,
      deviceId: tokenInfo.payload.deviceId ?? headers["x-device-id"],
      locationId: tokenInfo.payload.locationId ?? undefined
    });

    const parsed = batchSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
    if (!parsed.success) {
      log.warn("invalid payload", parsed.error.flatten());
      return reply.status(400).send({ error: "invalid payload" });
    }
    const batch = parsed.data;

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
          VALUES (${metric.time}, ${metric.repeater_id}, ${batch.location_id}, ${rssi}, ${snr}, ${battery}, ${power}, ${uptime}, ${linkQuality}, ${neighborsCount}, ${packetsSent}, ${packetsRecv}, ${queueLen})
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

    return reply.status(202).send({ accepted: true });
  });
}
