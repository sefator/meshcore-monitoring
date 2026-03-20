import { enqueueBatch, drainQueue, removeEntry } from "./queue.js";
import { config } from "./config.js";
import type { BatchPayload } from "./types.js";
import { createAuthToken } from "./signing.js";

export async function sendBatch(batch: BatchPayload) {
  const body = JSON.stringify(batch);
  const token = createAuthToken();
  const headers = {
    "Content-Type": "application/json",
    "X-Device-Id": config.deviceId,
    "X-Auth-Token": token
  };
  try {
    const res = await fetch(config.ingestUrl, { method: "POST", body, headers });
    if (!res.ok) {
      throw new Error(`ingest status ${res.status}`);
    }
  } catch (err) {
    await enqueueBatch(body);
    throw err;
  }
}

export async function flushQueue() {
  const entries = await drainQueue();
  for (const entry of entries) {
    try {
      const batch: BatchPayload = JSON.parse(entry.body);
      const token = createAuthToken();
      const res = await fetch(config.ingestUrl, {
        method: "POST",
        body: JSON.stringify(batch),
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": config.deviceId,
          "X-Auth-Token": token
        }
      });
      if (res.ok) {
        await removeEntry(entry.path);
      }
    } catch (err) {
      break;
    }
  }
}
