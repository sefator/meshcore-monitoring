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
  snr_raw integer,
  battery double precision,
  battery_milli_volts integer,
  power text,
  uptime bigint,
  noise_floor double precision,
  total_air_time_secs bigint,
  link_quality double precision,
  neighbors_count integer,
  packets_sent bigint,
  packets_recv bigint,
  queue_len integer,
  n_sent_flood bigint,
  n_sent_direct bigint,
  n_recv_flood bigint,
  n_recv_direct bigint,
  err_events bigint,
  n_direct_dups bigint,
  n_flood_dups bigint
);
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS snr_raw integer;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS battery_milli_volts integer;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS noise_floor double precision;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS total_air_time_secs bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_sent_flood bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_sent_direct bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_recv_flood bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_recv_direct bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS err_events bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_direct_dups bigint;
ALTER TABLE IF EXISTS metrics
  ADD COLUMN IF NOT EXISTS n_flood_dups bigint;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'metrics'
      AND column_name = 'battery'
      AND data_type <> 'double precision'
  ) THEN
    ALTER TABLE metrics
      ALTER COLUMN battery TYPE double precision
      USING battery::double precision;
  END IF;
END $$;
SELECT create_hypertable('metrics', 'time', if_not_exists => true);
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'location_id,repeater_id'
);
SELECT add_compression_policy('metrics', INTERVAL '30 days', if_not_exists => true);

CREATE TABLE IF NOT EXISTS neighbors (
  time timestamptz NOT NULL,
  repeater_id text REFERENCES repeaters(repeater_id),
  neighbor_id text,
  link_quality double precision,
  hops integer,
  rssi double precision,
  snr double precision
);
ALTER TABLE IF EXISTS neighbors
  ADD COLUMN IF NOT EXISTS rssi double precision;
ALTER TABLE IF EXISTS neighbors
  ADD COLUMN IF NOT EXISTS snr double precision;
SELECT create_hypertable('neighbors', 'time', if_not_exists => true);
ALTER TABLE neighbors SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'repeater_id'
);
SELECT add_compression_policy('neighbors', INTERVAL '30 days', if_not_exists => true);

CREATE TABLE IF NOT EXISTS device_heartbeats (
  time timestamptz NOT NULL,
  device_id text REFERENCES devices(device_id),
  status text,
  version text
);
SELECT create_hypertable('device_heartbeats', 'time', if_not_exists => true);
ALTER TABLE device_heartbeats SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id'
);
SELECT add_compression_policy('device_heartbeats', INTERVAL '30 days', if_not_exists => true);
