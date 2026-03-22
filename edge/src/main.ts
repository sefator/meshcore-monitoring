import { config } from "./config.js";
import { readRepeaterMetrics } from "./companion.js";
import { buildSchedule } from "./scheduler.js";
import { BatchBuilder } from "./batcher.js";
import { sendBatch, flushQueue } from "./sender.js";
import { loadRepeaters } from "./repeaters-config.js";
import { log } from "./log.js";
import type { MetricSample, NeighborSample } from "./types.js";

async function sleep(delayMs: number) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function buildBatch(
  windowStart: Date,
  windowEnd: Date,
  metrics: MetricSample[],
  neighbors: NeighborSample[],
) {
  const batcher = new BatchBuilder(windowStart, windowEnd);
  metrics.forEach((sample) => batcher.addMetric(sample));
  neighbors.forEach((sample) => batcher.addNeighbors(sample));
  return batcher.build();
}

type CollectionSource = "startup" | "window";
type BatchPayload = Awaited<ReturnType<typeof buildBatch>>;

function logCollectionSummary(
  source: CollectionSource,
  startedAt: Date,
  endedAt: Date,
  repeaterCount: number,
  successfulReads: number,
  neighborsCollected: number,
) {
  const failedReads = repeaterCount - successfulReads;

  log.info(
    source === "startup"
      ? "startup collection summary"
      : "collection window summary",
    `from=${startedAt.toISOString()}`,
    `to=${endedAt.toISOString()}`,
    `repeaters=${repeaterCount}`,
    `successful_reads=${successfulReads}`,
    `failed_reads=${failedReads}`,
    `neighbors=${neighborsCollected}`,
  );
}

async function sendBatchWithSummary(
  source: CollectionSource,
  batch: BatchPayload,
  repeaterCount: number,
  successfulReads: number,
) {
  const heartbeatOnly = successfulReads === 0;

  if (heartbeatOnly) {
    log.info(
      source === "startup"
        ? "sending heartbeat-only startup batch"
        : "sending heartbeat-only window batch",
      batch.batch_id,
      "reason=no_successful_repeater_reads",
      `repeaters=${repeaterCount}`,
      `failed_reads=${repeaterCount}`,
    );
  } else {
    log.info(
      source === "startup" ? "sending startup batch" : "sending batch",
      batch.batch_id,
    );
  }

  let sendSucceeded = false;
  try {
    await sendBatch(batch);
    sendSucceeded = true;
  } catch (err) {
    log.warn("batch send failed", batch.batch_id, `source=${source}`, err);
  }

  log.info("flushing queued batches", `after_batch=${batch.batch_id}`, `source=${source}`);

  let flushSucceeded = false;
  try {
    await flushQueue();
    flushSucceeded = true;
  } catch (err) {
    log.warn(
      "queued batch flush failed",
      `after_batch=${batch.batch_id}`,
      `source=${source}`,
      err,
    );
  }

  log.info(
    source === "startup"
      ? "startup batch delivery summary"
      : "window batch delivery summary",
    batch.batch_id,
    `send=${sendSucceeded ? "ok" : "failed"}`,
    `flush=${flushSucceeded ? "ok" : "failed"}`,
    `heartbeat_only=${heartbeatOnly}`,
  );
}

async function runStartupCollection() {
  if (config.startup.mode === "scheduled") {
    return;
  }

  const startupStartedAt = new Date();
  const repeaters = await loadRepeaters();
  const metrics: MetricSample[] = [];
  const neighbors: NeighborSample[] = [];
  let metricsCollected = 0;
  let neighborsCollected = 0;

  log.info(
    "startup collection started",
    `mode=${config.startup.mode}`,
    `from=${startupStartedAt.toISOString()}`,
    `${repeaters.length} repeaters`,
  );

  for (const [index, repeater] of repeaters.entries()) {
    if (
      config.startup.mode === "immediate-staggered" &&
      index > 0 &&
      config.startup.staggerDelayMs > 0
    ) {
      log.info(
        "waiting for staggered startup radio read",
        repeater.repeaterId,
        `delay_ms=${config.startup.staggerDelayMs}`,
        `sequence=${index + 1}/${repeaters.length}`,
      );
      await sleep(config.startup.staggerDelayMs);
    }

    log.info(
      "starting startup radio read",
      repeater.repeaterId,
      `sequence=${index + 1}/${repeaters.length}`,
    );
    try {
      const { metrics: metric, neighbors: repeaterNeighbors } =
        await readRepeaterMetrics(repeater);
      metrics.push(metric);
      neighbors.push(...repeaterNeighbors);
      metricsCollected += 1;
      neighborsCollected += repeaterNeighbors.length;
      log.info(
        "startup radio read complete",
        repeater.repeaterId,
        `sequence=${index + 1}/${repeaters.length}`,
        `metrics=${metricsCollected}`,
        `neighbors=${repeaterNeighbors.length}`,
        `startup_neighbors=${neighborsCollected}`,
      );
    } catch (err) {
      log.warn(
        "startup radio read failed",
        repeater.repeaterId,
        `sequence=${index + 1}/${repeaters.length}`,
        err,
      );
    }
  }

  const startupEndedAt = new Date();
  logCollectionSummary(
    "startup",
    startupStartedAt,
    startupEndedAt,
    repeaters.length,
    metricsCollected,
    neighborsCollected,
  );
  log.info("building startup batch");
  const batch = await buildBatch(
    startupStartedAt,
    startupEndedAt,
    metrics,
    neighbors,
  );
  log.info(
    "startup batch built",
    batch.batch_id,
    `metrics=${batch.metrics.length}`,
    `neighbors=${batch.neighbors.length}`,
    `window_from=${batch.window.from}`,
    `window_to=${batch.window.to}`,
  );
  await sendBatchWithSummary("startup", batch, repeaters.length, metricsCollected);
}

async function runWindow() {
  const windowStart = new Date();
  const windowEnd = new Date(
    windowStart.getTime() + config.windowHours * 60 * 60 * 1000,
  );
  const repeaters = await loadRepeaters();
  const schedule = buildSchedule(repeaters, windowStart);
  const metrics: MetricSample[] = [];
  const neighbors: NeighborSample[] = [];
  let metricsCollected = 0;
  let neighborsCollected = 0;

  log.info(
    "collection window started",
    `from=${windowStart.toISOString()}`,
    `to=${windowEnd.toISOString()}`,
    `${schedule.length} repeaters`,
  );

  for (const item of schedule) {
    const waitMs = item.scheduledAt.getTime() - Date.now();
    if (waitMs > 0) {
      log.info(
        "waiting for scheduled radio read",
        item.repeater.repeaterId,
        `delay_ms=${waitMs}`,
        `scheduled_at=${item.scheduledAt.toISOString()}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    log.info(
      "starting scheduled radio read",
      item.repeater.repeaterId,
      `scheduled_at=${item.scheduledAt.toISOString()}`,
    );
    try {
      const { metrics: metric, neighbors: repeaterNeighbors } =
        await readRepeaterMetrics(item.repeater);
      metrics.push(metric);
      neighbors.push(...repeaterNeighbors);
      metricsCollected += 1;
      neighborsCollected += repeaterNeighbors.length;
      log.info(
        "scheduled radio read complete",
        item.repeater.repeaterId,
        `metrics=${metricsCollected}`,
        `neighbors=${repeaterNeighbors.length}`,
        `window_neighbors=${neighborsCollected}`,
      );
    } catch (err) {
      log.warn(
        "scheduled radio read failed",
        item.repeater.repeaterId,
        `scheduled_at=${item.scheduledAt.toISOString()}`,
        err,
      );
    }
  }

  logCollectionSummary(
    "window",
    windowStart,
    windowEnd,
    schedule.length,
    metricsCollected,
    neighborsCollected,
  );
  log.info("building batch for window");
  const batch = await buildBatch(windowStart, windowEnd, metrics, neighbors);
  log.info(
    "batch built",
    batch.batch_id,
    `metrics=${batch.metrics.length}`,
    `neighbors=${batch.neighbors.length}`,
    `window_from=${batch.window.from}`,
    `window_to=${batch.window.to}`,
  );
  await sendBatchWithSummary("window", batch, schedule.length, metricsCollected);
}

async function main() {
  await runStartupCollection();

  while (true) {
    await runWindow();
  }
}

main().catch((err) => {
  log.error("edge app exiting", err);
  process.exit(1);
});
