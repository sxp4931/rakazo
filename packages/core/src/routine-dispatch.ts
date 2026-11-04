export const ROUTINE_DELAY_GRACE_MS = 5 * 60_000;

/** A stale dispatch time is not proof that the worker is offline or the previous run failed. */
export function routineScheduleDelayed(
  routine: { active: boolean; nextRunAt: number | null },
  now = Date.now(),
): boolean {
  // Allow normal dispatch latency and a short deployment/startup gap.
  return (
    routine.active &&
    routine.nextRunAt !== null &&
    Number.isFinite(routine.nextRunAt) &&
    Number.isFinite(now) &&
    now - routine.nextRunAt > ROUTINE_DELAY_GRACE_MS
  );
}
