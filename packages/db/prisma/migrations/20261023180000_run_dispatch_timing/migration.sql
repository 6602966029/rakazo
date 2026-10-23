-- Additive: older API and worker releases continue using the existing run fields.
ALTER TABLE "runs" ADD COLUMN "wakeAt" TIMESTAMP(3),
                   ADD COLUMN "firstResponseAt" TIMESTAMP(3);
CREATE INDEX "runs_status_wakeAt_idx" ON "runs"("status", "wakeAt");

-- Preserve pending legacy retry backoff when moving dispatch out of Graphile.
-- Fresh installations create Graphile's schema after application migrations.
DO $$ BEGIN
  IF to_regclass('graphile_worker._private_jobs') IS NOT NULL THEN
    UPDATE runs AS r SET "wakeAt" = scheduled.due
    FROM (
      SELECT coalesce(j.payload->>'runId', j.payload->'payload'->>'runId') AS run_id,
             max(j.run_at) AT TIME ZONE 'UTC' AS due
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      WHERE t.identifier IN ('run.continue', 'run.interactive')
        AND j.attempts < j.max_attempts
      GROUP BY coalesce(j.payload->>'runId', j.payload->'payload'->>'runId')
    ) scheduled
    WHERE r.id = scheduled.run_id AND r.status = 'queued';
  END IF;
END $$;
