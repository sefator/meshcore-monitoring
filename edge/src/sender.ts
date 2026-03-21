import { enqueueBatch, drainQueue, removeEntry } from "./queue.js";
import { getDeviceIdentity } from "./companion.js";
import { config } from "./config.js";
import type { BatchPayload } from "./types.js";
import { createAuthToken } from "./signing.js";

function normalizeBatchDeviceId(batch: BatchPayload, deviceId: string): BatchPayload {
  if (batch.device_id === deviceId) {
    return batch;
  }
  return { ...batch, device_id: deviceId };
}

export async function sendBatch(batch: BatchPayload) {
  const identity = await getDeviceIdentity();
  const normalizedBatch = normalizeBatchDeviceId(batch, identity.deviceId);
  const body = JSON.stringify(normalizedBatch);
  const token = await createAuthToken(identity);
  const headers = {
    "Content-Type": "application/json",
    "X-Device-Id": identity.deviceId,
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
  if (entries.length === 0) {
    return;
  }

  const identity = await getDeviceIdentity();
  const token = await createAuthToken(identity);
  for (const entry of entries) {
    try {
      const queuedBatch: BatchPayload = JSON.parse(entry.body);
      const batch = normalizeBatchDeviceId(queuedBatch, identity.deviceId);
      const res = await fetch(config.ingestUrl, {
        method: "POST",
        body: JSON.stringify(batch),
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": identity.deviceId,
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
