// Matches the delay definition proposed in upstream PR #2324.
import { routineScheduleDelayed } from "./routine-dispatch.js";

export function routineScheduleDelay(active: boolean, nextRunAt: Date | null, now: Date): boolean {
  return routineScheduleDelayed({ active, nextRunAt: nextRunAt?.getTime() ?? null }, now.getTime());
}
