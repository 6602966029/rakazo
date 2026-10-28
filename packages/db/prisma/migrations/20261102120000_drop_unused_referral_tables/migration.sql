-- The previous release no longer reads these. bots.title, bots.selfUpdateInstructions,
-- referrals.rewardKind and referrals.declinedAt are dropped by a later migration.
DROP TABLE "billing_card_fingerprints";

ALTER TABLE "referrals" DROP COLUMN "createdAt";
