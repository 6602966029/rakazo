import type { JobPublisher } from "@rakazo/adapter-kit";
import { ModelAccountError, routineJobKey } from "@rakazo/adapter-kit";
import type { RunErrorKind } from "@rakazo/core";
import { normalizeRunError } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { postRoutineWatchMessage } from "./routine-watch.js";

/** Runs in a row the user's model connection must refuse before the routine stops firing. */
export const ROUTINE_CREDENTIAL_FAILURE_LIMIT = 3;

/** A rejected key, a model the account may not use, or a balance or plan that has run out. */
const CREDENTIAL_FAILURE_KINDS = new Set<RunErrorKind>([
  "auth",
  "access",
  "key",
  "credit",
  "spending",
]);

type RoutineCredentialDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: ThreadEvents;
};

/**
 * Whether the provider refused the user's own key or billing in a way that stays refused until
 * the user acts. Rate limits, timeouts, bad output and limits that reset on a date do not count.
 */
export function isModelCredentialRefusal(error: unknown): boolean {
  if (!(error instanceof ModelAccountError)) return false;
  const { kind, period, resetAt } = normalizeRunError(error.message);
  return (
    kind !== undefined &&
    CREDENTIAL_FAILURE_KINDS.has(kind) &&
    (period === undefined || period === "none") &&
    resetAt === undefined
  );
}

/**
 * Count a routine run that failed on the user's own model connection or billing. Each scheduled
 * run would fail the same way until the user fixes it, so after a few in a row the routine is
 * paused and its bot says why, once per pause.
 */
export async function countRoutineCredentialFailure(
  deps: RoutineCredentialDeps,
  run: { routineId: string; spaceId: string; threadId: string; botId: string },
  reason: string,
): Promise<void> {
  try {
    const counted = await deps.prisma.routine.updateMany({
      where: { id: run.routineId, active: true },
      data: { credentialFailures: { increment: 1 } },
    });
    if (counted.count !== 1) return;
    // Only the failure that reaches the limit on a still-active routine pauses it and speaks.
    const paused = await deps.prisma.routine.updateMany({
      where: {
        id: run.routineId,
        active: true,
        credentialFailures: { gte: ROUTINE_CREDENTIAL_FAILURE_LIMIT },
      },
      data: { active: false, nextRunAt: null, credentialFailures: 0 },
    });
    if (paused.count !== 1) return;
    await deps.jobs.cancel(routineJobKey(run.routineId)).catch(() => undefined);
    const routine = await deps.prisma.routine.findUnique({
      where: { id: run.routineId },
      select: { name: true },
    });
    getLogger().info("routine.paused_on_credentials", { "routine.id": run.routineId });
    await postRoutineWatchMessage(deps, {
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      role: "bot",
      text: `I paused the **${routine?.name ?? "scheduled"}** routine after ${ROUTINE_CREDENTIAL_FAILURE_LIMIT} runs in a row failed: ${reason}\n\nTurn it back on once that's fixed.`,
    });
  } catch (error) {
    getLogger().error("routine.credential_failure", error);
  }
}

/** A run got through to the model, so earlier refusals no longer count toward a pause. */
export async function clearRoutineCredentialFailures(
  deps: Pick<RoutineCredentialDeps, "prisma">,
  routineId: string,
): Promise<void> {
  await deps.prisma.routine
    .updateMany({
      where: { id: routineId, credentialFailures: { gt: 0 } },
      data: { credentialFailures: 0 },
    })
    .catch((error) => getLogger().error("routine.credential_failure_clear", error));
}
