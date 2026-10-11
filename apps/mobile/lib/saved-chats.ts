import { Directory, File, Paths } from "expo-file-system";
import type {
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSnapshot,
  MobileSpace,
  MobileSpaceNavigation,
} from "./api";
import { currentApiBase, selectedSpaceId } from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import type { IntegrationsCacheScope } from "./integrations-cache";
import { integrationsCacheScope, isIntegrationsScopeCurrent } from "./integrations-cache";
import {
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  saveVerifiedIntegrationsScope,
} from "./session";

/** The verified server, user and Space a saved copy belongs to (see integrations-cache). */
export type SavedChatsScope = IntegrationsCacheScope & {
  /** Opaque, bound to the session token and rotated on every session change (artifact cache). */
  namespace: string;
};
/** `bot:<id>` or `group:<id>`. */
export type SavedChatTarget = string;
/** Only what the inbox renders: no bot instructions, no external conversations, no email. */
export type SavedInbox = {
  bots: MobileBot[];
  groups: MobileGroup[];
  botSections: MobileBotSection[];
  spaces: MobileSpace[];
  me: Pick<MobileMe, "userId" | "spaceId" | "name">;
};

const BOT_FIELDS = [
  "id",
  "spaceId",
  "name",
  "title",
  "color",
  "notifyOnFinish",
  "threadId",
  "pinned",
  "status",
  "sectionId",
  "parentBotId",
  "archivedAt",
  "unread",
  "preview",
  "updatedAt",
  "computerMode",
  "modelProvider",
  "modelId",
  "thinkingLevel",
  "autoSpeak",
] as const satisfies ReadonlyArray<keyof MobileBot>;
const GROUP_FIELDS = [
  "id",
  "spaceId",
  "name",
  "pinned",
  "sectionId",
  "archivedAt",
  "members",
  "preview",
  "unread",
  "updatedAt",
] as const satisfies ReadonlyArray<keyof MobileGroup>;

function pick<T extends object>(row: T, fields: ReadonlyArray<keyof T>): T {
  return Object.fromEntries(
    fields.filter((field) => field in row).map((field) => [field, row[field]]),
  ) as T;
}

export const SAVED_CHAT_MESSAGES = 100;
export const SAVED_CHATS = 40;
/** Coalesces a chat's stream updates into one write once it has been quiet this long. */
export const SAVED_CHAT_WRITE_DELAY_MS = 600;
const ROOT = "saved-chats-v1";
export const SAVED_CHAT_MAX_BYTES = 1024 * 1024;
export const SAVED_CHATS_MAX_BYTES = 20 * 1024 * 1024;
const SAVED_INBOX_ROWS = 200;

export function savedChatTarget(target: { botId?: string; groupId?: string }): SavedChatTarget {
  return target.groupId ? `group:${target.groupId}` : `bot:${target.botId}`;
}

function userRoot(scope: SavedChatsScope): Directory {
  return new Directory(
    Paths.cache,
    ROOT,
    scope.namespace,
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
}

function spaceFile(scope: SavedChatsScope, name: string): File {
  const root = new Directory(userRoot(scope), `space-${encodeURIComponent(scope.spaceId)}`);
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return new File(root, `${encodeURIComponent(name)}.json`);
}

function scopeKey(scope: SavedChatsScope, name: string): string {
  return JSON.stringify([scope.namespace, scope.apiBase, scope.userId, scope.spaceId, name]);
}

function readJson(file: File, key: string): Record<string, unknown> | null {
  if (!file.exists || file.size > SAVED_CHAT_MAX_BYTES) return null;
  const data = JSON.parse(file.textSync());
  return data && typeof data === "object" && data.key === key ? data : null;
}

function isRows(value: unknown): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every((row) => row && typeof row === "object" && typeof row.id === "string")
  );
}

export function readSavedInbox(scope: SavedChatsScope): SavedInbox | null {
  if (!isIntegrationsScopeCurrent(scope)) return null;
  try {
    const data = readJson(spaceFile(scope, "inbox"), scopeKey(scope, "inbox"));
    const inbox = data?.inbox as SavedInbox | undefined;
    const me = inbox?.me;
    if (
      !inbox ||
      !isRows(inbox.bots) ||
      !isRows(inbox.groups) ||
      !isRows(inbox.botSections) ||
      !isRows(inbox.spaces) ||
      me?.userId !== scope.userId ||
      typeof me.spaceId !== "string" ||
      typeof me.name !== "string"
    )
      return null;
    return inbox;
  } catch {
    // OS eviction, corrupt files, and unavailable storage are all cold misses.
    return null;
  }
}

export function writeSavedInbox(
  scope: SavedChatsScope,
  navigation: MobileSpaceNavigation,
  me: MobileMe,
): void {
  try {
    const inbox: SavedInbox = {
      bots: navigation.current.bots
        .slice(0, SAVED_INBOX_ROWS)
        .map((bot) => pick<MobileBot>(bot, BOT_FIELDS)),
      groups: navigation.current.groups
        .slice(0, SAVED_INBOX_ROWS)
        .map((group) => pick<MobileGroup>(group, GROUP_FIELDS)),
      botSections: navigation.current.botSections.slice(0, SAVED_INBOX_ROWS),
      spaces: navigation.spaces.slice(0, 40).map((space) => ({
        ...space,
        bots: space.bots.slice(0, SAVED_INBOX_ROWS),
        groups: space.groups.slice(0, SAVED_INBOX_ROWS),
        externalConversations: [],
      })),
      // The profile initials and the Space the rows belong to.
      me: { userId: me.userId, spaceId: me.spaceId, name: me.name },
    };
    if (!isIntegrationsScopeCurrent(scope) || me.userId !== scope.userId) return;
    writeSavedFile(scope, "inbox", { key: scopeKey(scope, "inbox"), inbox });
  } catch {
    // Saved chats are optional; storage failures must not block the inbox.
  }
}

/**
 * The user verified for this session's token on this server, with the Space selected now; no
 * network needed. Opening a chat from another Space selects that Space first, so its chat is saved
 * and read under its own Space.
 */
export async function savedChatsScope(): Promise<SavedChatsScope | null> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const selectionId = selectedSpaceId();
  const verified = await loadVerifiedIntegrationsScope();
  const spaceId = selectionId ?? (verified?.selectionId === null ? verified.spaceId : null);
  if (!verified || verified.apiBase !== apiBase || !spaceId) return null;
  return withSessionNamespace({
    apiBase,
    userId: verified.userId,
    spaceId,
    sessionGeneration: generation,
    selectionId,
  });
}

/**
 * Adds this session's namespace, so files a failed wipe left behind are never read by a later
 * session, even of the same account.
 */
async function withSessionNamespace(
  scope: IntegrationsCacheScope,
): Promise<SavedChatsScope | null> {
  try {
    const namespace = await artifactCacheSession(await loadSessionToken());
    return isIntegrationsScopeCurrent(scope) ? { ...scope, namespace } : null;
  } catch {
    return null;
  }
}

/**
 * The scope to save a live chat under. Without a verified identity yet (the inbox hasn't loaded
 * since sign-in or a password change), asks the server once, as the chat itself just did.
 */
export async function liveSavedChatsScope(): Promise<SavedChatsScope | null> {
  const saved = await savedChatsScope();
  if (saved) return saved;
  const verified = await integrationsCacheScope().catch(() => null);
  return verified ? withSessionNamespace(verified) : null;
}

/** The inbox saved for this session's verified server, user and Space; no network needed. */
export async function loadSavedInbox(): Promise<SavedInbox | null> {
  const scope = await savedChatsScope();
  if (!scope) return null;
  const inbox = readSavedInbox(scope);
  return inbox && isIntegrationsScopeCurrent(scope) ? inbox : null;
}

/** Saves the inbox only after the load verified its identity in the current session. */
export function saveInbox(
  verifiedLoad: IntegrationsCacheScope,
  navigation: MobileSpaceNavigation,
  me: MobileMe,
): void {
  if (!isIntegrationsScopeCurrent(verifiedLoad) || verifiedLoad.userId !== me.userId) return;
  const { sessionGeneration, ...verified } = verifiedLoad;
  void saveVerifiedIntegrationsScope(sessionGeneration, verified);
  void withSessionNamespace(verifiedLoad).then((scope) => {
    if (scope) writeSavedInbox(scope, navigation, me);
  });
}

/** The saved copy is display-only: no live cursor, no "Load earlier", no stale run state. */
export function savedThreadSnapshot(snapshot: MobileSnapshot): MobileSnapshot {
  const { cursor: _cursor, activeRuns: _activeRuns, computer: _computer, ...rest } = snapshot;
  return {
    ...rest,
    messages: snapshot.messages.slice(-SAVED_CHAT_MESSAGES),
    olderCursor: null,
    run: null,
  };
}

export function readSavedThread(
  scope: SavedChatsScope,
  target: SavedChatTarget,
): MobileSnapshot | null {
  if (!isIntegrationsScopeCurrent(scope)) return null;
  try {
    const data = readJson(spaceFile(scope, target), scopeKey(scope, target));
    const snapshot = data?.snapshot as MobileSnapshot | undefined;
    if (
      !snapshot ||
      savedChatTarget(snapshot) !== target ||
      typeof snapshot.threadId !== "string" ||
      !isRows(snapshot.messages) ||
      !snapshot.messages.every(
        (message) => typeof message.role === "string" && Array.isArray(message.blocks),
      )
    )
      return null;
    return savedThreadSnapshot(snapshot);
  } catch {
    return null;
  }
}

/** Evict oldest files before writing so corrupt metadata cannot bypass count or byte limits. */
function writeSavedFile(
  scope: SavedChatsScope,
  target: SavedChatTarget,
  data: Record<string, unknown>,
): void {
  if (!isIntegrationsScopeCurrent(scope)) return;
  const text = JSON.stringify(data);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > SAVED_CHAT_MAX_BYTES) return;
  const file = spaceFile(scope, target);
  const files: File[] = [];
  const collect = (directory: Directory) => {
    for (const entry of directory.list()) {
      if (entry instanceof File) {
        if (entry.uri !== file.uri) files.push(entry);
      } else collect(entry);
    }
  };
  collect(userRoot(scope));
  let total = bytes + files.reduce((sum, entry) => sum + entry.size, 0);
  files.sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0));
  while (files.length >= SAVED_CHATS || total > SAVED_CHATS_MAX_BYTES) {
    const oldest = files.shift()!;
    const size = oldest.size;
    oldest.delete();
    total -= size;
  }
  file.create({ overwrite: true });
  file.write(text);
}

export function writeSavedThread(
  scope: SavedChatsScope,
  target: SavedChatTarget,
  snapshot: MobileSnapshot,
): void {
  if (!isIntegrationsScopeCurrent(scope) || savedChatTarget(snapshot) !== target) return;
  try {
    writeSavedFile(scope, target, {
      key: scopeKey(scope, target),
      snapshot: savedThreadSnapshot(snapshot),
    });
  } catch {
    // Optional cache: failed writes never block a live thread.
  }
}

/** Trailing debounce for chat writes; `flush` runs a pending write now, e.g. on leaving the chat. */
export function savedChatWriter(delayMs = SAVED_CHAT_WRITE_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: (() => void) | undefined;
  const flush = () => {
    clearTimeout(timer);
    const write = pending;
    pending = undefined;
    write?.();
  };
  return {
    schedule(write: () => void) {
      pending = write;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
  };
}

/** Deletes every saved inbox and chat on this device. */
export function clearSavedChats(): void {
  try {
    const root = new Directory(Paths.cache, ROOT);
    if (root.exists) root.delete();
  } catch {
    // Unreadable leftovers stay unreachable: reads need the next session's verified scope.
  }
}
