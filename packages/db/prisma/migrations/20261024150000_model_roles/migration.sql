CREATE TABLE "space_model_role_choices" (
  "spaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  CONSTRAINT "space_model_role_choices_pkey" PRIMARY KEY ("spaceId", "userId", "role", "position"),
  CONSTRAINT "space_model_role_choices_spaceId_userId_fkey" FOREIGN KEY ("spaceId", "userId")
    REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "space_model_role_choices_spaceId_userId_role_provider_modelId_key"
  ON "space_model_role_choices"("spaceId", "userId", "role", "provider", "modelId");
ALTER TABLE "space_model_role_choices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_model_role_choices_tenant ON "space_model_role_choices"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY space_model_role_choices_system ON "space_model_role_choices"
  USING (current_setting('app.rls_bypass', true) = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON "space_model_role_choices" TO rakazo_app;
