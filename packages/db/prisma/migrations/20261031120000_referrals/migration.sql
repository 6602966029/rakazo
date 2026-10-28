-- Additive: the previous release never reads these tables or the new column.
ALTER TABLE "billing_accounts" ADD COLUMN "cardFingerprint" TEXT;

CREATE INDEX "billing_accounts_cardFingerprint_idx" ON "billing_accounts"("cardFingerprint");

CREATE TABLE "referral_codes" (
    "code" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("code")
);

CREATE UNIQUE INDEX "referral_codes_organizationId_key" ON "referral_codes"("organizationId");

ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "referrals" (
    "organizationId" TEXT NOT NULL,
    "referrerOrganizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("organizationId")
);

CREATE INDEX "referrals_referrerOrganizationId_idx" ON "referrals"("referrerOrganizationId");

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerOrganizationId_fkey" FOREIGN KEY ("referrerOrganizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
