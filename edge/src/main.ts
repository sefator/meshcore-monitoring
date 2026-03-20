import { config } from "./config.js";
import { readRepeaterMetrics } from "./companion.js";
import { buildSchedule } from "./scheduler.js";
import { BatchBuilder } from "./batcher.js";
import { sendBatch, flushQueue } from "./sender.js";
import { loadRepeaters } from "./repeaters-config.js";

async function runWindow() {
  const windowStart = new Date();
  const windowEnd = new Date(
    windowStart.getTime() + config.windowHours * 60 * 60 * 1000,
  );
  const repeaters = await loadRepeaters();
  const schedule = buildSchedule(repeaters, windowStart);
  const batcher = new BatchBuilder(windowStart, windowEnd);

  for (const item of schedule) {
    const waitMs = item.scheduledAt.getTime() - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const { metrics, neighbors } = await readRepeaterMetrics(item.repeater);
    batcher.addMetric(metrics);
    neighbors.forEach((n) => batcher.addNeighbors(n));
  }

  const batch = batcher.build();
  await sendBatch(batch);
  await flushQueue();
}

async function main() {
  while (true) {
    await runWindow();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
