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
  // Raw Meshcore last_snr value in quarter-dB units.
  snr_raw?: number;
  // Battery voltage in volts, derived from batt_milli_volts when available.
  battery?: number;
  battery_milli_volts?: number;
  power?: "mains" | "battery" | "solar" | "unknown";
  uptime?: number;
  air_time?: number;
  link_quality?: number;
  // From meshcore getNeighbours(). Should match neighbors.length when all pages are collected.
  neighbors_count?: number;
  noise_floor?: number;
  packets_sent?: number;
  packets_sent_direct?: number;
  packets_sent_flood?: number;
  packets_recv?: number;
  packets_recv_direct?: number;
  packets_recv_flood?: number;
  queue_len?: number;
  error_events?: number;
  direct_duplicates?: number;
  flood_duplicates?: number;
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
