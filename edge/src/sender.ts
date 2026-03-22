import { enqueueBatch, drainQueue, removeEntry } from "./queue.js";
import { getDeviceIdentity } from "./companion.js";
import { config } from "./config.js";
import { log } from "./log.js";
import type { BatchPayload } from "./types.js";
import { createAuthToken } from "./signing.js";

function normalizeBatchDeviceId(batch: BatchPayload, deviceId: string): BatchPayload {
  if (batch.device_id === deviceId) {
    return batch;
  }
  return { ...batch, device_id: deviceId };
}

function getBatchLogContext(batch: BatchPayload, extra: Record<string, unknown> = {}) {
  return {
    url: config.ingestUrl,
    batchId: batch.batch_id,
    metricsCount: batch.metrics.length,
    neighborsCount: batch.neighbors.length,
    hasHeartbeat: Boolean(batch.heartbeat),
    ...extra,
  };
}

function formatError(err: unknown) {
  return err instanceof Error ? err.message : String(err);
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

  const logContext = getBatchLogContext(normalizedBatch);
  log.info("sending batch to ingest", logContext);

  let res: Response;
  try {
    res = await fetch(config.ingestUrl, { method: "POST", body, headers });
  } catch (err) {
    log.warn("ingest write failed", { ...logContext, error: formatError(err) });
    await enqueueBatch(body);
    throw err;
  }

  if (!res.ok) {
    log.warn("ingest write failed", { ...logContext, status: res.status });
    await enqueueBatch(body);
    throw new Error(`ingest status ${res.status}`);
  }

  log.info("ingest write succeeded", { ...logContext, status: res.status });
}

export async function flushQueue() {
  const entries = await drainQueue();
  if (entries.length === 0) {
    return;
  }

  const identity = await getDeviceIdentity();
  const token = await createAuthToken(identity);
  for (const entry of entries) {
    let queuedBatch: BatchPayload;
    try {
      queuedBatch = JSON.parse(entry.body);
    } catch (err) {
      log.warn("queued batch replay aborted", {
        queueEntryPath: entry.path,
        error: formatError(err)
      });
      break;
    }

    const batch = normalizeBatchDeviceId(queuedBatch, identity.deviceId);
    const body = JSON.stringify(batch);
    const logContext = getBatchLogContext(batch, { queueEntryPath: entry.path });
    log.info("replaying queued batch to ingest", logContext);

    let res: Response;
    try {
      res = await fetch(config.ingestUrl, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Device-Id": identity.deviceId,
          "X-Auth-Token": token
        }
      });
    } catch (err) {
      log.warn("queued batch replay failed", {
        ...logContext,
        error: formatError(err)
      });
      break;
    }

    if (res.ok) {
      log.info("queued batch replay succeeded", {
        ...logContext,
        status: res.status
      });
      await removeEntry(entry.path);
      continue;
    }

    log.warn("queued batch replay failed", {
      ...logContext,
      status: res.status
    });
  }
}
