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
   - Persists the current repeater status surface in explicit `metrics` columns rather than a JSON status blob.

3. **Database**

   - Schema lives in `scripts/schema.sql`.
   - Uses Timescale hypertables for `metrics`, `neighbors`, and `device_heartbeats`.

4. **Grafana**
   - Started by `docker-compose.yml`.
   - Auto-provisions a local TimescaleDB datasource plus checked-in dashboards from `grafana/`.

`docker-compose.yml` is the **central-stack** entry point (`timescaledb`, `ingest`, `grafana`). `edge/docker-compose.yml` is the separate **edge-local** entry point for running only the edge client container against a local or remote ingest service.

## Repo layout

- `SPEC.md` - intended architecture, payload contract, and open implementation tasks.
- `SUMMARY.md` - short implementation snapshot.
- `docker-compose.yml` - local central stack only.
- `edge/docker-compose.yml` - local edge-only compose entry point.
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

## Central stack configuration

Before starting the root `docker-compose.yml` stack, copy the checked-in example env file:

- `cp .env.example .env`

`.env.example` gives a sane local default setup:

- PostgreSQL / TimescaleDB user, password, and database all default to `meshcore`
- TimescaleDB is published on host port `5432`
- ingest listens on and publishes port `8080`
- Grafana is published on host port `3000` with admin password `meshcore`

Override those values in `.env` when needed. The port behavior is intentionally different per service:

- `TIMESCALEDB_PORT` changes only the published **host** port; the container still listens on `5432`
- `INGEST_PORT` changes the ingest runtime port and the published `host:container` mapping together
- `GRAFANA_PORT` changes only the published **host** port; the container still listens on `3000`

Central-stack examples below assume the default `.env.example` ports unless they explicitly show placeholders. If you override ports in `.env`, use those host ports in your `curl`, browser, and edge `INGEST_URL` examples.

## Common commands

### Safe inspection / validation commands

- `cp .env.example .env`
- `bun install`
- `bun run lint`
- `bun run --cwd ingest typecheck`
- `docker compose config`
- `docker compose up --build timescaledb ingest grafana`
- `docker compose -f edge/docker-compose.yml config`
- `docker compose -f edge/docker-compose.yml up --build`
- `curl http://localhost:<INGEST_PORT>/health` (default `8080`)
- `bun run mock-ingest -- --print-reference-sql --location-id SFO --repeaters 4 | docker compose exec -T timescaledb psql -U meshcore -d meshcore`
- Open Grafana at `http://localhost:<GRAFANA_PORT>` (default `3000`) with `admin` / your `GRAFANA_ADMIN_PASSWORD`.

### Service commands

- `bun run --cwd ingest dev`
- `bun run --cwd ingest start`
- `bun run --cwd edge dev`
- `bun run mock-ingest -- --iterations 12 --interval-ms 5000`

### Mock ingest generator

Use the synthetic generator to exercise `/ingest` without Meshcore hardware:

- `bun run mock-ingest -- --iterations 6 --interval-ms 2000 --repeaters 5`
- `bun run mock-ingest -- --duration-seconds 60 --seed LAX --device-id mock-lax --location-id LAX`
- `bun run mock-ingest -- --dry-run --iterations 1`
- `bun run mock-ingest -- --print-reference-sql --seed LAX --location-id LAX --repeaters 5`

The script posts batches directly to the ingest endpoint, signs each request with the same Ed25519 JWT-like token format as the edge service, and derives a deterministic demo keypair from `--seed` unless `--private-key-hex` and `--public-key-hex` are provided explicitly. By default it targets `http://localhost:8080/ingest`, which matches the root `.env.example`. If you override `INGEST_PORT` for the central stack, pass `--ingest-url http://localhost:<your-ingest-port>/ingest`. Use uppercase three-letter IATA location IDs such as `SFO` or `LAX`.

On a fresh database, seed the referenced location and repeaters before posting batches. `--print-reference-sql` prints deterministic `INSERT` statements that match the current `--seed`, `--location-id`, and `--repeaters` values so you can pipe them straight into `psql`.

### Schema setup

Compose does **not** apply `scripts/schema.sql` automatically. After TimescaleDB is up, apply it yourself, for example:

The `psql` commands below assume the default `.env.example` database name and credentials. If you override `POSTGRES_USER` or `POSTGRES_DB` in the root `.env`, substitute those values.

- `cat scripts/schema.sql | docker compose exec -T timescaledb psql -U meshcore -d meshcore`
- `bun run mock-ingest -- --print-reference-sql --location-id SFO --repeaters 4 | docker compose exec -T timescaledb psql -U meshcore -d meshcore`

Practical local smoke path:

1. `docker compose up --build timescaledb ingest grafana`
2. `cat scripts/schema.sql | docker compose exec -T timescaledb psql -U meshcore -d meshcore`
3. `bun run mock-ingest -- --print-reference-sql --location-id SFO --repeaters 4 | docker compose exec -T timescaledb psql -U meshcore -d meshcore`
4. `curl http://localhost:<INGEST_PORT>/health` (default `8080`)
5. `bun run mock-ingest -- --iterations 2 --interval-ms 1000 --location-id SFO --ingest-url http://localhost:<INGEST_PORT>/ingest` (default `8080`)
6. `docker compose exec -T timescaledb psql -U meshcore -d meshcore -c "SELECT COUNT(*) FROM metrics;"`

## Running edge with Docker Compose

The repo now has two separate compose entry points:

- `docker-compose.yml` for the central stack only
- `edge/docker-compose.yml` for the edge client only

Typical local workflow:

1. Start the central stack from the repo root: `docker compose up --build timescaledb ingest grafana`
2. If you changed the central-stack host ingest port in the root `.env`, set `INGEST_URL=http://host.docker.internal:<your-ingest-port>/ingest` when starting the edge client.
3. Start the edge client from the repo root: `docker compose -f edge/docker-compose.yml up --build`
4. Stop the edge client with: `docker compose -f edge/docker-compose.yml down`

Important edge overrides in `edge/docker-compose.yml` are the same runtime env vars used by `edge/src/config.ts`:

- `LOCATION_ID`
- `INGEST_URL`
- `WINDOW_HOURS`
- `POLL_CONCURRENCY`
- `REPEATERS_CONFIG_PATH`
- `STARTUP_MODE`, `STARTUP_STAGGER_DELAY_MS`
- `COMPANION_CONNECTION`, `COMPANION_TCP_HOST`, `COMPANION_TCP_PORT`
- `COMPANION_SERIAL_PATH`
- `COMPANION_TELEMETRY_TIMEOUT_MS`, `COMPANION_STATUS_TIMEOUT_MS`
- `AUTH_TOKEN_TTL_SECONDS`

Startup behavior defaults to `STARTUP_MODE=scheduled`, which keeps the previous behavior and waits for the normal scheduled polling windows. The other modes send a dedicated startup batch immediately on boot before scheduled windows resume:

- `scheduled`: default behavior; no special startup sweep.
- `immediate-once`: read all repeaters immediately and send one dedicated startup batch.
- `immediate-staggered`: same dedicated startup batch, but pause `STARTUP_STAGGER_DELAY_MS` between repeater reads (default `1000` ms).

Device identity and auth signing are **not** configured through env vars anymore. At runtime the edge agent asks the Meshcore device/companion for its public key/device identity and uses the device/companion to sign auth tokens.

`LOCATION_ID` must be an uppercase three-letter IATA code such as `SFO` or `LAX`.

`edge/docker-compose.yml` defaults `INGEST_URL` and `COMPANION_TCP_HOST` to `host.docker.internal`, with `extra_hosts` wired to Docker's `host-gateway`, so the edge container can talk to services listening on the Docker host:

- `INGEST_URL=http://host.docker.internal:8080/ingest` (override this if the root central stack uses a different `INGEST_PORT`)
- `COMPANION_CONNECTION=tcp`
- `COMPANION_TCP_HOST=host.docker.internal`
- `COMPANION_TCP_PORT=5000`

If ingest or the Meshcore companion runs somewhere else, override those values explicitly. Example:

- `LOCATION_ID=LAX INGEST_URL=http://10.0.0.20:8080/ingest COMPANION_TCP_HOST=10.0.0.30 docker compose -f edge/docker-compose.yml up --build`

Persistent edge files live in two places:

- Repeater config on the host: `./edge/config/repeaters.json`, mounted read-only at `/app/config/repeaters.json` in the container.
- Queue data in the named Docker volume `edge-queue-data`, mounted at `/app/.queue`.

## How to think about the current state

- This repo is an **MVP / scaffold**, not a finished monitoring product.
- The main edge -> ingest -> TimescaleDB path exists, but it still has sharp edges:
  - edge reads repeaters from JSON,
  - polls Meshcore companion,
  - batches and signs payloads,
  - ingest verifies and writes to TimescaleDB.
- Current repeater status telemetry is carried end-to-end as explicit metric fields/columns, including raw `battery_milli_volts` / `snr_raw`, `noise_floor`, `air_time`, queue length, packet totals plus direct/flood splits, error events, and duplicate counts.
- `battery` remains a derived volts value (for example `4.05`) alongside raw `battery_milli_volts`; storage is explicit `metrics` columns, not a JSON status blob.
- The implemented ingest API is currently just:
  - `GET /health`
  - `POST /ingest`
- `SPEC.md` mentions `POST /devices/register` and optional `GET /metrics`, but those routes are **not implemented** right now.
- There is **no automated test suite** in the repo today. Practical validation is currently linting plus ingest typechecking.
- Grafana starts with a provisioned TimescaleDB datasource and three checked-in dashboards: `Meshcore Overview`, `Meshcore Neighbors`, and `Meshcore Repeater Detail`.

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
- `edge/src/main.ts` is an **infinite loop**. With the default `scheduled` startup mode it waits across the configured polling window; the immediate startup modes send a dedicated startup batch first, then resume the normal schedule. Do not run `bun run --cwd edge dev` as a casual smoke test unless you actually want hardware/network side effects.
- `POLL_CONCURRENCY` exists in edge config, but the current `main.ts` processing is still sequential.
- `REPEATERS_CONFIG_PATH` resolves relative to the current working directory. `bun run --cwd edge dev` works with the default `config/repeaters.json`; if you launch the process from the repo root without `--cwd edge`, point it at `edge/config/repeaters.json`.
