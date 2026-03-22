import { enqueueBatch, drainQueue, removeEntry } from "./queue.js";
import { getDeviceIdentity } from "./companion.js";
import { config } from "./config.js";
import { log } from "./log.js";
import type { BatchPayload } from "./types.js";
import { createAuthToken, runSigningSelfCheck } from "./signing.js";

const MAX_RESPONSE_TEXT_LENGTH = 300;
const loggedSigningDiagnostics = new Set<string>();

type ResponseLogContext = {
  status: number;
  statusText?: string;
  responseContentType?: string;
  responseText?: string;
  responseReadError?: string;
};

function normalizeBatchDeviceId(batch: BatchPayload, deviceId: string): BatchPayload {
  if (batch.device_id === deviceId) {
    return batch;
  }
  return { ...batch, device_id: deviceId };
}

function getBatchLogContext(batch: BatchPayload, extra: Record<string, unknown> = {}) {
  return {
    url: config.ingestUrl,
    deviceId: batch.device_id,
    locationId: batch.location_id,
    batchId: batch.batch_id,
    sentAt: batch.sent_at,
    metricsCount: batch.metrics.length,
    neighborsCount: batch.neighbors.length,
    hasHeartbeat: Boolean(batch.heartbeat),
    ...extra,
  };
}

function formatError(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function truncateText(value: string, maxLength = MAX_RESPONSE_TEXT_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

async function getResponseLogContext(res: Response): Promise<ResponseLogContext> {
  const responseContext: ResponseLogContext = {
    status: res.status,
    statusText: res.statusText || undefined,
    responseContentType: res.headers.get("content-type") ?? undefined
  };

  try {
    const responseText = truncateText(res.text ? (await res.text()).trim() : "");
    if (responseText) {
      responseContext.responseText = responseText;
    }
  } catch (err) {
    responseContext.responseReadError = formatError(err);
  }

  return responseContext;
}

function shouldRunSigningDiagnostic(responseContext: ResponseLogContext) {
  return typeof responseContext.responseText === "string" &&
    responseContext.responseText.toLowerCase().includes("signature mismatch");
}

async function maybeLogSigningDiagnostic(
  identity: { deviceId: string; publicKeyHex: string },
  logContext: Record<string, unknown>,
  responseContext: ResponseLogContext,
) {
  if (!shouldRunSigningDiagnostic(responseContext)) {
    return;
  }

  const dedupeKey = identity.publicKeyHex.toUpperCase();
  if (loggedSigningDiagnostics.has(dedupeKey)) {
    return;
  }

  loggedSigningDiagnostics.add(dedupeKey);
  try {
    const signingSelfCheck = await runSigningSelfCheck(identity);
    log.warn("ingest signature mismatch diagnostic", {
      ...logContext,
      responseStatus: responseContext.status,
      signingSelfCheck
    });
  } catch (err) {
    log.warn("ingest signature mismatch diagnostic failed", {
      ...logContext,
      responseStatus: responseContext.status,
      error: formatError(err)
    });
  }
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
    const responseContext = await getResponseLogContext(res);
    await maybeLogSigningDiagnostic(identity, logContext, responseContext);
    log.warn("ingest write failed", {
      ...logContext,
      ...responseContext
    });
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
      const token = await createAuthToken(identity);
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

    const responseContext = await getResponseLogContext(res);
    await maybeLogSigningDiagnostic(identity, logContext, responseContext);
    log.warn("queued batch replay failed", { ...logContext, ...responseContext });
  }
}
