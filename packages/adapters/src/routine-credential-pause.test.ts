import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  clearRoutineCredentialFailures,
  countRoutineCredentialFailure,
  isModelCredentialRefusal,
  ROUTINE_CREDENTIAL_FAILURE_LIMIT,
} from "./routine-credential-pause.js";

describe("isModelCredentialRefusal", () => {
  it.each([
    [
      "a rejected key",
      'OpenAI API error (401): {"error":{"message":"Incorrect API key provided"}}',
    ],
    [
      "a forbidden key",
      '403: {"error":{"message":"Invalid API key","type":"authentication_error"}}',
    ],
    ["payment required", '402: {"error":{"message":"Insufficient credits. Add more credits."}}'],
    ["an exhausted balance", "Your credit balance is too low to access the API."],
  ])("counts %s", (_label, message) => {
    expect(isModelCredentialRefusal(new ModelAccountError(message))).toBe(true);
  });

  it.each([
    ["a rate limit", new ModelAccountError('429: {"error":{"message":"Rate limit reached"}}')],
    ["a daily limit that resets", new ModelAccountError("Key hit its daily limit.")],
    ["a model the provider no longer serves", new ModelAccountError("404: model not found")],
    ["a timeout", new TransientModelError("Request timed out")],
    ["an output limit", new ModelOutputError("The model hit its output limit")],
    ["a plain server error", new Error("401 Unauthorized")],
  ])("does not count %s", (_label, error) => {
    expect(isModelCredentialRefusal(error)).toBe(false);
  });
});

const RUN = { routineId: "routine-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" };

function fakeRoutine(initial: { active?: boolean; credentialFailures?: number } = {}) {
  const row = {
    id: RUN.routineId,
    name: "Morning digest",
    active: initial.active ?? true,
    nextRunAt: new Date("2026-03-02T09:00:00.000Z") as Date | null,
    credentialFailures: initial.credentialFailures ?? 0,
  };
  type Where = {
    id: string;
    active?: boolean;
    credentialFailures?: { gte?: number; gt?: number };
  };
  const matches = (where: Where) =>
    where.id === row.id &&
    (where.active === undefined || where.active === row.active) &&
    (where.credentialFailures?.gte === undefined ||
      row.credentialFailures >= where.credentialFailures.gte) &&
    (where.credentialFailures?.gt === undefined ||
      row.credentialFailures > where.credentialFailures.gt);
  const routine = {
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<Omit<typeof row, "credentialFailures">> & {
          credentialFailures?: number | { increment: number };
        };
      }) => {
        if (!matches(where)) return { count: 0 };
        const { credentialFailures, ...rest } = data;
        Object.assign(row, rest);
        if (typeof credentialFailures === "number") row.credentialFailures = credentialFailures;
        else if (credentialFailures) row.credentialFailures += credentialFailures.increment;
        return { count: 1 };
      },
    ),
    findUnique: vi.fn(async () => ({ name: row.name })),
  };
  const messages: string[] = [];
  const tx = {
    message: {
      create: vi.fn(async ({ data }: { data: { blocks: Array<{ text: string }> } }) => {
        messages.push(data.blocks[0]?.text ?? "");
        return { id: `message-${messages.length}`, seq: messages.length };
      }),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: messages.length + 1 })) },
  };
  const prisma = {
    routine,
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const jobs = { enqueue: vi.fn(), cancel: vi.fn(async () => undefined), close: vi.fn() };
  const events = { notify: vi.fn(async () => undefined) };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    jobs,
    events: events as unknown as ThreadEvents,
  };
  return { row, deps, jobs, messages, prisma };
}

describe("countRoutineCredentialFailure", () => {
  it("pauses the routine and says why once the limit is reached", async () => {
    const { row, deps, jobs, prisma } = fakeRoutine();
    const reason = "Your OpenAI rejected the API key. Check your connection settings.";

    for (let run = 1; run < ROUTINE_CREDENTIAL_FAILURE_LIMIT; run++) {
      await countRoutineCredentialFailure(deps, RUN, reason);
    }
    expect(row).toMatchObject({ active: true, credentialFailures: 2 });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await countRoutineCredentialFailure(deps, RUN, reason);

    expect(row).toMatchObject({ active: false, nextRunAt: null, credentialFailures: 0 });
    expect(jobs.cancel).toHaveBeenCalledWith("routine:routine-1");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does not count or speak for a routine that is already paused", async () => {
    const { row, deps, jobs, prisma } = fakeRoutine({ active: false, credentialFailures: 2 });

    await countRoutineCredentialFailure(deps, RUN, "refused");

    expect(row.credentialFailures).toBe(2);
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("pauses once when failures that reach the limit land together", async () => {
    const { row, deps, jobs } = fakeRoutine({ credentialFailures: 1 });

    await Promise.all([
      countRoutineCredentialFailure(deps, RUN, "refused"),
      countRoutineCredentialFailure(deps, RUN, "refused"),
      countRoutineCredentialFailure(deps, RUN, "refused"),
    ]);

    expect(row.active).toBe(false);
    expect(jobs.cancel).toHaveBeenCalledTimes(1);
  });

  it("starts over after a run gets through", async () => {
    const { row, deps } = fakeRoutine({ credentialFailures: ROUTINE_CREDENTIAL_FAILURE_LIMIT - 1 });

    await clearRoutineCredentialFailures(deps, RUN.routineId);
    await countRoutineCredentialFailure(deps, RUN, "refused");

    expect(row).toMatchObject({ active: true, credentialFailures: 1 });
  });
});
