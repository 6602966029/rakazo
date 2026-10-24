import { RPCHandler } from "@orpc/server/fetch";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  userId: "user-one",
  spaceId: "space-one",
  email: "one@rakazo.test",
  isDeploymentOwner: true,
};

function setup(
  options: {
    actor?: Actor;
    existing?: Array<Record<string, unknown>>;
    /** An openai-compatible connection with this stored list and space default. */
    compatible?: { enabledModelIds: string[]; defaultModel: string };
  } = {},
) {
  const rows = [...(options.existing ?? [])];
  const spaceBackupModel = {
    findMany: vi.fn(async ({ where }: { where: { userId: string; spaceId: string } }) =>
      rows
        .filter((row) => row.userId === where.userId && row.spaceId === where.spaceId)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map(({ provider, modelId }) => ({ provider, modelId })),
    ),
    deleteMany: vi.fn(async ({ where }: { where: { userId: string; spaceId: string } }) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]?.userId === where.userId && rows[index]?.spaceId === where.spaceId) {
          rows.splice(index, 1);
        }
      }
      return { count: 1 };
    }),
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      rows.push(...data);
      return { count: data.length };
    }),
  };
  const credential = {
    id: "credential-one",
    userId: owner.userId,
    provider: options.compatible ? "openai-compatible" : "openrouter",
    label: "fixture",
    secretId: "secret-one",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const roleRows = new Map<string, Record<string, unknown>>();
  const spaceModelRole = {
    findUnique: vi.fn(
      async ({ where }: { where: { spaceId_userId_role: Record<string, string> } }) =>
        roleRows.get(JSON.stringify(where.spaceId_userId_role)) ?? null,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { spaceId_userId_role: Record<string, string> };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const key = JSON.stringify(where.spaceId_userId_role);
        const row = roleRows.has(key) ? { ...roleRows.get(key), ...update } : create;
        roleRows.set(key, row);
        return row;
      },
    ),
  };
  const tx = {
    spaceModelRole,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    spaceBackupModel,
  };
  const prisma = {
    spaceBackupModel,
    spaceModelRole,
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; provider?: string } }) =>
        where.userId === owner.userId && (!where.provider || where.provider === credential.provider)
          ? [credential]
          : [],
      ),
    },
    spaceModelPreference: {
      findMany: vi.fn().mockResolvedValue(
        options.compatible
          ? [
              {
                id: "preference-one",
                modelId: options.compatible.defaultModel,
                thinkingLevel: null,
                isDefault: true,
                updatedAt: new Date(0),
                credential,
              },
            ]
          : [],
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    secret: {
      findMany: vi.fn().mockResolvedValue([{ id: "secret-one", ciphertext: "fixture-ciphertext" }]),
      findFirst: vi.fn().mockResolvedValue({ id: "secret-one", ciphertext: "fixture-ciphertext" }),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  Object.assign(tx, {
    spaceModelPreference: prisma.spaceModelPreference,
    userModelCredential: prisma.userModelCredential,
  });
  const deps = {
    prisma,
    secrets: {
      load: vi.fn(() =>
        options.compatible
          ? serializeModelSecret({
              kind: "openai_compatible",
              baseUrl: "http://127.0.0.1:11434/v1",
              enabledModelIds: options.compatible.enabledModelIds,
            })
          : "fake-api-key-for-offline-tests",
      ),
    },
    env: {
      agentRuntime: "pi",
      defaultProvider: "openrouter",
      defaultModel: "unused-test-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture-secret",
      sandboxProvider: "fake",
    },
    dataDir: "C:/scratch/rakazo-model-backups",
  } as unknown as RouterDeps;
  const actor = options.actor ?? owner;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (procedure: string, input: unknown) =>
    handler.handle(
      new Request(`http://127.0.0.1/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
  return { rows, prisma, spaceBackupModel, call };
}

const availableModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder,
)!;

describe("model backup settings API", () => {
  it("rejects a compatible catalog placeholder outside the enabled list", async () => {
    const { call, spaceBackupModel } = setup({
      compatible: { enabledModelIds: ["enabled"], defaultModel: "enabled" },
    });
    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "custom" },
    ]);
    expect(response.status).toBe(400);
    expect(spaceBackupModel.createMany).not.toHaveBeenCalled();
  });

  it("returns an empty list for a new user and reads only that user's active Space", async () => {
    const { call, spaceBackupModel } = setup({
      existing: [
        {
          userId: "user-one",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "first",
          position: 0,
        },
        {
          userId: "user-one",
          spaceId: "space-two",
          provider: "openrouter",
          modelId: "other-space",
          position: 0,
        },
        {
          userId: "user-two",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "other-user",
          position: 0,
        },
      ],
    });

    const { response } = await call("models/backups", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: [{ provider: "openrouter", modelId: "first" }],
    });
    expect(spaceBackupModel.findMany).toHaveBeenCalledWith({
      where: { userId: owner.userId, spaceId: owner.spaceId },
      orderBy: { position: "asc" },
      select: { provider: true, modelId: true },
    });
  });

  it("persists an ordered list for a connected usable model without changing the primary", async () => {
    const { call, prisma, spaceBackupModel, rows } = setup();
    const input = [{ provider: availableModel.provider, modelId: availableModel.id }];

    const { response } = await call("models/setBackups", input);

    expect(response.status).toBe(200);
    expect(rows).toEqual([
      {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: availableModel.provider,
        modelId: availableModel.id,
        position: 0,
      },
    ]);
    expect(spaceBackupModel.createMany).toHaveBeenCalled();
    const preferences = (
      prisma as unknown as {
        spaceModelPreference: {
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      }
    ).spaceModelPreference;
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
  });

  it("rejects disconnected models, duplicate targets, and lists over the configured bound", async () => {
    const disconnected = setup();
    const invalid = await disconnected.call("models/setBackups", [
      { provider: "not-connected", modelId: "unknown-model" },
    ]);
    expect(invalid.response.status).toBeGreaterThanOrEqual(400);
    expect(disconnected.spaceBackupModel.deleteMany).not.toHaveBeenCalled();

    const duplicate = setup();
    const repeated = { provider: availableModel.provider, modelId: availableModel.id };
    const duplicateResponse = await duplicate.call("models/setBackups", [repeated, repeated]);
    expect(duplicateResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.spaceBackupModel.deleteMany).not.toHaveBeenCalled();

    const oversized = setup();
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      provider: availableModel.provider,
      modelId: `${availableModel.id}-${index}`,
    }));
    const oversizedResponse = await oversized.call("models/setBackups", tooMany);
    expect(oversizedResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(oversized.spaceBackupModel.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a known catalog model when its provider is disconnected without replacing saved backups", async () => {
    const disconnectedModel = listPiCatalog().find(
      (entry) => entry.provider === "anthropic" && !entry.placeholder,
    )!;
    const existing = {
      userId: owner.userId,
      spaceId: owner.spaceId,
      provider: availableModel.provider,
      modelId: availableModel.id,
      position: 0,
    };
    const { call, spaceBackupModel, rows } = setup({ existing: [existing] });

    const { response } = await call("models/setBackups", [
      { provider: disconnectedModel.provider, modelId: disconnectedModel.id },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Connect that model provider first" },
    });
    expect(spaceBackupModel.deleteMany).not.toHaveBeenCalled();
    expect(spaceBackupModel.createMany).not.toHaveBeenCalled();
    expect(rows).toEqual([existing]);
  });

  it("accepts a backup on a second enabled openai-compatible model", async () => {
    const { call, rows } = setup({
      compatible: { enabledModelIds: ["local-a", "local-b"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-b" },
    ]);

    expect(response.status).toBe(200);
    expect(rows).toEqual([
      expect.objectContaining({ provider: "openai-compatible", modelId: "local-b", position: 0 }),
    ]);
  });

  it("rejects a backup on an openai-compatible model outside the enabled list", async () => {
    const { call, spaceBackupModel } = setup({
      compatible: { enabledModelIds: ["local-a"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-z" },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Unknown model for that provider" },
    });
    expect(spaceBackupModel.deleteMany).not.toHaveBeenCalled();
  });

  it("isolates writes between users and Spaces", async () => {
    const actor: Actor = {
      ...owner,
      userId: "user-two",
      spaceId: "space-two",
      email: "two@rakazo.test",
    };
    const { rows, call, spaceBackupModel } = setup({
      actor,
      existing: [
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          provider: "openrouter",
          modelId: "keep",
          position: 0,
        },
      ],
    });

    await call("models/setBackups", []);

    expect(rows).toEqual([
      {
        userId: owner.userId,
        spaceId: owner.spaceId,
        provider: "openrouter",
        modelId: "keep",
        position: 0,
      },
    ]);
    expect(spaceBackupModel.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, spaceId: actor.spaceId },
    });
  });
});

describe("role-based model settings API", () => {
  it("stores approval choices independently of main backups using the existing connection", async () => {
    const { call, rows, prisma } = setup();
    const primary = { provider: "openrouter", modelId: "typesafe/jev-1.14" };
    const { response } = await call("models/setRole", {
      role: "approval",
      primary,
      backups: [{ provider: availableModel.provider, modelId: availableModel.id }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.primary).toEqual(primary);
    expect(prisma.spaceModelRole.findUnique).toHaveBeenCalledWith({
      where: {
        spaceId_userId_role: { userId: owner.userId, spaceId: owner.spaceId, role: "approval" },
      },
    });
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toEqual(body.json);
    expect(rows).toEqual([]);
  });
  it("filters decision models out of main choices and rejects saving them for main", async () => {
    const { call } = setup();
    const main = await call("models/forRole", { role: "main" });
    expect(
      (await main.response.json()).json.some(
        (entry: { protocol?: string }) => entry.protocol === "decisions",
      ),
    ).toBe(false);
    const approval = await call("models/forRole", { role: "approval" });
    expect((await approval.response.json()).json).toContainEqual(
      expect.objectContaining({ id: "typesafe/jev-1.14", protocol: "decisions" }),
    );
    const invalid = await call("models/setRole", {
      role: "main",
      primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
    });
    expect(invalid.response.status).toBe(400);
  });
  it("rejects stale sessions and unavailable connections without replacing settings", async () => {
    const { call } = setup();
    const stale = await call("models/setRole", {
      role: "approval",
      expectedUserId: "different-user",
      primary: null,
    });
    expect(stale.response.status).toBe(403);
    const missing = await call("models/setRole", {
      role: "approval",
      primary: { provider: "not-connected", modelId: "model" },
    });
    expect(missing.response.status).toBe(400);
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toEqual({ primary: null, backups: [] });
  });
  it("retains backwards-compatible main backup storage", async () => {
    const { call } = setup();
    const backups = [{ provider: availableModel.provider, modelId: availableModel.id }];
    expect((await call("models/setRole", { role: "main", backups })).response.status).toBe(200);
    const legacy = await call("models/backups", {});
    expect((await legacy.response.json()).json).toEqual(backups);
  });
});
