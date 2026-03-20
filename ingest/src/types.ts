import { z } from "zod";

export const metricsItemSchema = z.object({
  time: z.string(),
  repeater_id: z.string(),
  rssi: z.number().optional(),
  snr: z.number().optional(),
  battery: z.number().int().min(0).max(100).optional(),
  power: z.enum(["mains", "battery", "solar", "unknown"]).optional(),
  uptime: z.number().int().nonnegative().optional(),
  link_quality: z.number().min(0).max(1).optional(),
  neighbors_count: z.number().int().nonnegative().optional(),
  packets_sent: z.number().int().nonnegative().optional(),
  packets_recv: z.number().int().nonnegative().optional(),
  queue_len: z.number().int().nonnegative().optional()
});

export const neighborsItemSchema = z.object({
  time: z.string(),
  repeater_id: z.string(),
  neighbor_id: z.string(),
  link_quality: z.number().min(0).max(1).optional(),
  hops: z.number().int().nonnegative().optional(),
  rssi: z.number().optional(),
  snr: z.number().optional()
});

export const heartbeatSchema = z.object({
  time: z.string(),
  status: z.enum(["ok", "degraded"]),
  version: z.string()
});

export const batchSchema = z.object({
  device_id: z.string(),
  location_id: z.string(),
  batch_id: z.string(),
  sent_at: z.string(),
  window: z.object({
    from: z.string(),
    to: z.string()
  }),
  metrics: z.array(metricsItemSchema),
  neighbors: z.array(neighborsItemSchema),
  heartbeat: heartbeatSchema.optional()
});

export type MetricsItem = z.infer<typeof metricsItemSchema>;
export type NeighborsItem = z.infer<typeof neighborsItemSchema>;
export type HeartbeatItem = z.infer<typeof heartbeatSchema>;
export type BatchPayload = z.infer<typeof batchSchema>;
