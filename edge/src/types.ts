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
  // Battery voltage in volts, derived from batt_milli_volts when available.
  battery?: number;
  power?: "mains" | "battery" | "solar" | "unknown";
  uptime?: number;
  link_quality?: number;
  // From meshcore getNeighbours(). Should match neighbors.length when all pages are collected.
  neighbors_count?: number;
  packets_sent?: number;
  packets_recv?: number;
  queue_len?: number;
};

export type NeighborSample = {
  time: string;
  repeater_id: string;
  // Hex-encoded neighbor identifier; getNeighbours() returns a publicKeyPrefix, not a full public key.
  neighbor_id: string;
  // @liamcottle/meshcore.js getNeighbours() currently exposes only publicKeyPrefix, heardSecondsAgo, and snr.
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
