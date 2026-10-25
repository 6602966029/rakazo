import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * How a computer run ended.
 * - `stopped`: stopped on request (the stop button, a computer switch, an archived bot).
 * - `idle` / `active_limit`: idle shutdown, or the cap on one continuous stretch.
 * - `replaced`: torn down by update, recovery or reset; the replacement starts a new run.
 * - `gone`: the provider had already stopped or lost the sandbox. The end is when Rakazo noticed.
 * - `deleted`: destroyed with its computer, bot, space or account.
 * - `reconciled`: the end was never seen; a later start or the reconciler found the computer
 *   no longer running. The end is when that was detected.
 */
export type ComputerRunEnd =
  | "stopped"
  | "idle"
  | "active_limit"
  | "replaced"
  | "gone"
  | "deleted"
  | "reconciled";

type RunsClient = Pick<PrismaClient, "computerRun">;

/**
 * Records the run that began at the computer's `runningSince`, and closes an earlier run whose
 * end was missed with `previousEnd`. Idempotent: a reconnect within the same stretch is a no-op.
 * Usage recording never fails the lifecycle transition that calls it.
 */
export async function recordComputerRunStart(
  prisma: RunsClient,
  computer: { id: string; spaceId: string; userId: string; kind: string },
  startedAt: Date,
  previousEnd: ComputerRunEnd = "reconciled",
): Promise<void> {
  // Host computers run on the user's own machine, and Electron, not Rakazo, sees them stop.
  if (computer.kind === "desktop") return;
  try {
    await prisma.computerRun.updateMany({
      where: { computerId: computer.id, endedAt: null, startedAt: { lt: startedAt } },
      data: { endedAt: startedAt, endReason: previousEnd },
    });
    await prisma.computerRun.createMany({
      data: [
        {
          computerId: computer.id,
          spaceId: computer.spaceId,
          userId: computer.userId,
          kind: computer.kind,
          startedAt,
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computer.id,
      transition: "start",
    });
  }
}

/** Closes the computer's open run, if any. Never fails the transition that calls it. */
export async function recordComputerRunEnd(
  prisma: RunsClient,
  computerId: string,
  reason: ComputerRunEnd,
  endedAt = new Date(),
): Promise<void> {
  try {
    await prisma.computerRun.updateMany({
      where: { computerId, endedAt: null, startedAt: { lte: endedAt } },
      data: { endedAt, endReason: reason },
    });
  } catch (error) {
    getLogger().error("computer.run_record_failed", error, {
      "computer.id": computerId,
      transition: "end",
      reason,
    });
  }
}

/**
 * Closes open runs the lifecycle did not close: the computer row is gone, it is no longer
 * running, or a newer stretch has begun. Covers a crash or deploy between the provider stop and
 * the usage write, a failed usage write, and paths that stop a computer without recording it.
 */
export async function closeStaleComputerRuns(
  prisma: Pick<PrismaClient, "$executeRaw">,
  now = new Date(),
): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "computer_runs" AS r
    SET "endedAt" = GREATEST(${now}::timestamp(3), r."startedAt"),
        "endReason" = CASE WHEN c."id" IS NULL THEN 'deleted' ELSE 'reconciled' END
    FROM "computer_runs" AS o
    LEFT JOIN "computers" AS c ON c."id" = o."computerId"
    WHERE r."id" = o."id"
      AND o."endedAt" IS NULL
      AND (
        c."id" IS NULL
        OR c."state" NOT IN ('running', 'booting', 'suspending')
        OR c."runningSince" IS DISTINCT FROM o."startedAt"
      )`;
}
