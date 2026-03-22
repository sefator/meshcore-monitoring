import { promises as fs } from "fs";
import path from "path";
import { log } from "./log.js";

const QUEUE_DIR = path.join(process.cwd(), ".queue");

export async function enqueueBatch(payload: string) {
  await fs.mkdir(QUEUE_DIR, { recursive: true });
  const filename = path.join(QUEUE_DIR, `${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(filename, payload, "utf8");
  log.warn(
    "queue entry enqueued",
    path.basename(filename),
    `bytes=${Buffer.byteLength(payload, "utf8")}`,
  );
}

export async function drainQueue() {
  await fs.mkdir(QUEUE_DIR, { recursive: true });
  const files = (await fs.readdir(QUEUE_DIR)).sort();
  const entries: { path: string; body: string }[] = [];
  for (const file of files) {
    const full = path.join(QUEUE_DIR, file);
    const body = await fs.readFile(full, "utf8");
    entries.push({ path: full, body });
  }
  if (entries.length === 0) {
    log.info("queue drain empty");
  } else {
    log.info(
      "queue drain loaded",
      `${entries.length} entries`,
      `oldest=${files[0]}`,
      `newest=${files[files.length - 1]}`,
    );
  }
  return entries;
}

export async function removeEntry(entryPath: string) {
  await fs.rm(entryPath, { force: true });
  log.info("queue entry removed", path.basename(entryPath));
}
