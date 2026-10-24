import type { ModelRole, ModelRoleSettings } from "@rakazo/contracts";
import { ModelRoleSettingsSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { listSpaceBackupModels, writeSpaceBackupModels } from "./model-backups.js";
import {
  findDefaultModelCredential,
  findModelCredential,
  selectSpaceModelPreference,
} from "./model-credentials.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { userId: string; spaceId: string };

/** The main-role bridge keeps one source of truth for older clients and rolling releases. */
export async function getModelRole(
  prisma: Pick<PrismaClient, "spaceModelPreference" | "spaceBackupModel" | "spaceModelRole">,
  scope: Scope,
  role: ModelRole,
): Promise<ModelRoleSettings> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  if (role === "main") {
    const [credential, backups] = await Promise.all([
      findDefaultModelCredential(prisma, scope),
      listSpaceBackupModels(prisma, scope),
    ]);
    return {
      primary: credential?.defaultModel
        ? { provider: credential.provider, modelId: credential.defaultModel }
        : null,
      backups,
    };
  }
  const row = await prisma.spaceModelRole.findUnique({
    where: { spaceId_userId_role: { ...scoped, role } },
  });
  return ModelRoleSettingsSchema.parse({
    primary: row?.provider && row.modelId ? { provider: row.provider, modelId: row.modelId } : null,
    backups: row?.backups ?? [],
  });
}

export async function updateModelRole(
  prisma: PrismaClient,
  scope: Scope,
  role: ModelRole,
  patch: Partial<ModelRoleSettings>,
): Promise<ModelRoleSettings> {
  const scoped = { userId: scope.userId, spaceId: scope.spaceId };
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const members = await tx.$queryRaw<Array<{ locked: number }>>`
      SELECT 1 AS locked FROM "space_members" WHERE "spaceId" = ${scope.spaceId} AND "userId" = ${scope.userId} FOR UPDATE
    `;
        if (members.length !== 1) throw new Error("Space membership not found");
        if (role === "main") {
          if (patch.primary) {
            const credential = await findModelCredential(
              tx,
              scope,
              patch.primary.provider,
              patch.primary.modelId,
            );
            if (!credential) throw new Error("Connect that model provider first");
            await selectSpaceModelPreference(tx, scope, credential.id, patch.primary.modelId);
          } else if (patch.primary === null) {
            await tx.spaceModelPreference.updateMany({ where: scoped, data: { isDefault: false } });
          }
          if (patch.backups) await writeSpaceBackupModels(tx, scope, patch.backups);
        } else {
          const primary =
            patch.primary === undefined
              ? {}
              : {
                  provider: patch.primary?.provider ?? null,
                  modelId: patch.primary?.modelId ?? null,
                };
          await tx.spaceModelRole.upsert({
            where: { spaceId_userId_role: { ...scoped, role } },
            create: { ...scoped, role, ...primary, backups: patch.backups ?? [] },
            update: { ...primary, ...(patch.backups ? { backups: patch.backups } : {}) },
          });
        }
        return getModelRole(tx, scope, role);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}
