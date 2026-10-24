CREATE TABLE "space_model_roles" (
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "provider" TEXT,
  "modelId" TEXT,
  "backups" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "space_model_roles_pkey" PRIMARY KEY ("spaceId", "userId", "role"),
  CONSTRAINT "space_model_roles_primary_pair" CHECK (("provider" IS NULL) = ("modelId" IS NULL)),
  CONSTRAINT "space_model_roles_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId")
    REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "space_model_roles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_model_roles_tenant ON "space_model_roles"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY space_model_roles_system ON "space_model_roles"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "space_model_roles" TO rakazo_app;
