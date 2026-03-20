import { loadRepeaters } from "../src/repeaters-config.js";
import { readRepeaterMetrics } from "../src/companion.js";

async function main() {
  const repeaters = await loadRepeaters();
  if (repeaters.length === 0) {
    console.error("No repeaters configured");
    process.exit(1);
  }
  const repeater = repeaters[0];
  console.log(`Reading telemetry for repeater ${repeater.repeaterId}`);
  const result = await readRepeaterMetrics(repeater);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test failed", err);
  process.exit(1);
});
