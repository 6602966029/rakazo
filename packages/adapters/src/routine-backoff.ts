import type { JobPublisher } from "@rakazo/adapter-kit";
import { routineWakeupJob } from "@rakazo/adapter-kit";
import { nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** The first account-error failure holds the routine this long; each further one doubles it. */
const ROUTINE_ACCOUNT_BACKOFF_BASE_MS = 5 * 60_000;
const ROUTINE_ACCOUNT_BACKOFF_MAX_MS = 24 * 60 * 60_000;

interface RoutineBackoffDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

export function routineAccountBackoffMs(failures: number): number {
  return Math.min(
    ROUTINE_ACCOUNT_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
    ROUTINE_ACCOUNT_BACKOFF_MAX_MS,
  );
}

/**
 * A rejected key, exhausted credits or a retired model fails every run the same way until the
 * user fixes their provider account, so a frequent routine would keep firing against it. Push
 * its next run out by a gap that doubles with each such failure in a row.
 */
export async function backOffRoutineAfterAccountError(
  deps: RoutineBackoffDeps,
  routineId: string,
  now = new Date(),
): Promise<void> {
  try {
    const counted = await deps.prisma.routine.updateMany({
      where: { id: routineId },
      data: { accountFailures: { increment: 1 } },
    });
    if (counted.count !== 1) return;
    const routine = await deps.prisma.routine.findUnique({
      where: { id: routineId },
      select: {
        active: true,
        crons: true,
        timezone: true,
        watch: true,
        nextRunAt: true,
        accountFailures: true,
      },
    });
    if (!routine?.active || !routine.nextRunAt) return;
    const resumeAt = new Date(now.getTime() + routineAccountBackoffMs(routine.accountFailures));
    if (routine.nextRunAt >= resumeAt) return;
    // A timer routine keeps its cadence after the gap; a change trigger just checks again then.
    const nextRunAt =
      (routine.watch == null
        ? nextRoutineRunDateAcross(routine.crons, routine.nextRunAt, resumeAt, routine.timezone)
        : null) ?? resumeAt;
    await reschedule(deps, routineId, routine.nextRunAt, nextRunAt);
  } catch (error) {
    getLogger().error("routine.backoff", error);
  }
}

/** A run of the routine got through, so its schedule returns to normal. */
export async function clearRoutineBackoff(
  deps: RoutineBackoffDeps,
  routineId: string,
  now = new Date(),
): Promise<void> {
  try {
    const cleared = await deps.prisma.routine.updateMany({
      where: { id: routineId, accountFailures: { gt: 0 } },
      data: { accountFailures: 0 },
    });
    if (cleared.count !== 1) return;
    const routine = await deps.prisma.routine.findUnique({
      where: { id: routineId },
      select: { active: true, crons: true, timezone: true, watch: true, nextRunAt: true },
    });
    if (!routine?.active || !routine.nextRunAt || routine.watch != null) return;
    const nextRunAt = nextRoutineRunDateAcross(routine.crons, now, now, routine.timezone);
    if (!nextRunAt || nextRunAt >= routine.nextRunAt) return;
    await reschedule(deps, routineId, routine.nextRunAt, nextRunAt);
  } catch (error) {
    getLogger().error("routine.backoff_clear", error);
  }
}

async function reschedule(
  deps: RoutineBackoffDeps,
  routineId: string,
  from: Date,
  nextRunAt: Date,
): Promise<void> {
  // Only the schedule that was read moves; a concurrent edit or wakeup keeps its own.
  const moved = await deps.prisma.routine.updateMany({
    where: { id: routineId, active: true, nextRunAt: from },
    data: { nextRunAt },
  });
  if (moved.count === 1) await deps.jobs.enqueue(routineWakeupJob(routineId, nextRunAt));
}
