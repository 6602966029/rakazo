import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clearRoutineCredentialFailures,
  countRoutineCredentialFailure,
  ROUTINE_CREDENTIAL_FAILURE_LIMIT,
} from "./routine-credential-pause.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
describePostgres("pausing a routine on refused model credentials (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `routine-credentials-${randomUUID()}@rakazo.test`;
  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    const { userId, spaceId, botId, threadId } = await runAsSystem(
      "routine credential fixture",
      () =>
        provisionMessagingIdentity(
          db.prisma,
          { provider: "email", address },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
    );
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
        name: "Morning digest",
        prompt: "fixture",
        crons: ["* * * * *"],
        active: true,
        nextRunAt: new Date(Date.now() + 60_000),
      },
    });
    const cancel = vi.fn(async () => undefined);
    const deps = {
      prisma: system,
      jobs: { enqueue: vi.fn(async () => undefined), cancel, close: vi.fn() },
      events: { notify: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof countRoutineCredentialFailure>[0];
    const run = { ...identity, routineId: routine.id };
    const botMessages = () =>
      system.message.count({ where: { threadId: identity.threadId, role: "bot" } });
    return { routine, deps, run, cancel, botMessages };
  }

  it("pauses once and posts one message when concurrent failures cross the limit", async () => {
    const { routine, deps, run, cancel, botMessages } = await fixture();
    const before = await botMessages();

    await Promise.all(
      Array.from({ length: ROUTINE_CREDENTIAL_FAILURE_LIMIT + 2 }, () =>
        countRoutineCredentialFailure(deps, run, "Your model provider rejected the API key."),
      ),
    );

    expect(await system.routine.findUnique({ where: { id: routine.id } })).toMatchObject({
      active: false,
      nextRunAt: null,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await botMessages()).toBe(before + 1);
  });

  it("forgets earlier refusals after a run gets through", async () => {
    const { routine, deps, run } = await fixture();
    for (let count = 1; count < ROUTINE_CREDENTIAL_FAILURE_LIMIT; count++) {
      await countRoutineCredentialFailure(deps, run, "refused");
    }

    await clearRoutineCredentialFailures(deps, routine.id);
    await countRoutineCredentialFailure(deps, run, "refused");

    expect(await system.routine.findUnique({ where: { id: routine.id } })).toMatchObject({
      active: true,
      credentialFailures: 1,
    });
  });
});
