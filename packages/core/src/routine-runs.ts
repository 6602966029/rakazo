import type { RoutineHistory, RoutineRun } from "@rakazo/contracts";

/**
 * Compact human duration, e.g. "850ms", "4.2s", "1m 05s".
 * Returns null when there is no usable duration (missing, non-finite or negative),
 * so the caller can omit the segment entirely.
 */
export function formatCompactDuration(durationMs: number | null | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) {
    const seconds = Math.round(durationMs / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** When a run is shown as having happened: when it started, else when it was queued. */
export function routineRunAt(run: RoutineRun): string {
  return run.startedAt ?? run.createdAt;
}

/** How long a finished run took, or null while it has not both started and finished. */
export function routineRunDuration(run: RoutineRun): string | null {
  return run.startedAt && run.completedAt
    ? formatCompactDuration(Date.parse(run.completedAt) - Date.parse(run.startedAt))
    : null;
}

/** History pages, newest first, as one list; a run that shifted onto a later page shows once. */
export function mergeRoutineRunPages(pages: readonly RoutineHistory[]): RoutineRun[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.runs.filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    }),
  );
}
