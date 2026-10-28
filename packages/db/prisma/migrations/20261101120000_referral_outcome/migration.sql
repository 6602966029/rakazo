-- Additive: the previous release keeps writing rewardKind and declinedAt until it stops; a later
-- migration drops them, referrals.createdAt and billing_card_fingerprints.
ALTER TABLE "referrals" ADD COLUMN "cardFingerprint" TEXT;
ALTER TABLE "referrals" ADD COLUMN "outcome" TEXT;

CREATE UNIQUE INDEX "referrals_cardFingerprint_key" ON "referrals"("cardFingerprint");

UPDATE "referrals"
SET "outcome" = COALESCE("rewardKind", CASE WHEN "declinedAt" IS NOT NULL THEN 'declined' END);
