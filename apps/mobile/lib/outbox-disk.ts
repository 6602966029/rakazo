import { Directory, File, Paths } from "expo-file-system";
import type { SendAttempt, UnsentDisk } from "./thread-feedback";
import { OUTBOX_MAX_ENTRIES } from "./thread-feedback";

// App-private cache storage is excluded from device backups and may be evicted by the OS.
function root() {
  return new Directory(Paths.cache, "outbox");
}
function file() {
  return new File(root(), "sends-v3.json");
}
export const outboxDisk: UnsentDisk = {
  save(attempts) {
    try {
      root().create({ intermediates: true, idempotent: true });
      const target = file();
      target.create({ overwrite: true });
      target.write(
        JSON.stringify(
          attempts.slice(0, OUTBOX_MAX_ENTRIES).map((attempt) => ({
            ...attempt,
            state: attempt.state === "pending" ? "queued" : attempt.state,
            artifactIds: [...attempt.artifactIds],
            payload: {
              ...attempt.payload,
              attachments: attempt.payload.attachments.map(
                ({ previewUri: _preview, ...attachment }) => attachment,
              ),
            },
          })),
        ),
      );
    } catch {
      /* Optional persistence; the in-memory outbox remains usable. */
    }
  },
  load(session, scope) {
    try {
      const target = file();
      if (!target.exists) return [];
      const entries: unknown = JSON.parse(target.textSync());
      if (!Array.isArray(entries)) return [];
      return entries.slice(0, OUTBOX_MAX_ENTRIES).flatMap((entry): SendAttempt[] => {
        if (
          entry?.apiBase !== scope.apiBase ||
          entry.userId !== scope.userId ||
          entry.cacheSession !== scope.cacheSession ||
          !(entry.spaceId === null || typeof entry.spaceId === "string") ||
          typeof entry.clientNonce !== "string" ||
          !entry.clientNonce ||
          !["queued", "failed", "refused"].includes(entry.state) ||
          typeof entry.payload?.originThreadKey !== "string" ||
          typeof entry.payload.displayText !== "string" ||
          !entry.payload.plan ||
          !Array.isArray(entry.payload.plan.routineIds) ||
          !Array.isArray(entry.payload.plan.mentionPayload) ||
          !Array.isArray(entry.payload.attachments) ||
          !entry.payload.attachments.every(
            (a: { contentBase64?: unknown }) => typeof a?.contentBase64 === "string",
          ) ||
          !Array.isArray(entry.artifactIds) ||
          !entry.artifactIds.every(
            (pair: unknown) =>
              Array.isArray(pair) &&
              pair.length === 2 &&
              pair.every((id) => typeof id === "string"),
          )
        )
          return [];
        return [{ ...entry, session, artifactIds: new Map(entry.artifactIds) }];
      });
    } catch {
      return [];
    }
  },
  clear() {
    try {
      const directory = root();
      if (directory.exists) directory.delete();
    } catch {
      /* Session namespaces prevent reuse even if deletion fails. */
    }
  },
};
