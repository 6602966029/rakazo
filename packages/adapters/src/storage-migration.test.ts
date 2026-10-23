import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { ObjectArtifactStore } from "./artifact-store-factory.js";
import { LocalArtifactStore } from "./artifacts.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";
import { PushSessionEndedError } from "./push-token-store.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";
import { migrateLocalArtifacts, migrateLocalPushTokens } from "./storage-migration.js";

const roots: string[] = [];
async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "storage-migration-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const context: AdapterContext = {
  spaceId: "space-1",
  userId: "user-1",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
async function artifactFixture() {
  const local = new LocalArtifactStore(await root());
  const bytes = Buffer.from("private fixture");
  const saved = await local.put({ bytes, name: "file.txt", mimeType: "text/plain" }, context);
  const row = {
    id: "artifact-1",
    storageKey: String(saved.id),
    spaceId: context.spaceId,
    userId: context.userId,
    name: "file.txt",
    mimeType: "text/plain",
  };
  const originalKey = row.storageKey;
  const updateMany = vi.fn(
    async ({ where, data }: { where: { storageKey: string }; data: { storageKey: string } }) => {
      if (row.storageKey !== where.storageKey) return { count: 0 };
      row.storageKey = data.storageKey;
      return { count: 1 };
    },
  );
  const findMany = vi.fn(async ({ where }: { where: { id?: { gt: string } } }) =>
    row.storageKey.startsWith("object:") || (where.id && row.id <= where.id.gt) ? [] : [{ ...row }],
  );
  const prisma = {
    artifact: {
      findMany,
      updateMany,
    },
  } as unknown as PrismaClient;
  const storage = new MemoryObjectStorage();
  const key = { id: "key-1", spaceId: context.spaceId, version: 1, key: randomBytes(32) };
  const target = new ObjectArtifactStore(storage, {
    encryptWrites: true,
    current: async () => key,
    byId: async () => key,
  });
  return { local, target, row, prisma, originalKey, bytes, storage, updateMany };
}

it("verifies an artifact before moving its pointer and keeps the local original", async () => {
  const f = await artifactFixture();
  // Dry runs don't touch bytes or pointers.

  expect(await migrateLocalArtifacts(f.prisma, f.local, f.target, { dryRun: true })).toEqual({
    migrated: 0,
    pending: 1,
  });
  expect(f.storage.objects.size).toBe(0);
  expect(await migrateLocalArtifacts(f.prisma, f.local, f.target)).toEqual({
    migrated: 1,
    pending: 0,
  });
  expect(await f.target.get(f.row.storageKey, context)).toEqual(new Uint8Array(f.bytes));
  expect(await f.local.get(f.originalKey, context)).toEqual(new Uint8Array(f.bytes));
  expect(await migrateLocalArtifacts(f.prisma, f.local, f.target)).toEqual({
    migrated: 0,
    pending: 0,
  });
});

it("does not change the pointer when uploaded bytes fail verification", async () => {
  const f = await artifactFixture();
  vi.spyOn(f.target, "get").mockResolvedValue(Buffer.from("wrong bytes"));
  await expect(migrateLocalArtifacts(f.prisma, f.local, f.target)).rejects.toThrow("verification");
  expect(f.updateMany).not.toHaveBeenCalled();
  expect(f.row.storageKey).toBe(f.originalKey);
  expect(f.storage.objects.size).toBe(0);
});

it("leaves a verified upload intact when a database response could conceal a committed update", async () => {
  const f = await artifactFixture();
  f.updateMany.mockRejectedValue(new Error("connection lost"));
  await expect(migrateLocalArtifacts(f.prisma, f.local, f.target)).rejects.toThrow(
    "connection lost",
  );
  expect(f.storage.objects.size).toBe(1);
  expect(await f.local.get(f.originalKey, context)).toEqual(new Uint8Array(f.bytes));
});

it("imports only session-bound registrations and never resurrects archived files", async () => {
  const dir = await root();
  const tokensDir = path.join(dir, "push-tokens");
  await mkdir(tokensDir);
  await writeFile(path.join(tokensDir, "a.txt"), "ExponentPushToken[a]\nsession-a");
  await writeFile(path.join(tokensDir, "b.txt"), "ExponentPushToken[b]\n");
  await writeFile(path.join(tokensDir, "c.txt"), "ExponentPushToken[c]\nexpired");
  await writeFile(path.join(tokensDir, "d.txt"), "ExponentPushToken[stale]\nsession-old");
  const outside = path.join(dir, "outside");
  await writeFile(outside, "untouched");
  await symlink(outside, path.join(tokensDir, "link.txt"));
  const tokens = new MemoryPushTokenStore();
  await tokens.save("d", "ExponentPushToken[current]", "session-current");
  const save = tokens.save.bind(tokens);
  vi.spyOn(tokens, "save").mockImplementation(async (userId, token, sessionId) => {
    if (sessionId === "expired") throw new PushSessionEndedError();
    await save(userId, token, sessionId);
  });
  expect(await migrateLocalPushTokens(dir, tokens, true)).toEqual({
    migrated: 0,
    skipped: 0,
    pending: 4,
  });
  expect(await tokens.load("a")).toBeUndefined();
  expect(await migrateLocalPushTokens(dir, tokens)).toEqual({
    migrated: 1,
    skipped: 3,
    pending: 0,
  });
  expect((await tokens.load("a"))?.sessionId).toBe("session-a");
  expect((await tokens.load("d"))?.token).toBe("ExponentPushToken[current]");
  expect(await readFile(outside, "utf8")).toBe("untouched");
  expect((await readdir(tokensDir)).filter((name) => name.endsWith(".migrated"))).toHaveLength(4);
  await tokens.remove("a");
  expect(await migrateLocalPushTokens(dir, tokens)).toEqual({
    migrated: 0,
    skipped: 0,
    pending: 0,
  });
  expect(await tokens.load("a")).toBeUndefined();
});
