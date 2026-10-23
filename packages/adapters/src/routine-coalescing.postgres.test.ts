import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPendingRoutineTick, routineTimerNonce } from "./routine-coalescing.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
describePostgres("routine timer coalescing (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const provisioned = await runAsSystem("routine coalescing fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { userId, spaceId, botId, threadId } = provisioned;
    identity = { userId, spaceId, botId, threadId };
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  async function fixture() {
    const routine = await system.routine.create({
      data: {
        ...identity,
        name: "timer fixture",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
      },
    });
    const config = { ...identity, routineId: routine.id, prompt: "fixture" };
    async function create(tx: Prisma.TransactionClient, clientNonce: string | null) {
      const task = await tx.task.create({
        data: { ...identity, prompt: "fixture", status: "queued" },
      });
      return tx.run.create({
        data: {
          ...identity,
          routineId: routine.id,
          taskId: task.id,
          trigger: "routine",
          status: "queued",
          clientNonce,
        },
      });
    }
    return { routine, config, create };
  }
  it("serializes concurrent ticks into one pending catch-up", async () => {
    const { routine, config, create } = await fixture();
    const tick = (index: number) =>
      system.$transaction(async (tx) => {
        await tx.routine.update({ where: { id: routine.id }, data: { lastRunAt: new Date() } });
        const pending = await findPendingRoutineTick(tx, config);
        return pending ?? create(tx, routineTimerNonce(routine.id, `tick-${index}`));
      });
    const results = await Promise.all([tick(1), tick(2)]);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(await system.run.count({ where: { routineId: routine.id } })).toBe(1);
  });
  it("preserves manual work and requires timer provenance for old runs", async () => {
    const { config, create } = await fixture();
    const manual = await system.$transaction((tx) => create(tx, null));
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    await system.event.create({
      data: {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
        type: "routine.fired",
        seq: 200,
        runId: manual.id,
        payload: { routineId: config.routineId, scheduledFor: "2026-01-01T00:00:00Z" },
      },
    });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toEqual({
      id: manual.id,
      taskId: manual.taskId,
    });
    await system.run.update({ where: { id: manual.id }, data: { startedAt: new Date() } });
    await system.attempt.create({ data: { runId: manual.id, fence: 1, status: "running" } });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
  });
  it("keeps an existing busy-computer delay on a reused run", async () => {
    const { config, create, routine } = await fixture();
    const pending = await system.$transaction((tx) =>
      create(tx, routineTimerNonce(routine.id, "tick")),
    );
    const wakeAt = new Date(Date.now() + 60_000);
    const updated = await system.run.update({ where: { id: pending.id }, data: { wakeAt } });
    await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    const after = await system.run.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.wakeAt).toEqual(wakeAt);
    expect(after.updatedAt).toEqual(updated.updatedAt);
  });
  it("cancels redundant old timer rows without deleting history or touching a real attempt", async () => {
    const { config, create } = await fixture();
    const older = await system.$transaction((tx) => create(tx, null));
    const duplicate = await system.$transaction((tx) => create(tx, null));
    const attempted = await system.$transaction((tx) => create(tx, null));
    for (const [index, run] of [older, duplicate, attempted].entries()) {
      await system.run.update({
        where: { id: run.id },
        data: { leaseFence: 4, startedAt: new Date() },
      });
      await system.event.create({
        data: {
          spaceId: identity.spaceId,
          threadId: identity.threadId,
          botId: identity.botId,
          type: "routine.fired",
          seq: 300 + index,
          runId: run.id,
          payload: { routineId: config.routineId, scheduledFor: "2026-01-01T00:00:00Z" },
        },
      });
    }
    await system.attempt.create({ data: { runId: attempted.id, fence: 4, status: "running" } });
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.id).toBe(older.id);
    expect(reused?.cancelledEvents).toHaveLength(1);
    expect(await system.run.findUnique({ where: { id: duplicate.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await system.task.findUnique({ where: { id: duplicate.taskId } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await system.event.count({ where: { runId: duplicate.id, type: "run.cancelled" } }),
    ).toBe(1);
    expect(await system.run.findUnique({ where: { id: attempted.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("preserves prior change-triggered work after its routine becomes a timer", async () => {
    const { config, create } = await fixture();
    const watched = await system.$transaction((tx) => create(tx, null));
    // Change-triggered tasks always include this nonempty note, independently
    // of whether the checker had a detail string to report.
    await system.task.update({
      where: { id: watched.taskId },
      data: {
        prompt: `${config.prompt}\n\nThis run was started because something you watch changed (fixture).\nWhat changed since the last check:\n(no detail)`,
      },
    });
    await system.event.create({
      data: {
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
        type: "routine.fired",
        seq: 400,
        runId: watched.id,
        payload: { routineId: config.routineId, scheduledFor: "2026-01-01T00:00:00Z" },
      },
    });
    expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toBeNull();
    expect(await system.run.findUnique({ where: { id: watched.id } })).toMatchObject({
      status: "queued",
    });
  });
  it("drains a full bounded legacy batch inside the default transaction deadline", async () => {
    const { routine, config } = await fixture();
    const rows = Array.from({ length: 100 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
    await system.task.createMany({
      data: rows.map(({ taskId }) => ({
        ...identity,
        id: taskId,
        status: "queued",
        prompt: "fixture",
      })),
    });
    await system.run.createMany({
      data: rows.map(({ id, taskId }) => ({
        ...identity,
        id,
        taskId,
        routineId: routine.id,
        trigger: "routine",
        status: "queued",
      })),
    });
    await system.event.createMany({
      data: rows.map(({ id }, index) => ({
        spaceId: identity.spaceId,
        threadId: identity.threadId,
        botId: identity.botId,
        type: "routine.fired",
        seq: 500 + index,
        runId: id,
        payload: { routineId: routine.id, scheduledFor: "2026-01-01T00:00:00Z" },
      })),
    });
    // Deliberately do not increase Prisma's default interactive transaction limit.
    const reused = await system.$transaction((tx) => findPendingRoutineTick(tx, config));
    expect(reused?.cancelledEvents).toHaveLength(99);
    expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(1);
    expect(await system.run.count({ where: { routineId: routine.id, status: "cancelled" } })).toBe(
      99,
    );
  });
  it.each(["reserved nonce", "legacy firing event"])(
    "finds a pending timer behind over a page of manual rows using %s",
    async (origin) => {
      const { routine, config, create } = await fixture();
      const rows = Array.from({ length: 120 }, () => ({ id: randomUUID(), taskId: randomUUID() }));
      await system.task.createMany({
        data: rows.map(({ taskId }) => ({
          ...identity,
          id: taskId,
          status: "queued",
          prompt: "fixture",
        })),
      });
      await system.run.createMany({
        data: rows.map(({ id, taskId }) => ({
          ...identity,
          id,
          taskId,
          routineId: routine.id,
          trigger: "routine",
          status: "queued",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        })),
      });
      const pending = await system.$transaction((tx) =>
        create(tx, origin === "reserved nonce" ? routineTimerNonce(routine.id, "tick") : null),
      );
      if (origin === "legacy firing event") {
        await system.event.create({
          data: {
            spaceId: identity.spaceId,
            threadId: identity.threadId,
            botId: identity.botId,
            type: "routine.fired",
            seq: 900,
            runId: pending.id,
            payload: { routineId: routine.id, scheduledFor: "2026-01-01T00:00:00Z" },
          },
        });
      }
      for (let tick = 0; tick < 3; tick++) {
        expect(await system.$transaction((tx) => findPendingRoutineTick(tx, config))).toMatchObject(
          { id: pending.id },
        );
      }
      expect(await system.run.count({ where: { routineId: routine.id, status: "queued" } })).toBe(
        121,
      );
      expect(
        await system.run.count({ where: { routineId: routine.id, status: "cancelled" } }),
      ).toBe(0);
    },
  );
});
