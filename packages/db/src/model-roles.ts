import type { ModelRole, ModelRoleSettings } from "@rakazo/contracts";
import { backupChoiceKey, ModelRoleSettingsSchema } from "@rakazo/contracts";
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

/** Main reads the default preference and backup list that older releases also use. */
export async function getModelRole(
  prisma: Pick<PrismaClient, "spaceModelPreference" | "spaceBackupModel" | "spaceModelRoleChoice">,
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
  const rows = await prisma.spaceModelRoleChoice.findMany({
    where: { ...scoped, role },
    orderBy: { position: "asc" },
    select: { position: true, provider: true, modelId: true },
  });
  const choice = ({ provider, modelId }: (typeof rows)[number]) => ({ provider, modelId });
  const primary = rows.find((row) => row.position === 0);
  return ModelRoleSettingsSchema.parse({
    primary: primary ? choice(primary) : null,
    backups: rows.filter((row) => row.position > 0).map(choice),
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
          const current = patch.primary ? await getModelRole(tx, scope, role) : null;
          // Re-saving the same primary must keep the effort stored on its preference.
          if (
            patch.primary &&
            !(
              current?.primary &&
              backupChoiceKey(current.primary) === backupChoiceKey(patch.primary)
            )
          ) {
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
          const current = await getModelRole(tx, scope, role);
          const primary = patch.primary === undefined ? current.primary : patch.primary;
          // The primary already runs first, so a matching fallback would never be tried.
          const backups = (patch.backups ?? current.backups).filter(
            (backup) => !primary || backupChoiceKey(backup) !== backupChoiceKey(primary),
          );
          await tx.spaceModelRoleChoice.deleteMany({ where: { ...scoped, role } });
          await tx.spaceModelRoleChoice.createMany({
            data: [
              ...(primary ? [{ ...primary, position: 0 }] : []),
              ...backups.map((backup, index) => ({ ...backup, position: index + 1 })),
            ].map((row) => ({ ...scoped, role, ...row })),
          });
        }
        return getModelRole(tx, scope, role);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}
