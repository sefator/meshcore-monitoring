export type Repeater = {
  repeaterId: string;
  publicKeyHex: string;
  password?: string;
  label?: string;
  tags?: string[];
};

export type MetricSample = {
  time: string;
  repeater_id: string;
  rssi?: number;
  snr?: number;
  battery?: number;
  power?: "mains" | "battery" | "solar" | "unknown";
  uptime?: number;
  link_quality?: number;
  neighbors_count?: number;
  packets_sent?: number;
  packets_recv?: number;
  queue_len?: number;
};

export type NeighborSample = {
  time: string;
  repeater_id: string;
  neighbor_id: string;
  link_quality?: number;
  hops?: number;
  rssi?: number;
  snr?: number;
};

export type BatchPayload = {
  device_id: string;
  location_id: string;
  batch_id: string;
  sent_at: string;
  window: { from: string; to: string };
  metrics: MetricSample[];
  neighbors: NeighborSample[];
  heartbeat?: {
    time: string;
    status: "ok" | "degraded";
    version: string;
  };
};
