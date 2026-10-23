import { createHash, randomUUID } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, prepareAccountDeletion } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

const webOrigin = "https://app.example.test";

describePostgres("shared spaces: invites and membership (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const syncSeats = vi.fn(async (_organizationId: string) => undefined);
  const users: string[] = [];
  const organizations: string[] = [];

  type Person = { id: string; organizationId: string; spaceId: string; actor: Actor };

  async function person(name: string): Promise<Person> {
    const id = `shared-${name}-${randomUUID()}`;
    users.push(id);
    organizations.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Personal", slug: id, createdAt },
    });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true, createdByUserId: id },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${id}`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    return {
      id,
      organizationId: id,
      spaceId: id,
      actor: { userId: id, spaceId: id, email: `${id}@example.test`, isDeploymentOwner: false },
    };
  }

  async function sharedSpace(owner: Person, name: string): Promise<string> {
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: owner.organizationId, name, createdByUserId: owner.id },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId: owner.organizationId,
        userId: owner.id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return spaceId;
  }

  async function call(actor: Actor, path: string, input: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: Record<string, unknown> };
    return { status: response!.status, json: body.json };
  }

  async function invite(owner: Person, spaceId: string): Promise<string> {
    const created = await call(owner.actor, "spaces/invites/create", { spaceId });
    expect(created.status).toBe(200);
    return new URL(created.json.url as string).pathname.split("/").at(-1)!;
  }

  function inSpace(actor: Actor, spaceId: string): Actor {
    return { ...actor, spaceId };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    const deps = {
      prisma,
      billing: { syncSeats },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin,
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-shared-spaces-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps));
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: organizations } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("joins a shared space through a single-use link", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const stranger = await person("stranger");
    const home = await sharedSpace(owner, "Home");

    const created = await call(owner.actor, "spaces/invites/create", { spaceId: home });
    expect(created.status).toBe(200);
    const url = new URL(created.json.url as string);
    expect(url.origin).toBe(webOrigin);
    expect(url.pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = url.pathname.split("/").at(-1)!;
    const stored = await system.spaceInvite.findFirstOrThrow({ where: { spaceId: home } });
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.tokenHash).not.toContain(token);
    const expiresIn = new Date(created.json.expiresAt as string).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(6.9 * 24 * 3600_000);
    expect(expiresIn).toBeLessThanOrEqual(7 * 24 * 3600_000);

    const preview = await call(invitee.actor, "spaces/invites/preview", { token });
    expect(preview.json).toEqual({
      spaceId: home,
      spaceName: "Home",
      inviterName: "owner",
      alreadyMember: false,
    });

    const accepted = await call(invitee.actor, "spaces/invites/accept", { token });
    expect(accepted).toEqual({ status: 200, json: { spaceId: home } });
    expect(syncSeats).toHaveBeenCalledWith(owner.organizationId);
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: home, userId: invitee.id } },
      }),
    ).resolves.toMatchObject({ role: "member", organizationId: owner.organizationId });
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: invitee.id },
        },
      }),
    ).resolves.toMatchObject({ role: "member" });
    // Joining one Space never opens the owner's personal default Space.
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: owner.spaceId, userId: invitee.id } },
      }),
    ).resolves.toBeNull();

    // Reopening the used link is harmless for the person who used it.
    await expect(call(invitee.actor, "spaces/invites/accept", { token })).resolves.toEqual({
      status: 200,
      json: { spaceId: home },
    });
    await expect(call(invitee.actor, "spaces/invites/preview", { token })).resolves.toMatchObject({
      json: { alreadyMember: true },
    });
    // Anyone else gets the same answer as for an unknown link.
    expect((await call(stranger.actor, "spaces/invites/accept", { token })).status).toBe(404);
    expect((await call(stranger.actor, "spaces/invites/preview", { token })).status).toBe(404);
    expect(
      (await call(stranger.actor, "spaces/invites/preview", { token: "not-a-real-token" })).status,
    ).toBe(404);
    await expect(
      system.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: home, userId: stranger.id } },
      }),
    ).resolves.toBeNull();

    const events = await system.securityEvent.findMany({
      where: { spaceId: home },
      select: { type: true, metadata: true },
    });
    expect(events.map((event) => event.type).sort()).toEqual([
      "space.invite.created",
      "space.member.joined",
    ]);
    expect(JSON.stringify(events)).not.toContain(token);

    const list = await call(inSpace(invitee.actor, home), "spaces/members/list", {
      spaceId: home,
    });
    expect(list.json).toMatchObject({
      canManage: false,
      members: [
        { userId: owner.id, role: "owner", name: "owner" },
        { userId: invitee.id, role: "member", name: "invitee" },
      ],
    });
    expect((await call(stranger.actor, "spaces/members/list", { spaceId: home })).status).toBe(404);
  });

  it("rejects expired links", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    const token = await invite(owner, home);
    await system.spaceInvite.updateMany({
      where: { spaceId: home },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call(invitee.actor, "spaces/invites/preview", { token })).status).toBe(404);
    expect((await call(invitee.actor, "spaces/invites/accept", { token })).status).toBe(404);
  });

  it("keeps inviting, removing and leaving to the right people", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const third = await person("third");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    await call(third.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const member = inSpace(invitee.actor, home);
    expect((await call(member, "spaces/invites/create", { spaceId: home })).status).toBe(403);
    expect(
      (await call(member, "spaces/members/remove", { spaceId: home, userId: third.id })).status,
    ).toBe(403);
    expect(
      (await call(member, "spaces/members/remove", { spaceId: home, userId: owner.id })).status,
    ).toBe(403);
    // Not a member at all: the Space does not exist for them.
    expect(
      (await call(third.actor, "spaces/invites/create", { spaceId: owner.spaceId })).status,
    ).toBe(404);

    const ownerInHome = inSpace(owner.actor, home);
    expect((await call(ownerInHome, "spaces/members/leave", { spaceId: home })).status).toBe(400);
    expect(
      (await call(ownerInHome, "spaces/members/remove", { spaceId: home, userId: owner.id }))
        .status,
    ).toBe(400);
    expect((await call(ownerInHome, "spaces/members/list", { spaceId: home })).json).toMatchObject({
      canManage: true,
    });

    const left = await call(member, "spaces/members/leave", { spaceId: home });
    expect(left).toEqual({ status: 200, json: { ok: true, activeSpaceId: invitee.spaceId } });
    await expect(
      system.member.findUnique({
        where: {
          organizationId_userId: { organizationId: owner.organizationId, userId: invitee.id },
        },
      }),
    ).resolves.toBeNull();
    // Leaving a Space other than the open one keeps the open one.
    const fromElsewhere = await call(third.actor, "spaces/members/leave", { spaceId: home });
    expect(fromElsewhere.json).toEqual({ ok: true, activeSpaceId: third.spaceId });
  });

  it("hands a removed member's bots and routines to the owner and deletes what was theirs", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const ownerSection = await system.botSection.create({
      data: { spaceId: home, userId: owner.id, name: "Family", position: 0 },
    });
    const mergedSection = await system.botSection.create({
      data: { spaceId: home, userId: invitee.id, name: "Family" },
    });
    const movedSection = await system.botSection.create({
      data: { spaceId: home, userId: invitee.id, name: "Trips" },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        name: "Planner",
        color: "test",
        sectionId: mergedSection.id,
      },
    });
    const group = await system.chatGroup.create({
      data: { spaceId: home, userId: invitee.id, name: "Weekend", sectionId: movedSection.id },
    });
    const routine = await system.routine.create({
      data: {
        spaceId: home,
        botId: bot.id,
        userId: invitee.id,
        name: "Groceries",
        prompt: "List groceries",
        crons: ["0 9 * * 1"],
      },
    });
    const secret = await system.secret.create({
      data: { userId: invitee.id, spaceId: home, kind: "connection", ciphertext: "fake" },
    });
    await system.connection.create({
      data: {
        spaceId: home,
        userId: invitee.id,
        provider: "gmail",
        displayName: "Gmail",
        status: "connected",
        secretId: secret.id,
      },
    });
    await system.botSecret.create({
      data: {
        id: randomUUID(),
        userId: invitee.id,
        spaceId: home,
        botId: bot.id,
        name: "API_KEY",
        origin: "https://api.example.test",
        auth: {},
        ciphertext: "fake",
      },
    });
    const server = await system.mcpServer.create({
      data: { spaceId: home, userId: invitee.id, slug: "notes", name: "Notes", transport: "http" },
    });
    await system.botMcpServer.create({
      data: { spaceId: home, botId: bot.id, serverId: server.id, userId: invitee.id },
    });
    await system.actionApprovalRule.create({
      data: {
        spaceId: home,
        createdByUserId: invitee.id,
        effect: "allow",
        matchKind: "tool",
        matchValue: "send_email",
      },
    });
    await system.notificationPreference.create({ data: { spaceId: home, userId: invitee.id } });
    // Their own Space is not touched.
    const ownConnection = await system.connection.create({
      data: {
        spaceId: invitee.spaceId,
        userId: invitee.id,
        provider: "gmail",
        displayName: "Gmail",
        status: "connected",
      },
    });

    const removed = await call(inSpace(owner.actor, home), "spaces/members/remove", {
      spaceId: home,
      userId: invitee.id,
    });
    expect(removed).toEqual({ status: 200, json: { ok: true } });

    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: owner.id,
      sectionId: ownerSection.id,
    });
    await expect(
      system.chatGroup.findUniqueOrThrow({ where: { id: group.id } }),
    ).resolves.toMatchObject({ userId: owner.id, sectionId: movedSection.id });
    await expect(
      system.routine.findUniqueOrThrow({ where: { id: routine.id } }),
    ).resolves.toMatchObject({ userId: owner.id, active: false, nextRunAt: null });
    await expect(
      system.botSection.findUnique({ where: { id: mergedSection.id } }),
    ).resolves.toBeNull();
    await expect(
      system.botSection.findUniqueOrThrow({ where: { id: movedSection.id } }),
    ).resolves.toMatchObject({ userId: owner.id, position: 1 });

    const leftover = { spaceId: home, userId: invitee.id };
    await expect(system.connection.count({ where: leftover })).resolves.toBe(0);
    await expect(system.secret.count({ where: leftover })).resolves.toBe(0);
    await expect(system.botSecret.count({ where: leftover })).resolves.toBe(0);
    await expect(system.mcpServer.count({ where: leftover })).resolves.toBe(0);
    await expect(system.botMcpServer.count({ where: leftover })).resolves.toBe(0);
    await expect(system.notificationPreference.count({ where: leftover })).resolves.toBe(0);
    await expect(
      system.actionApprovalRule.count({ where: { spaceId: home, createdByUserId: invitee.id } }),
    ).resolves.toBe(0);
    await expect(
      system.spaceMember.count({ where: { spaceId: home, userId: invitee.id } }),
    ).resolves.toBe(0);
    await expect(
      system.connection.findUnique({ where: { id: ownConnection.id } }),
    ).resolves.not.toBeNull();
    await expect(
      system.securityEvent.count({ where: { spaceId: home, type: "space.member.removed" } }),
    ).resolves.toBe(1);
  });

  it("lists shared spaces across organizations and creates new spaces in the member's own", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });

    const listed = await call(invitee.actor, "spaces/list", {});
    expect(listed.status).toBe(200);
    const spaces = listed.json.spaces as Array<Record<string, unknown>>;
    expect(spaces.find((space) => space.id === invitee.spaceId)).toMatchObject({
      shared: false,
      isDefault: true,
      canRename: true,
    });
    expect(spaces.find((space) => space.id === home)).toMatchObject({
      name: "Home",
      shared: true,
      isDefault: false,
      canRename: false,
      canDelete: false,
    });
    const ownerList = await call(owner.actor, "spaces/list", {});
    expect(
      (ownerList.json.spaces as Array<Record<string, unknown>>).find((space) => space.id === home),
    ).toMatchObject({ shared: true, canRename: true, canDelete: true });

    // Creating while the shared Space is open still lands in the member's own organization.
    const created = await call(inSpace(invitee.actor, home), "spaces/create", { name: "Work" });
    expect(created.status).toBe(200);
    await expect(
      system.space.findUniqueOrThrow({ where: { id: created.json.id as string } }),
    ).resolves.toMatchObject({ organizationId: invitee.organizationId });
  });

  it("deletes an owner's shared spaces with the account and hands a leaving member's bots over", async () => {
    const owner = await person("owner");
    const invitee = await person("invitee");
    const home = await sharedSpace(owner, "Home");
    await call(invitee.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const bot = await system.bot.create({
      data: { spaceId: home, userId: invitee.id, name: "Planner", color: "test" },
    });

    // The invitee deletes their account first: their bot stays in the shared Space.
    await expect(prepareAccountDeletion(prisma, invitee.id)).resolves.toEqual({
      ownedOrganizationIds: [invitee.organizationId],
    });
    await expect(system.bot.findUniqueOrThrow({ where: { id: bot.id } })).resolves.toMatchObject({
      userId: owner.id,
    });

    const other = await person("other");
    await call(other.actor, "spaces/invites/accept", { token: await invite(owner, home) });
    const { ownedOrganizationIds } = await prepareAccountDeletion(prisma, owner.id);
    expect(ownedOrganizationIds).toEqual([owner.organizationId]);
    await system.organization.deleteMany({ where: { id: { in: ownedOrganizationIds } } });
    await expect(system.space.findUnique({ where: { id: home } })).resolves.toBeNull();
    await expect(
      system.member.count({ where: { organizationId: owner.organizationId } }),
    ).resolves.toBe(0);
    // The other member keeps their own Space.
    await expect(system.space.findUnique({ where: { id: other.spaceId } })).resolves.not.toBeNull();
  });
});
