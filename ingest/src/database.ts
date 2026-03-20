import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.database.url, {
  prepare: true,
  max: 10
});

export async function closeDb() {
  await sql.end();
}
