# Meshcore Monitoring

Bun/TypeScript monorepo for collecting Meshcore repeater metrics at edge locations and shipping signed batches to a central ingest service for storage in TimescaleDB and visualization in Grafana.

The project is aimed at low-bandwidth, unreliable mesh networks: the edge side polls slowly, spreads work over a long window, and queues failed uploads on disk instead of assuming a stable connection.

## What this repo contains

### High-level architecture

1. **Edge (`edge/`)**
   - Connects to the Meshcore companion over TCP or serial.
   - Loads repeaters from JSON config.
   - Spreads repeater polls across an 8-hour window with deterministic jitter.
   - Builds signed batches and sends them to central ingest.
   - Stores failed uploads in a local disk queue.

2. **Ingest (`ingest/`)**
   - Exposes `/health` and `/ingest`.
   - Verifies Ed25519 JWT-like auth tokens from `X-Auth-Token`.
   - Validates request payloads with Zod.
   - Auto-registers devices by public key.
   - Inserts metrics, neighbors, and heartbeats into PostgreSQL/TimescaleDB.

3. **Database**
   - Schema lives in `scripts/schema.sql`.
   - Uses Timescale hypertables for `metrics`, `neighbors`, and `device_heartbeats`.

4. **Grafana**
   - Started by `docker-compose.yml`.
   - Reads from TimescaleDB for dashboards.

`docker-compose.yml` starts the **central stack only** (`timescaledb`, `ingest`, `grafana`). The edge agent is not part of compose and is expected to run near the mesh hardware.

## Repo layout

- `SPEC.md` - intended architecture, payload contract, and open implementation tasks.
- `SUMMARY.md` - short implementation snapshot.
- `docker-compose.yml` - local central stack.
- `scripts/schema.sql` - current database schema and Timescale policies.
- `index.ts` - placeholder root file; not part of the runtime architecture.

### Edge package

- `edge/src/main.ts` - main loop; builds one polling window, sends one batch, then repeats forever.
- `edge/src/companion.ts` - Meshcore companion connection and repeater polling logic.
- `edge/src/scheduler.ts` - deterministic jittered scheduling across the window.
- `edge/src/batcher.ts` - batch envelope and heartbeat creation.
- `edge/src/sender.ts` - HTTP send path and queue flush.
- `edge/src/queue.ts` - disk-backed retry queue (`.queue/` under the edge working directory).
- `edge/src/repeaters-config.ts` - loads and validates repeater config.
- `edge/config/repeaters.json` - current repeater source of truth for the edge agent.
- `edge/.env.example` - expected edge environment variables.

### Ingest package

- `ingest/src/server.ts` - Fastify entry point.
- `ingest/src/routes.ts` - request handling for `/health` and `/ingest`, including DB inserts.
- `ingest/src/types.ts` - Zod schemas for ingest payload validation.
- `ingest/src/tokens.ts` - auth token parsing, signature verification, and skew checks.
- `ingest/src/device-store.ts` - device lookup and auto-registration by public key.
- `ingest/src/database.ts` - PostgreSQL connection setup.
- `ingest/.env.example` - expected ingest environment variables.

## Common commands

### Safe inspection / validation commands

- `bun install`
- `bun run lint`
- `bun run --cwd ingest typecheck`
- `docker compose up --build timescaledb ingest grafana`
- `curl http://localhost:8080/health`

### Service commands

- `bun run --cwd ingest dev`
- `bun run --cwd ingest start`
- `bun run --cwd edge dev`

### Schema setup

Compose does **not** apply `scripts/schema.sql` automatically. After TimescaleDB is up, apply it yourself, for example:

- `cat scripts/schema.sql | docker compose exec -T timescaledb psql -U meshcore -d meshcore`

## How to think about the current state

- This repo is an **MVP / scaffold**, not a finished monitoring product.
- The main edge -> ingest -> TimescaleDB path exists, but it still has sharp edges:
  - edge reads repeaters from JSON,
  - polls Meshcore companion,
  - batches and signs payloads,
  - ingest verifies and writes to TimescaleDB.
- Current data-contract caveat: `edge/src/companion.ts` derives `battery` from `batt_milli_volts` as a decimal value, while `ingest/src/types.ts` currently validates `battery` as an integer `0..100`; batches that include battery data can currently fail validation.
- The implemented ingest API is currently just:
  - `GET /health`
  - `POST /ingest`
- `SPEC.md` mentions `POST /devices/register` and optional `GET /metrics`, but those routes are **not implemented** right now.
- There is **no automated test suite** in the repo today. Practical validation is currently linting plus ingest typechecking.
- Grafana is provisioned as a container, but there are no checked-in dashboards yet.

## Notes for contributors and coding agents

- **Use `SPEC.md` for intended design**, but treat the codebase as the source of truth for current behavior.
- **Schema source of truth:** `scripts/schema.sql`.
- **Edge polling source of truth:** `edge/src/companion.ts`, called from `edge/src/main.ts`.
- **Edge scheduling source of truth:** `edge/src/scheduler.ts`.
- **Edge batching/signing/send path:** `edge/src/batcher.ts`, `edge/src/signing.ts`, `edge/src/sender.ts`, `edge/src/queue.ts`.
- **Ingest payload validation:** `ingest/src/types.ts`.
- **Ingest auth validation:** `ingest/src/tokens.ts`.
- **Ingest write path:** `ingest/src/routes.ts`.
- **Device auto-registration:** `ingest/src/device-store.ts`.
- **Repeater configuration is file-based right now**, via `edge/config/repeaters.json`; there is no DB-backed repeater registry yet.
- **Neighbor data is intentionally partial**: current Meshcore library responses reliably expose neighbor prefix and SNR, while fields like per-neighbor RSSI, link quality, and hops remain optional.
- `edge/src/main.ts` is an **infinite loop** and waits across the configured polling window. Do not run `bun run --cwd edge dev` as a casual smoke test unless you actually want hardware/network side effects.
- `POLL_CONCURRENCY` exists in edge config, but the current `main.ts` processing is still sequential.
- If you run the edge package from inside `edge/`, use the env file or set `REPEATERS_CONFIG_PATH=config/repeaters.json`; the code default is repo-root oriented and easy to trip over during local runs.
