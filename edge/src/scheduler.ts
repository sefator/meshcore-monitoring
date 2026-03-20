import { config } from "./config.js";
import type { Repeater } from "./types.js";

type ScheduleItem = {
  repeater: Repeater;
  scheduledAt: Date;
};

export function buildSchedule(repeaters: Repeater[], windowStart: Date) {
  const windowMs = config.windowHours * 60 * 60 * 1000;
  const items: ScheduleItem[] = repeaters.map((repeater) => {
    const jitterSeed = `${repeater.repeaterId}-${windowStart.toISOString().slice(0, 10)}`;
    const hash = hashString(jitterSeed);
    const offsetMs = hash % windowMs;
    return {
      repeater,
      scheduledAt: new Date(windowStart.getTime() + offsetMs)
    };
  });
  return items.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}
