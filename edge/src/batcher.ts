import { nanoid } from "nanoid";
import type { BatchPayload, MetricSample, NeighborSample } from "./types.js";
import { getDeviceIdentity } from "./companion.js";
import { config } from "./config.js";

export class BatchBuilder {
  private metrics: MetricSample[] = [];
  private neighbors: NeighborSample[] = [];
  private windowStart: Date;
  private windowEnd: Date;

  constructor(windowStart: Date, windowEnd: Date) {
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
  }

  addMetric(sample: MetricSample) {
    this.metrics.push(sample);
  }

  addNeighbors(sample: NeighborSample) {
    this.neighbors.push(sample);
  }

  async build(): Promise<BatchPayload> {
    const { deviceId } = await getDeviceIdentity();
    return {
      device_id: deviceId,
      location_id: config.locationId,
      batch_id: nanoid(),
      sent_at: new Date().toISOString(),
      window: {
        from: this.windowStart.toISOString(),
        to: this.windowEnd.toISOString()
      },
      metrics: this.metrics,
      neighbors: this.neighbors,
      heartbeat: {
        time: new Date().toISOString(),
        status: "ok",
        version: "edge-dev"
      }
    };
  }
}
