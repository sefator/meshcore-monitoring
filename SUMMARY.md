# Meshcore Monitoring: repo orientation

## What this repo is today

This is a Bun/TypeScript monorepo with two working services:

- `edge/`: polls Meshcore repeaters through the companion app, builds a batch, gets device identity/signatures from the companion at runtime, and POSTs it to ingest.
- `ingest/`: accepts signed batches, validates them, auto-registers devices by public key, and writes data into TimescaleDB hypertables.

Supporting pieces already exist:

- `scripts/schema.sql`: database schema for locations, repeaters, devices, metrics, neighbors, and heartbeats.
- `docker-compose.yml`: local central stack for TimescaleDB + ingest + Grafana, with Grafana provisioning wired to checked-in datasources and dashboards under `grafana/`.
- `edge/docker-compose.yml`: local edge-only compose entry point.
- `scripts/mock-ingest.ts`: synthetic ingest generator that can also print matching SQL for the required mock location/repeater rows.
- Root `package.json`: workspace wiring plus `lint` and `format`.

This is an MVP with the main flow implemented. It is more complete than the old summary suggested, but there are still real contract and resilience gaps.

## Current implemented flow

### 1. Edge polling and batching

Primary path:

`edge/src/main.ts`
→ `edge/src/repeaters-config.ts`
→ `edge/src/scheduler.ts`
→ `edge/src/companion.ts`
→ `edge/src/batcher.ts`
→ `edge/src/sender.ts`
→ `edge/src/queue.ts`

What happens:

- `main.ts` runs forever in 8-hour windows by default.
- Repeaters are loaded from `edge/config/repeaters.json`.
- `scheduler.ts` spreads repeater reads across the window using deterministic jitter from `repeater_id + day`.
- `companion.ts` opens a TCP or serial Meshcore companion connection, logs in to each repeater, reads status, and paginates neighbors.
- `batcher.ts` builds one batch per window with `metrics`, `neighbors`, and a heartbeat.
- `sender.ts` fetches device identity, signs via the companion/device, sends the batch to ingest, and falls back to a disk queue (`.queue/`) when send fails.
- `flushQueue()` retries queued batches in filename order and stops on the first failure.

### 2. Authentication and ingest

Primary path:

`ingest/src/server.ts`
→ `ingest/src/routes.ts`
→ `ingest/src/tokens.ts`
→ `ingest/src/device-store.ts`
→ `ingest/src/database.ts`

What happens:

- Fastify serves `GET /health` and `POST /ingest`.
- `routes.ts` requires `X-Auth-Token`, reads the raw body, verifies the token, validates the payload with Zod, and writes everything in one SQL transaction.
- `tokens.ts` verifies an Ed25519 signature plus `iat` skew / `exp`.
- `device-store.ts` auto-upserts devices by public key before data insert.
- Metrics, neighbors, and optional heartbeat rows are inserted into TimescaleDB.

### 3. Storage model

`scripts/schema.sql` creates:

- Reference tables: `locations`, `repeaters`, `devices`
- Hypertables: `metrics`, `neighbors`, `device_heartbeats`
- Compression policies after 30 days

The `metrics` hypertable stores the current repeater status surface as explicit columns; ingest
does not keep a JSON status blob for repeater telemetry.

There is no migration system in the repo; schema application is still manual.
Mock ingest on a fresh DB also needs reference rows in `locations` and `repeaters`; `scripts/mock-ingest.ts --print-reference-sql` prints matching seed SQL.

## What is actually being collected

### Metrics from `edge/src/companion.ts`

Implemented today and persisted as explicit `metrics` columns:

- `rssi`
- `snr` plus raw `snr_raw`
- `battery` in volts plus raw `battery_milli_volts`
- `uptime`
- `air_time`
- `noise_floor`
- `link_quality` (derived from packet counters)
- `neighbors_count`
- `packets_sent`, `packets_recv`
- `packets_sent_direct`, `packets_sent_flood`
- `packets_recv_direct`, `packets_recv_flood`
- `queue_len`
- `error_events`
- `direct_duplicates`, `flood_duplicates`

### Neighbor data

Implemented today:

- `neighbor_id` as hex-encoded public key prefix
- `snr`

Not currently available from the installed Meshcore client API:

- per-neighbor `rssi`
- `link_quality`
- `hops`

That limitation is reflected in both `SPEC.md` and the comments/types in `edge/src/companion.ts` and `edge/src/types.ts`.

## Files to inspect first before changing behavior

### Edge

- `edge/src/main.ts`: top-level control flow; start here for polling cadence or failure behavior.
- `edge/src/companion.ts`: most important edge module; contains Meshcore integration, status mapping, neighbor paging, and several current limitations.
- `edge/src/scheduler.ts`: deterministic spread of reads across a window.
- `edge/src/batcher.ts`: payload shape emitted by the edge agent.
- `edge/src/sender.ts`: HTTP send path, auth header creation, queue fallback.
- `edge/src/queue.ts`: disk queue behavior and retry ordering.
- `edge/src/signing.ts`: token construction on the edge side.
- `edge/src/config.ts`: all runtime env knobs.
- `edge/src/repeaters-config.ts`: shape and loading of repeater inventory.

### Ingest

- `ingest/src/routes.ts`: central ingest behavior; auth, validation, and DB writes all meet here.
- `ingest/src/types.ts`: Zod contract for batches; payload changes should usually start here.
- `ingest/src/tokens.ts`: signature verification and token time checks.
- `ingest/src/device-store.ts`: device auto-registration behavior and caching.
- `ingest/src/database.ts`: DB connection setup.
- `ingest/src/config.ts`: ingest runtime env knobs.

### Infra / schema

- `scripts/schema.sql`: DB truth for columns and hypertables.
- `docker-compose.yml`: local central stack shape.
- `edge/docker-compose.yml`: local edge-only compose entry point.
- `package.json`, `edge/package.json`, `ingest/package.json`: available scripts and package-level expectations.

## Known limitations and rough edges

### Spec vs current implementation

From `SPEC.md`, these are still missing or only partial:

- `POST /devices/register` is listed in the spec but not implemented.
- `GET /metrics` is listed as optional but not implemented.
- Gzip payload support is mentioned in the spec but not implemented in edge or ingest.
- TLS termination is explicitly expected upstream, not handled here.

### Edge limitations

- `edge/src/main.ts` is fully sequential even though `config.pollConcurrency` exists; that setting is currently unused.
- A failure while reading one repeater can fail the current window rather than isolating that repeater and continuing.
- Queue retry is simple: retry everything in order, stop on first failure, no richer backoff/state tracking.
- Heartbeat status is hardcoded to `"ok"` and version is hardcoded to `"edge-dev"` in `edge/src/batcher.ts`.
- Battery and link quality are inferred/derived, not guaranteed to match a device-native interpretation; battery is emitted as volts derived from `batt_milli_volts`.
- Neighbor paging in `edge/src/companion.ts` can detect count mismatches, but the response is mostly logging plus partial data.

### Ingest limitations

- Device registration is automatic on first valid signed request; there is no explicit approval or admin workflow yet.
- Token verification checks signature, `iat`, and `exp`, but there is no nonce store and no revocation enforcement despite `devices.revoked_at` existing in schema.
- `routes.ts` inserts rows directly and simply; there is no deduplication, no batch size guard, and no richer ingest observability beyond `/health`.

### Repo / workflow limitations

- There are no automated tests in the repo today.
- Root scripts provide `lint` and `format`; ingest also has `typecheck`; edge does not expose a dedicated typecheck script.
- Practical validation hooks today are `bun run lint` and `bun run --cwd ingest typecheck`.
- Schema setup is manual; there is no migration runner.
- Local stack smoke tests should seed the mock location/repeaters before POSTing batches.

## Good starting points for future work

If you are changing...

- **payload shape or DB columns**: start with `ingest/src/types.ts`, `scripts/schema.sql`, then `edge/src/types.ts` / `edge/src/batcher.ts`.
- **how metrics are read from Meshcore**: start with `edge/src/companion.ts`.
- **poll timing / concurrency / failure isolation**: start with `edge/src/main.ts` and `edge/src/scheduler.ts`.
- **auth token format or verification**: start with `edge/src/signing.ts` and `ingest/src/tokens.ts`.
- **offline delivery / retry behavior**: start with `edge/src/sender.ts` and `edge/src/queue.ts`.
- **device registration policy**: start with `ingest/src/device-store.ts` and `ingest/src/routes.ts`.
- **local deployment**: start with `docker-compose.yml` and `scripts/schema.sql` for central services, and use `edge/docker-compose.yml` when you want the compose-managed edge client too.

High-value near-term work, based on current code:

1. Implement the missing admin/device registration path from the spec.
2. Make edge polling resilient per repeater instead of failing the whole window.
3. Either honor `pollConcurrency` or remove it to avoid misleading config.
4. Replace the hardcoded heartbeat fields with real health/version data.
5. Add gzip support for low-bandwidth links.
6. Add revocation checks / stronger replay protection on ingest.

## Practical status

- The core edge → ingest → TimescaleDB path exists and persists the current repeater status surface in explicit `metrics` columns, including raw `battery_milli_volts` / `snr_raw`, air-time/noise data, queue length, packet splits, error events, and duplicate counts.
- The repo is suitable for targeted engineering work, especially around edge polling, ingest validation, and schema evolution.
- Treat `SPEC.md` as design intent, but use the code paths above as the source of truth for current behavior.
