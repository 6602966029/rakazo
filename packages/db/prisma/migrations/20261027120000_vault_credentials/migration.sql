-- A member's credentials move from one bot to a vault: the account's, which every Space uses,
-- or a Space's own once it customizes "credentials". Additive: bot_secrets stays for the
-- previous release and is dropped in a later deploy.

CREATE TABLE "vault_credentials" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT,
  "name" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "auth" JSONB NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vault_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vault_credentials_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vault_credentials_spaceId_fkey" FOREIGN KEY ("spaceId")
    REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "vault_credentials_spaceId_idx" ON "vault_credentials"("spaceId");
CREATE UNIQUE INDEX "vault_credentials_userId_spaceId_name_key"
  ON "vault_credentials"("userId", "spaceId", "name")
  NULLS NOT DISTINCT;

ALTER TABLE "vault_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY vault_credentials_tenant ON "vault_credentials"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), '')
    AND ("spaceId" IS NULL OR "spaceId" = NULLIF(current_setting('app.space_id', true), '')));
CREATE POLICY vault_credentials_system ON "vault_credentials"
  USING (current_setting('app.rls_bypass', true) = 'on');

-- Saved credentials never become readable somewhere they were not: a member with one Space
-- gets them in the account vault (no other Space exists to see them); a member with several
-- keeps each Space's in that Space's own vault. Rows keep their ids, which their stored values
-- are bound to. A name two bots both used keeps its newest value; the others get a suffix.
WITH placed AS (
  SELECT b.*,
    CASE WHEN (SELECT count(*) FROM "space_members" m WHERE m."userId" = b."userId") = 1
      THEN NULL ELSE b."spaceId" END AS "vaultSpaceId"
  FROM "bot_secrets" b
), ranked AS (
  SELECT placed.*, row_number() OVER (
    PARTITION BY "userId", "vaultSpaceId", "name" ORDER BY "updatedAt" DESC, "id"
  ) AS rank
  FROM placed
)
INSERT INTO "vault_credentials"
  ("id", "userId", "spaceId", "name", "origin", "auth", "ciphertext", "createdAt", "updatedAt")
SELECT "id", "userId", "vaultSpaceId",
  CASE WHEN rank = 1 THEN "name" ELSE "name" || '-' || rank END,
  "origin", "auth", "ciphertext", "createdAt", "updatedAt"
FROM ranked
ORDER BY rank
ON CONFLICT DO NOTHING;

INSERT INTO "space_setting_overrides" ("spaceId", "userId", "setting")
SELECT DISTINCT v."spaceId", v."userId", 'credentials'
FROM "vault_credentials" v
JOIN "space_members" m ON m."spaceId" = v."spaceId" AND m."userId" = v."userId"
WHERE v."spaceId" IS NOT NULL
ON CONFLICT DO NOTHING;
