import type { SettingsScope } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { settingsTarget } from "./space-settings.js";

type Scope = { userId: string; spaceId: string };
type ConfirmationsClient = Pick<
  PrismaClient,
  | "spaceSettingOverride"
  | "actionApprovalRule"
  | "userActionApprovalRule"
  | "actionAutoReviewPreference"
  | "userActionAutoReviewPreference"
>;

export type ApprovalRuleInput = { effect: string; matchKind: string; matchValue: string };
export type AutoReviewPreference = { enabled: boolean; skipApprovals: boolean };

/**
 * Approval rules and auto review are confirmations: the account's copy, or the Space's
 * override. Every call reads or writes the copy that applies unless it names one.
 */
function confirmationsTarget(prisma: ConfirmationsClient, scope: Scope, requested?: SettingsScope) {
  return settingsTarget(prisma, scope, "confirmations", requested);
}

export async function listApprovalRules(
  prisma: ConfirmationsClient,
  scope: Scope,
  requested?: SettingsScope,
) {
  const orderBy = { createdAt: "asc" } as const;
  return (await confirmationsTarget(prisma, scope, requested)) === "account"
    ? prisma.userActionApprovalRule.findMany({ where: { userId: scope.userId }, orderBy })
    : prisma.actionApprovalRule.findMany({
        where: { spaceId: scope.spaceId, createdByUserId: scope.userId },
        orderBy,
      });
}

/** Saves a rule once; saving it again returns the existing one. */
export async function saveApprovalRule(
  prisma: ConfirmationsClient,
  scope: Scope,
  rule: ApprovalRuleInput,
  requested?: SettingsScope,
) {
  if ((await confirmationsTarget(prisma, scope, requested)) === "account") {
    const row = { userId: scope.userId, ...rule };
    return prisma.userActionApprovalRule.upsert({
      where: { userId_effect_matchKind_matchValue: row },
      create: row,
      update: {},
    });
  }
  const row = { spaceId: scope.spaceId, createdByUserId: scope.userId, ...rule };
  return prisma.actionApprovalRule.upsert({
    where: { spaceId_createdByUserId_effect_matchKind_matchValue: row },
    create: row,
    update: {},
  });
}

export async function removeApprovalRule(
  prisma: ConfirmationsClient,
  scope: Scope,
  id: string,
  requested?: SettingsScope,
) {
  if ((await confirmationsTarget(prisma, scope, requested)) === "account") {
    await prisma.userActionApprovalRule.deleteMany({ where: { id, userId: scope.userId } });
  } else {
    await prisma.actionApprovalRule.deleteMany({
      where: { id, spaceId: scope.spaceId, createdByUserId: scope.userId },
    });
  }
}

/** The saved auto review choice, or null when the member never chose. */
export async function findAutoReviewPreference(
  prisma: ConfirmationsClient,
  scope: Scope,
  requested?: SettingsScope,
): Promise<AutoReviewPreference | null> {
  const select = { enabled: true, skipApprovals: true } as const;
  return (await confirmationsTarget(prisma, scope, requested)) === "account"
    ? prisma.userActionAutoReviewPreference.findUnique({
        where: { userId: scope.userId },
        select,
      })
    : prisma.actionAutoReviewPreference.findUnique({
        where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
        select,
      });
}

/** Updates the given fields; a first save fills the rest from `defaults`. */
export async function saveAutoReviewPreference(
  prisma: ConfirmationsClient,
  scope: Scope,
  update: Partial<AutoReviewPreference>,
  defaults: AutoReviewPreference,
  requested?: SettingsScope,
) {
  const create = {
    enabled: update.enabled ?? defaults.enabled,
    skipApprovals: update.skipApprovals ?? defaults.skipApprovals,
  };
  if ((await confirmationsTarget(prisma, scope, requested)) === "account") {
    await prisma.userActionAutoReviewPreference.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...create },
      update,
    });
  } else {
    await prisma.actionAutoReviewPreference.upsert({
      where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
      create: { spaceId: scope.spaceId, userId: scope.userId, ...create },
      update,
    });
  }
}
