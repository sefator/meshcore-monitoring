CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS locations (
  location_id text PRIMARY KEY,
  name text NOT NULL,
  network_id text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS repeaters (
  repeater_id text PRIMARY KEY,
  location_id text REFERENCES locations(location_id),
  label text,
  identifiers jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS devices (
  device_id text PRIMARY KEY,
  public_key text UNIQUE NOT NULL,
  signature_algo text NOT NULL,
  location_id text REFERENCES locations(location_id),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS metrics (
  time timestamptz NOT NULL,
  repeater_id text REFERENCES repeaters(repeater_id),
  location_id text REFERENCES locations(location_id),
  rssi double precision,
  snr double precision,
  battery integer,
  power text,
  uptime bigint,
  link_quality double precision,
  neighbors_count integer,
  packets_sent bigint,
  packets_recv bigint,
  queue_len integer
);
SELECT create_hypertable('metrics', 'time', if_not_exists => true);
SELECT add_compression_policy('metrics', INTERVAL '30 days');

CREATE TABLE IF NOT EXISTS neighbors (
  time timestamptz NOT NULL,
  repeater_id text REFERENCES repeaters(repeater_id),
  neighbor_id text,
  link_quality double precision,
  hops integer
);
SELECT create_hypertable('neighbors', 'time', if_not_exists => true);
SELECT add_compression_policy('neighbors', INTERVAL '30 days');

CREATE TABLE IF NOT EXISTS device_heartbeats (
  time timestamptz NOT NULL,
  device_id text REFERENCES devices(device_id),
  status text,
  version text
);
SELECT create_hypertable('device_heartbeats', 'time', if_not_exists => true);
SELECT add_compression_policy('device_heartbeats', INTERVAL '30 days');
