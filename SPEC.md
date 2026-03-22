# Meshcore Monitoring Spec

This document defines the architecture, data contracts, and operational details for a
meshcore monitoring system with low-bandwidth, unreliable mesh networks.

## Goals
- Monitor repeaters across multiple locations per mesh network.
- Collect core metrics (no logs), retain indefinitely.
- Use payload signing based on meshcore companion crypto.
- Keep edge traffic low and spread reads over time.
- Centralized storage and visualization with a simple Docker Compose stack.

## Non-Goals
- Real-time log streaming.
- Built-in TLS termination (handled upstream).
- Complex alerting in v1 (webhooks later).

## System Overview
Edge agents run at selected locations and talk to the meshcore companion (USB/TCP).
They collect repeater metrics over an 8-hour polling window and send signed batches
to a central ingest service. The ingest service verifies JWT auth tokens and stores metrics
in TimescaleDB for visualization in Grafana.

### Components
- Edge agent (location): pollers, scheduler, local queue, batcher, signer.
- Central ingest (Bun/TS): HTTP API, JWT validation, DB writes.
- TimescaleDB: long-term time-series storage.
- Grafana: dashboards.
- TLS termination: external reverse proxy (not in compose).

## Data Collection Strategy
### Polling Window
- Default window: 8 hours.
- Each repeater is scheduled once per window.

### Jittered Scheduling
- Deterministic jitter based on repeater_id + date to spread reads evenly.
- Current implementation is sequential; `POLL_CONCURRENCY` exists in edge config but is not used yet.

### Offline Behavior
- Disk-backed queue for batches.
- On send failure, the edge writes the batch to `.queue/`.
- Queue drain retries files in sorted order and stops on the first failure.

## Payload Contract
### Envelope
```json
{
  "device_id": "string",
  "location_id": "string",
  "batch_id": "uuid",
  "sent_at": "2026-02-23T12:34:56Z",
  "window": { "from": "...", "to": "..." },
  "metrics": [ ... ],
  "neighbors": [ ... ],
  "heartbeat": { ... }
}
```

### Metrics Item
```json
{
  "time": "...",
  "repeater_id": "string",
  "rssi": -85,
  "snr": 12,
  "snr_raw": 48,
  "battery": 4.05,
  "battery_milli_volts": 4050,
  "power": "mains|battery|solar|unknown",
  "uptime": 123456,
  "air_time": 7890,
  "noise_floor": -106,
  "link_quality": 0.92,
  "neighbors_count": 4,
  "packets_sent": 1200,
  "packets_sent_direct": 900,
  "packets_sent_flood": 300,
  "packets_recv": 1180,
  "packets_recv_direct": 880,
  "packets_recv_flood": 300,
  "queue_len": 2,
  "error_events": 1,
  "direct_duplicates": 6,
  "flood_duplicates": 3
}
```

`battery` is a floating-point voltage in volts, derived from Meshcore `batt_milli_volts`
when available. `snr` is a dB value derived from raw Meshcore `snr_raw` quarter-dB units.

All currently exposed repeater status fields are validated and stored as explicit columns in the
`metrics` hypertable; ingest does not persist repeater status as a JSON blob. The main payload-to-DB
name differences are `air_time` → `total_air_time_secs`, direct/flood packet splits → `n_*`, and
duplicate counters → `n_*_dups`.

`neighbors_count` should come from meshcore `connection.getNeighbours(...).totalNeighboursCount`.
If all neighbor pages are collected for that sample, it should also equal the number of emitted
neighbor rows for the same repeater/time.

### Neighbors Item
```json
{
  "time": "...",
  "repeater_id": "string",
  "neighbor_id": "string",
  "link_quality": 0.71,
  "hops": 2,
  "rssi": -97,
  "snr": 8.5
}
```

When sourced from meshcore `connection.getNeighbours(...)`, `neighbor_id` is the hex-encoded
`publicKeyPrefix` returned by the library (default request prefix length is 8 bytes, so 16 hex
characters). In the installed `@liamcottle/meshcore.js` package, each neighbor currently exposes
`publicKeyPrefix`, `heardSecondsAgo`, and `snr`; `rssi`, `link_quality`, and `hops` are not
returned by that API and therefore remain optional until another source provides them.

### Heartbeat
```json
{
  "time": "...",
  "status": "ok|degraded",
  "version": "edge/1.0.0"
}
```

### Compression
- Gzip payload bodies are part of the intended design, but are not implemented in the current edge
  or ingest code.

## Signing and Authentication
### Source of Truth
- Use meshcore companion crypto primitives and signature format inspired by meshcore-packet-capture `auth_token.py`.
- JWT-style token: header `{alg:"Ed25519", typ:"JWT"}`, payload contains `publicKey`, `iat`, `exp`, optional `aud`, `deviceId`, `locationId`.
- Token signed with Ed25519 over `base64url(header).base64url(payload)` and transmitted via `X-Auth-Token`.

### Replay Protection
- Enforce +/- 5 minute skew on `iat` and a 24h default validity (`exp`).
- Optional nonce store can be added later if required.

## Central API
### Endpoints
- POST /ingest
- GET /health
- Planned, not implemented: POST /devices/register (admin)
- Planned, not implemented: GET /metrics (optional)

### /ingest Behavior
- Validate JWT token (signature, iat skew, exp).
- Auto-register device by public key if not known.
- Validate payload shape.
- Insert to TimescaleDB in a single transaction.

## Database Schema (TimescaleDB)
### Base Tables
- devices(device_id, public_key, signature_algo, location_id, revoked_at)
- locations(location_id, name, network_id, metadata)
- repeaters(repeater_id, location_id, label, identifiers, metadata)

### Hypertables
- metrics(time, repeater_id, location_id, rssi, snr, snr_raw, battery, battery_milli_volts,
  power, uptime, noise_floor, total_air_time_secs, link_quality, neighbors_count,
  packets_sent, packets_recv, queue_len, n_sent_flood, n_sent_direct, n_recv_flood,
  n_recv_direct, err_events, n_direct_dups, n_flood_dups)
- neighbors(time, repeater_id, neighbor_id, link_quality, hops, rssi, snr)
- device_heartbeats(time, device_id, status, version)

### Policies
- Compression after 30 days on all hypertables.
- Indefinite retention (no drop policy).

## Docker Compose (Minimal)
- timescaledb
- ingest (Bun/TS)
- grafana

TLS termination is provided upstream (Caddy/Nginx/Traefik).

## Observability
- Ingest service exposes /health.
- Optional /metrics for Prometheus is not implemented.
- Grafana dashboards for location, repeater, and neighbor graph trends.

## Open Tasks for Implementation
- Extract exact crypto details from meshcore companion documentation.
- Confirm any extra metrics (temperature, voltage, firmware, etc.).
- Define batch size limits (time range only is acceptable).
