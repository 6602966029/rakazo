import { Directory, File, Paths } from "expo-file-system";
import type { PickedAttachment } from "./pick-attachments";
import type { SendAttempt, SendPayload, UnsentDisk } from "./thread-feedback";

// Caches, not documents: the documents folder goes into device and cloud backups, and unsent
// messages must stay on the phone. The OS may purge caches under storage pressure.
const ROOT = "outbox";
const LIST = "outbox.json";
/** The next list, written in full before it replaces the current one. */
const NEXT = "outbox.next.json";
const VERSION = 1;
/** Enough for a long offline stretch of messages without letting the queue grow unbounded. */
export const OUTBOX_MAX_ENTRIES = 50;
/** Five messages at the attachment limit (4 × 10 MiB each). */
export const OUTBOX_MAX_BYTES = 200 * 1024 * 1024;

type StoredAttachment = Omit<PickedAttachment, "contentBase64"> & { file: string };
type StoredEntry = {
  clientNonce: string;
  apiBase: string;
  spaceId: string | null;
  state: "queued" | "refused";
  createdAt: number;
  error?: string;
  payload: Omit<SendPayload, "attachments"> & { attachments: StoredAttachment[] };
  artifactIds: Array<[string, string]>;
};

/** Bytes each stored entry's attachments take on disk, by client nonce. */
const storedBytes = new Map<string, number>();

function root() {
  return new Directory(Paths.cache, ROOT);
}

function entryDirectory(clientNonce: string) {
  return new Directory(root(), encodeURIComponent(clientNonce));
}

function attachmentFileName(index: number, name: string) {
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? "";
  return `${index}${extension}`;
}

function attachmentBytes(attachment: PickedAttachment) {
  return Math.floor((attachment.contentBase64.length * 3) / 4);
}

function fileExists(uri: string) {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

function deleteQuietly(target: File | Directory) {
  try {
    if (target.exists) target.delete();
  } catch {
    // A leftover file is removed with the rest of the outbox on the next launch or sign-out.
  }
}

/** The saved list, or null when it can't be read or isn't one this version wrote. */
function readList(file: File): StoredEntry[] | null {
  try {
    const parsed = JSON.parse(file.textSync()) as { version?: unknown; entries?: unknown } | null;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.entries)) return null;
    return parsed.entries.filter(isStoredEntry);
  } catch {
    return null;
  }
}

function isStoredEntry(value: unknown): value is StoredEntry {
  const entry = value as Partial<StoredEntry> | null;
  return (
    typeof entry?.clientNonce === "string" &&
    typeof entry.apiBase === "string" &&
    (entry.spaceId === null || typeof entry.spaceId === "string") &&
    (entry.state === "queued" || entry.state === "refused") &&
    typeof entry.createdAt === "number" &&
    Array.isArray(entry.artifactIds) &&
    typeof entry.payload?.originThreadKey === "string" &&
    Array.isArray(entry.payload.attachments) &&
    entry.payload.attachments.every(
      (attachment) =>
        typeof attachment?.id === "string" &&
        typeof attachment.name === "string" &&
        typeof attachment.mimeType === "string" &&
        typeof attachment.file === "string",
    )
  );
}

export const outboxDisk: UnsentDisk = {
  admit(attempt) {
    if (storedBytes.has(attempt.clientNonce)) return true;
    const bytes = attempt.payload.attachments.reduce(
      (total, attachment) => total + attachmentBytes(attachment),
      0,
    );
    let usedBytes = 0;
    for (const used of storedBytes.values()) usedBytes += used;
    if (storedBytes.size >= OUTBOX_MAX_ENTRIES || usedBytes + bytes > OUTBOX_MAX_BYTES) {
      return false;
    }
    const directory = entryDirectory(attempt.clientNonce);
    try {
      directory.create({ intermediates: true, idempotent: true });
      attempt.payload.attachments.forEach((attachment, index) => {
        const file = new File(directory, attachmentFileName(index, attachment.name));
        file.create({ overwrite: true });
        file.write(attachment.contentBase64, { encoding: "base64" });
      });
    } catch {
      deleteQuietly(directory);
      return false;
    }
    storedBytes.set(attempt.clientNonce, bytes);
    return true;
  },

  save(attempts) {
    const entries: StoredEntry[] = attempts
      .filter((attempt) => storedBytes.has(attempt.clientNonce))
      .map((attempt) => ({
        clientNonce: attempt.clientNonce,
        apiBase: attempt.apiBase,
        spaceId: attempt.spaceId,
        // Anything but a refusal goes out again after a restart; the nonce makes resending safe.
        state: attempt.state === "refused" ? "refused" : "queued",
        createdAt: attempt.createdAt,
        error: attempt.error,
        payload: {
          ...attempt.payload,
          attachments: attempt.payload.attachments.map(
            ({ contentBase64: _content, ...attachment }, index) => ({
              ...attachment,
              file: attachmentFileName(index, attachment.name),
            }),
          ),
        },
        artifactIds: [...attempt.artifactIds],
      }));
    try {
      const directory = root();
      const list = new File(directory, LIST);
      const next = new File(directory, NEXT);
      if (!entries.length) {
        deleteQuietly(list);
        deleteQuietly(next);
        return;
      }
      directory.create({ intermediates: true, idempotent: true });
      next.create({ overwrite: true });
      next.write(JSON.stringify({ version: VERSION, entries }));
      // Replace the list only once the new one is complete; load falls back to it if cut short.
      next.moveSync(list, { overwrite: true });
    } catch {
      // The in-memory queue still works; only surviving a restart is lost.
    }
  },

  forget(attempt) {
    if (!storedBytes.delete(attempt.clientNonce)) return;
    deleteQuietly(entryDirectory(attempt.clientNonce));
  },

  load(session, live) {
    for (const nonce of [...storedBytes.keys()]) if (!live.has(nonce)) storedBytes.delete(nonce);
    const directory = root();
    const list = new File(directory, LIST);
    const next = new File(directory, NEXT);
    // A complete next list is newer than the current one (the swap was cut short).
    const fromNext = next.exists ? readList(next) : null;
    const fromList = list.exists ? readList(list) : null;
    // Any list that exists but can't be read keeps every folder: they may still be someone's messages.
    const unreadable = (next.exists && !fromNext) || (list.exists && !fromList);
    const entries = fromNext ?? fromList ?? [];
    const kept = new Set(
      [...entries.map((entry) => entry.clientNonce), ...live].map((nonce) =>
        encodeURIComponent(nonce),
      ),
    );
    try {
      if (directory.exists && !unreadable) {
        for (const item of directory.list()) {
          if (item instanceof Directory && !kept.has(item.name)) deleteQuietly(item);
        }
      }
    } catch {
      // Orphans are retried on the next launch.
    }
    return entries.map((entry): SendAttempt => {
      const folder = entryDirectory(entry.clientNonce);
      let bytes = 0;
      const attachments = entry.payload.attachments.map(({ file, ...attachment }) => {
        const stored = new File(folder, file);
        if (stored.exists) bytes += stored.size;
        // The picker's own copy outlives the message, so the composer can still show it after Cancel send.
        const previewUri =
          attachment.previewUri && fileExists(attachment.previewUri)
            ? attachment.previewUri
            : attachment.mimeType.startsWith("image/")
              ? stored.uri
              : undefined;
        return { ...attachment, contentBase64: "", previewUri };
      });
      storedBytes.set(entry.clientNonce, bytes);
      return {
        payload: { ...entry.payload, attachments },
        clientNonce: entry.clientNonce,
        artifactIds: new Map(entry.artifactIds),
        state: entry.state,
        heldOffline: true,
        createdAt: entry.createdAt,
        session,
        apiBase: entry.apiBase,
        spaceId: entry.spaceId,
        error: entry.error,
      };
    });
  },

  async hydrate(attempt, options) {
    const folder = entryDirectory(attempt.clientNonce);
    await Promise.all(
      attempt.payload.attachments.map(async (attachment, index) => {
        // Sending skips files already uploaded; the composer needs all of them back.
        const skip = !options?.forComposer && attempt.artifactIds.has(attachment.id);
        const file = new File(folder, attachmentFileName(index, attachment.name));
        if (!attachment.contentBase64 && !skip && file.exists) {
          attachment.contentBase64 = await file.base64();
        }
        // A preview of the saved copy would point at a folder that is deleted next.
        if (
          options?.forComposer &&
          attachment.contentBase64 &&
          attachment.previewUri === file.uri
        ) {
          attachment.previewUri = `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
        }
      }),
    );
  },

  clear() {
    storedBytes.clear();
    deleteQuietly(root());
  },
};
