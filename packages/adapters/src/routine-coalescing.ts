import type { Prisma } from "@rakazo/db";
import { appendEventInTransaction } from "@rakazo/db";

/** Reserved provenance for recurring timer ticks; manual/event/retry runs never use it. */
export function routineTimerNonce(routineId: string, scheduledFor: string): string {
  return `routine-timer:${routineId}:${scheduledFor}`;
}

/**
 * Call while holding the routine row lock. Keep at most one unstarted catch-up
 * for the same work; never fold an event, manual test, retry, or actually attempted run.
 */
export async function findPendingRoutineTick(
  tx: Prisma.TransactionClient,
  config: {
    routineId: string;
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    prompt: string;
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string | null;
    modelPinned?: true;
  },
) {
  const pristine: Prisma.RunWhereInput = {
    routineId: config.routineId,
    spaceId: config.spaceId,
    botId: config.botId,
    userId: config.userId,
    threadId: config.threadId,
    trigger: "routine",
    status: "queued",
    retryOfRunId: null,
    sourceMessageId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: null,
    firstResponseAt: null,
    checkpoint: null,
    error: null,
    modelProvider: config.modelProvider ?? null,
    modelId: config.modelId ?? null,
    thinkingLevel: config.thinkingLevel ?? null,
    modelPinned: config.modelPinned ?? false,
    attempts: { none: {} },
    effects: { none: {} },
    steeringMessages: { none: {} },
    task: { status: "queued", prompt: config.prompt },
  };
  const selection = {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, clientNonce: true, leaseFence: true, updatedAt: true },
    take: 100,
  } satisfies Omit<Prisma.RunFindManyArgs, "where">;
  // Known timer provenance must not sit behind arbitrary manual runs in the
  // same bounded page. Legacy event references are selected before pagination
  // too; Event.runId intentionally has no Prisma relation on Run.
  const [knownTimers, legacyReferences] = await Promise.all([
    tx.run.findMany({
      ...selection,
      where: {
        ...pristine,
        clientNonce: { startsWith: `routine-timer:${config.routineId}:` },
      },
    }),
    tx.$queryRaw<{ runId: string }[]>`
      SELECT DISTINCT e."runId"
      FROM events e JOIN runs r ON r.id = e."runId"
      WHERE r."routineId" = ${config.routineId}
        AND r.status = 'queued' AND r."clientNonce" IS NULL
        AND e.type = 'routine.fired'
      ORDER BY e."runId" LIMIT 100
    `,
  ]);
  const legacyCandidates = legacyReferences.length
    ? await tx.run.findMany({
        ...selection,
        where: {
          ...pristine,
          clientNonce: null,
          id: { in: legacyReferences.map(({ runId }) => runId) },
        },
      })
    : [];
  // Reserved-provenance rows always get a place, so ambiguous legacy records
  // cannot cause recurring ticks to grow a fresh pending backlog.
  const candidates = [...knownTimers, ...legacyCandidates].slice(0, 100);
  if (!candidates.length) return null;
  const runIds = candidates.map((candidate) => candidate.id);
  const legacyIds = candidates
    .filter((candidate) => candidate.clientNonce === null)
    .map((candidate) => candidate.id);
  // Bound round trips independently of backlog size. Event payloads are encrypted
  // at rest; read their decrypted values rather than filtering JSON paths in SQL.
  const [legacyEvents, leases, computers] = await Promise.all([
    legacyIds.length
      ? tx.event.findMany({
          where: { runId: { in: legacyIds }, type: "routine.fired" },
          select: { runId: true, payload: true },
        })
      : [],
    tx.computerExecutionLease.findMany({
      where: { runId: { in: runIds }, expiresAt: { gt: new Date() } },
      select: { runId: true },
    }),
    tx.computer.findMany({
      where: { controlRunId: { in: runIds } },
      select: { controlRunId: true },
    }),
  ]);
  const legacyTimers = new Set(
    legacyEvents
      .filter(
        ({ payload }) =>
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.scheduledFor === "string" &&
          payload.routineId === config.routineId,
      )
      .map(({ runId }) => runId),
  );
  const held = new Set(leases.map(({ runId }) => runId));
  const controlled = new Set(computers.map(({ controlRunId }) => controlRunId));
  let retained: { id: string; taskId: string } | null = null;
  const cancelledEvents: { threadId: string; seq: number }[] = [];
  for (const candidate of candidates) {
    // Missing provenance is deliberately preserved instead of risking manual work.
    const timer =
      candidate.clientNonce?.startsWith(`routine-timer:${config.routineId}:`) ||
      (candidate.clientNonce === null && legacyTimers.has(candidate.id));
    // A stale pre-attempt timestamp/fence from an older release does not prove
    // execution. Attempts, effects, checkpoints and live computer ownership do.
    if (!timer || held.has(candidate.id) || controlled.has(candidate.id)) continue;
    // Dispatch can race the earlier read. Lock and recheck, including its exact
    // fence, so work claimed since the selection is never folded or cancelled.
    const locked = await tx.run.updateMany({
      where: { ...pristine, id: candidate.id, leaseFence: candidate.leaseFence },
      data: retained
        ? {
            status: "cancelled",
            completedAt: new Date(),
            wakeAt: null,
            leaseFence: { increment: 1 },
          }
        : { updatedAt: candidate.updatedAt },
    });
    if (locked.count !== 1) continue;
    if (!retained) {
      retained = { id: candidate.id, taskId: candidate.taskId };
      continue;
    }
    // Keep historical rows and terminal events; only redundant, unstarted timer
    // occurrences disappear from the runnable backlog.
    await tx.task.updateMany({
      where: { id: candidate.taskId, status: "queued", runs: { every: { status: "cancelled" } } },
      data: { status: "cancelled" },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: config.spaceId,
      threadId: config.threadId,
      botId: config.botId,
      type: "run.cancelled",
      runId: candidate.id,
      payload: { reason: "routine_coalesced", supersededByRunId: retained.id },
    });
    cancelledEvents.push({ threadId: config.threadId, seq: event.seq });
  }
  return retained && { ...retained, ...(cancelledEvents.length ? { cancelledEvents } : {}) };
}
