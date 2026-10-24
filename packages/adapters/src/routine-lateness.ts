import { nextRoutineRunDateAcross } from "@rakazo/core";
import { localDateTime } from "./current-time.js";
import { routineTimerScheduledFor } from "./routine-coalescing.js";

/**
 * A recurring run that starts this long after its most recent scheduled occurrence
 * is late enough that time-of-day assumptions in its prompt ("morning brief") may
 * no longer hold. Ordinary queueing and model latency stay well under it. Lateness
 * is measured from the most recent occurrence due by the start, so frequent
 * routines that simply missed ticks are not flagged and no interval scaling is needed.
 */
export const LATE_ROUTINE_RUN_MS = 15 * 60_000;

// Bounds the walk across missed occurrences; only schedules with no occurrence in
// the last LATE_ROUTINE_RUN_MS reach it, so it covers many days of downtime.
const MAX_MISSED_OCCURRENCES = 1000;

/**
 * Tells a recurring timer run that it started materially late (for example after the
 * host was offline at its scheduled time), with both times in the routine's timezone.
 * Returns undefined for on-time runs and for any run that is not a recurring timer tick.
 */
export function lateRoutineRunInstruction(
  run: { routineId: string | null; clientNonce: string | null },
  routine: { crons: string[]; timezone: string },
  now: Date,
): string | undefined {
  if (!run.routineId) return undefined;
  const scheduledFor = routineTimerScheduledFor(run.routineId, run.clientNonce);
  if (!scheduledFor) return undefined;
  const windowStart = new Date(now.getTime() - LATE_ROUTINE_RUN_MS);
  if (scheduledFor > windowStart) return undefined;
  const next = (from: Date) =>
    nextRoutineRunDateAcross(routine.crons, scheduledFor, from, routine.timezone);
  // A later occurrence due within the threshold makes this run on time for it.
  const recent = next(windowStart);
  if (recent && recent <= now) return undefined;
  let latest = scheduledFor;
  for (let step = 0; step < MAX_MISSED_OCCURRENCES; step++) {
    const following = next(latest);
    if (!following || following > windowStart) break;
    latest = following;
  }
  const zone = localDateTime(now, routine.timezone) ? routine.timezone : undefined;
  const format = (date: Date) =>
    zone
      ? `${localDateTime(date, zone)} (${zone})`
      : `${date.toISOString().replace(/\.\d{3}Z$/, "Z")} (UTC)`;
  return [
    `This scheduled run started late: it was due ${format(latest)} and started ${format(now)}.`,
    "Adapt anything that depends on the time of day to the actual time, skip steps that no longer make sense, and mention the delay when it matters to the user.",
  ].join(" ");
}
