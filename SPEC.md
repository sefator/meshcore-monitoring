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
- Low concurrency (1-2 active polls) to protect mesh bandwidth.

### Offline Behavior
- Disk-backed queue for batches.
- Exponential backoff on send failures.
- On recovery, drain queue in order with rate limiting.

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
  "battery": 78,
  "power": "mains|battery|solar|unknown",
  "uptime": 123456,
  "link_quality": 0.92,
  "neighbors_count": 4
}
```

### Neighbors Item
```json
{
  "time": "...",
  "repeater_id": "string",
  "neighbor_id": "string",
  "link_quality": 0.71,
  "hops": 2
}
```

### Heartbeat
```json
{
  "time": "...",
  "status": "ok|degraded",
  "version": "edge/1.0.0"
}
```

### Compression
- Gzip for payload bodies is supported and recommended.

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
- POST /devices/register (admin)
- GET /health
- GET /metrics (optional)

### /ingest Behavior
- Validate JWT token (signature, iat skew, exp).
- Auto-register device by public key if not known.
- Validate payload shape.
- Insert to TimescaleDB in a single transaction.

## Database Schema (TimescaleDB)
### Base Tables
- devices(device_id, public_key_fingerprint, location_id, created_at, revoked_at)
- locations(location_id, name, network_id, metadata)
- repeaters(repeater_id, location_id, label, identifiers, metadata)

### Hypertables
- metrics(time, repeater_id, location_id, rssi, snr, battery, power, uptime,
  link_quality, neighbors_count)
- neighbors(time, repeater_id, neighbor_id, link_quality, hops)
- device_heartbeats(time, device_id, status, version)

### Policies
- Compression after 7-30 days.
- Indefinite retention (no drop policy).

## Docker Compose (Minimal)
- timescaledb
- ingest (Bun/TS)
- grafana

TLS termination is provided upstream (Caddy/Nginx/Traefik).

## Observability
- Ingest service exposes /health.
- Optional /metrics for Prometheus.
- Grafana dashboards for location, repeater, and neighbor graph trends.

## Open Tasks for Implementation
- Extract exact crypto details from meshcore companion documentation.
- Confirm any extra metrics (temperature, voltage, firmware, etc.).
- Define batch size limits (time range only is acceptable).
