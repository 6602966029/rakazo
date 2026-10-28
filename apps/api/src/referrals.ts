import { randomInt } from "node:crypto";
import type { BillingProvider } from "@rakazo/adapter-kit";
import type { BillingStatus } from "@rakazo/contracts";
import { BYOK_MONTHLY_PRICE_CENTS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { billingAccountForOrganization, Prisma, reconcileCreditPurchase } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 8;

/**
 * An organization that has subscribed earns a free month of the own-key plan for each invited
 * organization that subscribes with a card no other organization has used.
 */
export function createReferrals(deps: {
  prisma: PrismaClient;
  provider: BillingProvider;
  webOrigin: string;
}) {
  const { prisma, provider } = deps;
  const rewardCents = BYOK_MONTHLY_PRICE_CENTS;
  const enabled = rewardCents !== null && Boolean(provider.grantBalanceCredit);

  async function codeFor(organizationId: string): Promise<string> {
    for (;;) {
      const existing = await prisma.referralCode.findUnique({ where: { organizationId } });
      if (existing) return existing.code;
      try {
        const created = await prisma.referralCode.create({
          data: { organizationId, code: newCode() },
        });
        return created.code;
      } catch (error) {
        // A concurrent create for this organization, or a code collision; the next pass settles it.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"))
          throw error;
      }
    }
  }

  async function decline(organizationId: string) {
    await prisma.referral.updateMany({
      where: { organizationId, rewardedAt: null, declinedAt: null },
      data: { declinedAt: new Date() },
    });
  }

  return {
    async status(
      organizationId: string,
      account: { subscribedAt: Date | null } | null,
      isOwner: boolean,
    ): Promise<BillingStatus["referral"]> {
      if (!enabled || !isOwner || !account?.subscribedAt) return null;
      const [code, rewards] = await Promise.all([
        codeFor(organizationId),
        prisma.referral.count({
          where: { referrerOrganizationId: organizationId, rewardedAt: { not: null } },
        }),
      ]);
      return { url: `${deps.webOrigin}/sign-up?ref=${code}`, rewards };
    },

    /** Only before the organization's first subscription, so nobody claims after paying. */
    async claim(organizationId: string, code: string) {
      if (!enabled) return;
      const [referrer, account] = await Promise.all([
        prisma.referralCode.findUnique({ where: { code } }),
        billingAccountForOrganization(prisma, organizationId),
      ]);
      if (!referrer || referrer.organizationId === organizationId || account?.subscribedAt) return;
      await prisma.referral.createMany({
        data: [{ organizationId, referrerOrganizationId: referrer.organizationId }],
        skipDuplicates: true,
      });
    },

    /**
     * Called whenever the invited organization's subscription grants access, after its card is
     * stored. The grant is idempotent and recorded only once it succeeds, so a failure or restart
     * at any point is retried by the next sync, which it never blocks.
     */
    async settle(organizationId: string, cardFingerprint: string | undefined) {
      if (!enabled || !cardFingerprint) return;
      try {
        const referral = await prisma.referral.findUnique({
          where: { organizationId },
          select: {
            rewardedAt: true,
            declinedAt: true,
            referrerOrganizationId: true,
            referrer: { select: { billing: true, modelCredits: { select: { mode: true } } } },
          },
        });
        if (!referral || referral.rewardedAt || referral.declinedAt) return;
        const referrerBilling = referral.referrer.billing;
        // Each organization stores its card before this check, so of two using one card, the
        // later one always sees the earlier.
        const cardUsedElsewhere =
          (await prisma.billingCardFingerprint.count({
            where: { fingerprint: cardFingerprint, organizationId: { not: organizationId } },
          })) > 0;
        if (
          !referrerBilling ||
          cardUsedElsewhere ||
          // The referrer may not have synced since fingerprints were stored.
          (await provider.getCustomerSubscription(referrerBilling.customerId))?.cardFingerprint ===
            cardFingerprint
        ) {
          await decline(organizationId);
          return;
        }
        const referenceId = `referral_${organizationId}`;
        // Monthly credit invoices turn what is paid into credits, so a balance would buy nothing.
        if (referral.referrer.modelCredits?.mode === "credits")
          await reconcileCreditPurchase(prisma, referral.referrerOrganizationId, {
            id: referenceId,
            amountCents: rewardCents!,
          });
        else
          await provider.grantBalanceCredit!(referrerBilling.customerId, rewardCents!, referenceId);
        await prisma.referral.updateMany({
          where: { organizationId, rewardedAt: null, declinedAt: null },
          data: { rewardedAt: new Date() },
        });
      } catch (error) {
        getLogger().error("referral reward failed", error);
      }
    },
  };
}

function newCode() {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
}
