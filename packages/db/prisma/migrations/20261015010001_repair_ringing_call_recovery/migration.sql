-- Match the existing invalid-index repair pattern: normal deploys keep the valid
-- concurrent build; only a failed build needs the blocking repair inside DO.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_index
    WHERE indexrelid = to_regclass('public.messages_call_recovery_idx')
      AND NOT indisvalid
  ) THEN
    DROP INDEX "messages_call_recovery_idx";
    CREATE INDEX "messages_call_recovery_idx" ON "messages"
      ((blocks #> ARRAY['0', 'status']), "createdAt")
      WHERE role = 'bot' AND "clientNonce" LIKE 'call:%' AND "clientNonce" LIKE '%:request';
  END IF;
END $$;
