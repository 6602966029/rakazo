import { platformModelAllowed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** An unrestricted deployment avoids identity reads on the model-resolution path. */
export async function canUsePlatformModel(
  prisma: PrismaClient,
  allowlist: string[] | undefined,
  userId: string,
): Promise<boolean> {
  if (!allowlist?.length) return true;
  const [user, settings] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    }),
  ]);
  return platformModelAllowed({
    allowlist,
    email: user?.email ?? "",
    isOwner: settings?.ownerUserId === userId,
  });
}
