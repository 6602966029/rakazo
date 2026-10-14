import { randomUUID } from "node:crypto";
import type { BackgroundJob } from "@rakazo/adapter-kit";
import { createDb, createThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { reconcileCallRequests, requestUserCall, settleCallRequest } from "./call-request.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("call isolation and cooldown (PostgreSQL)", () => {
  it("serializes concurrent rings, rejects other owners and spaces, and recovers expiry", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `call-test-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    try {
      await prisma.user.create({
        data: { id: userId, name: "Call tester", email: `${id}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Call tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Call tests" } });
      await prisma.userVoiceCredential.create({
        data: { userId, provider: "scripted", secretId: "fake-secret" },
      });
      const runs = [];
      for (const suffix of ["a", "b"]) {
        const bot = await prisma.bot.create({
          data: {
            spaceId,
            userId,
            name: suffix,
            color: "ink",
            thread: { create: { spaceId, userId } },
          },
          include: { thread: true },
        });
        const threadId = bot.thread!.id;
        const task = await prisma.task.create({
          data: {
            spaceId,
            userId,
            botId: bot.id,
            threadId,
            prompt: "Call test",
            status: "running",
          },
        });
        runs.push(
          await prisma.run.create({
            data: {
              spaceId,
              userId,
              botId: bot.id,
              threadId,
              taskId: task.id,
              status: "running",
              trigger: "user_message",
            },
          }),
        );
      }
      const jobs = {
        enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
        cancel: vi.fn(),
        close: vi.fn(),
      };
      const deps = { prisma, events: createThreadEvents(prisma), jobs, phoneCallsEnabled: true };
      const input = { reason: "Review", opening: "Ready?" };
      for (const field of ["userId", "spaceId", "botId", "threadId"] as const) {
        expect(
          await requestUserCall(deps, { ...runs[0]!, [field]: "other" }, input),
        ).toHaveProperty("error");
      }
      const results = await Promise.all(runs.map((run) => requestUserCall(deps, run, input)));
      expect(results.filter((result) => "ok" in result)).toHaveLength(1);
      expect(await prisma.message.count({ where: { thread: { userId } } })).toBe(1);
      jobs.enqueue.mockClear();
      await reconcileCallRequests(deps);
      expect(jobs.enqueue).toHaveBeenCalledOnce();
      const job = jobs.enqueue.mock.calls[0]?.[0];
      expect(job).toMatchObject({ name: "call.expire" });
      const message = await prisma.message.findFirstOrThrow({ where: { thread: { userId } } });
      const block = (message.blocks as unknown as Array<{ callId: string }>)[0]!;
      const settle = () =>
        settleCallRequest(deps, {
          threadId: message.threadId,
          callId: block.callId,
          from: ["ringing"],
          status: "answered",
        });
      expect((await Promise.all([settle(), settle()])).filter(Boolean)).toHaveLength(1);
    } finally {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
      await pool.end();
    }
  });
});
