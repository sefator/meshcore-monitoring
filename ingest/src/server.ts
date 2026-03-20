import Fastify from "fastify";
import fastifyRawBody from "fastify-raw-body";
import { config } from "./config.js";
import { registerRoutes } from "./routes.js";
import { log } from "./log.js";

async function main() {
  const app = Fastify({ logger: false });
  await app.register(fastifyRawBody, { global: false, runFirst: true });
  await registerRoutes(app);
  await app.listen({ port: config.server.port, host: config.server.host });
  log.info(`ingest listening on ${config.server.host}:${config.server.port}`);
}

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
