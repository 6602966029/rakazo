-- Additive: both releases read and write rewardKind and declinedAt while they overlap; a later
-- migration drops them, referrals.createdAt and billing_card_fingerprints.
ALTER TABLE "referrals" ADD COLUMN "cardFingerprint" TEXT;
ALTER TABLE "referrals" ADD COLUMN "outcome" TEXT;

CREATE UNIQUE INDEX "referrals_cardFingerprint_key" ON "referrals"("cardFingerprint");

UPDATE "referrals"
SET "outcome" = COALESCE("rewardKind", CASE WHEN "declinedAt" IS NOT NULL THEN 'declined' END);

-- A card that already earned a reward cannot earn another.
UPDATE "referrals" r
SET "cardFingerprint" = (
  SELECT f."fingerprint" FROM "billing_card_fingerprints" f
  WHERE f."organizationId" = r."organizationId"
  ORDER BY f."createdAt"
  LIMIT 1
)
WHERE r."rewardKind" IS NOT NULL;
