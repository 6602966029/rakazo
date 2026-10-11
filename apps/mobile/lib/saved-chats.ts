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
import { currentApiBase, isServerReachable, rpc, selectedSpaceId } from "./api";
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

type IndexEntry = { spaceId: string; target: SavedChatTarget; signature?: string };

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
  return JSON.stringify([scope.apiBase, scope.userId, scope.spaceId, name]);
}

function readJson(file: File, key: string): Record<string, unknown> | null {
  if (!file.exists) return null;
  const data = JSON.parse(file.textSync());
  return data && typeof data === "object" && data.key === key ? data : null;
}

// What this process last wrote per file, so the inbox poll doesn't rewrite unchanged data.
const written = new Map<string, string>();

function writeJson(file: File, data: Record<string, unknown>): void {
  const text = JSON.stringify(data);
  if (written.get(file.uri) === text && file.exists) return;
  file.create({ overwrite: true });
  file.write(text);
  written.set(file.uri, text);
}

function isRows(value: unknown): value is Array<{ id: string }> {
  return (
    Array.isArray(value) &&
    value.every((row) => row && typeof row === "object" && typeof row.id === "string")
  );
}

export function readSavedInbox(scope: SavedChatsScope): SavedInbox | null {
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
      bots: navigation.current.bots.map((bot) => pick<MobileBot>(bot, BOT_FIELDS)),
      groups: navigation.current.groups.map((group) => pick<MobileGroup>(group, GROUP_FIELDS)),
      botSections: navigation.current.botSections,
      spaces: navigation.spaces.map((space) => ({ ...space, externalConversations: [] })),
      // The profile initials and the Space the rows belong to.
      me: { userId: me.userId, spaceId: me.spaceId, name: me.name },
    };
    writeJson(spaceFile(scope, "inbox"), { key: scopeKey(scope, "inbox"), inbox });
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

let refreshingSavedChats = false;
let verifiedScope = "";

/**
 * Saves a successful inbox load and the identity it verified, then brings saved chats whose row
 * changed up to date. Dropped when the session, server or Space changed while it loaded.
 */
export function saveInbox(
  verifiedLoad: IntegrationsCacheScope,
  navigation: MobileSpaceNavigation,
  me: MobileMe,
): void {
  if (!isIntegrationsScopeCurrent(verifiedLoad)) return;
  if (verifiedScope !== JSON.stringify(verifiedLoad)) {
    verifiedScope = JSON.stringify(verifiedLoad);
    const { sessionGeneration, ...verified } = verifiedLoad;
    void saveVerifiedIntegrationsScope(sessionGeneration, verified);
  }
  void withSessionNamespace(verifiedLoad).then((scope) => {
    if (scope) saveInboxIn(scope, navigation, me);
  });
}

function saveInboxIn(scope: SavedChatsScope, navigation: MobileSpaceNavigation, me: MobileMe) {
  writeSavedInbox(scope, navigation, me);
  if (refreshingSavedChats) return;
  refreshingSavedChats = true;
  const rows = [
    ...navigation.current.bots.map((bot) => ({
      target: savedChatTarget({ botId: bot.id }),
      row: bot,
    })),
    ...navigation.current.groups.map((group) => ({
      target: savedChatTarget({ groupId: group.id }),
      row: group,
    })),
  ].map(({ target, row }) => ({ target, signature: savedChatSignature(row) }));
  void refreshSavedChats(
    scope,
    rows,
    (target) => rpc<MobileSnapshot>("threads/get", target),
    () => isIntegrationsScopeCurrent(scope),
  ).finally(() => {
    refreshingSavedChats = false;
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
  try {
    const data = readJson(spaceFile(scope, target), scopeKey(scope, target));
    const snapshot = data?.snapshot as MobileSnapshot | undefined;
    if (
      !snapshot ||
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

function indexFile(scope: SavedChatsScope): File {
  const root = userRoot(scope);
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return new File(root, "index.json");
}

function readIndex(scope: SavedChatsScope): IndexEntry[] {
  try {
    const data = readJson(indexFile(scope), JSON.stringify([scope.apiBase, scope.userId, "index"]));
    return Array.isArray(data?.chats)
      ? data.chats.filter(
          (entry: IndexEntry) =>
            typeof entry?.spaceId === "string" && typeof entry.target === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeIndex(scope: SavedChatsScope, chats: IndexEntry[]): void {
  writeJson(indexFile(scope), {
    key: JSON.stringify([scope.apiBase, scope.userId, "index"]),
    chats,
  });
}

/**
 * Saves the latest messages of a chat. The index lists chats oldest-written first; past
 * SAVED_CHATS the chat written longest ago is forgotten and its file deleted.
 */
// Counts this process's writes per chat, so a background answer can tell the chat was saved while
// it was loading.
const chatWrites = new Map<string, number>();

export function writeSavedThread(
  scope: SavedChatsScope,
  target: SavedChatTarget,
  snapshot: MobileSnapshot,
  signature?: string,
): void {
  const key = scopeKey(scope, target);
  chatWrites.set(key, (chatWrites.get(key) ?? 0) + 1);
  try {
    writeJson(spaceFile(scope, target), { key, snapshot: savedThreadSnapshot(snapshot) });
    const index = readIndex(scope);
    const isThis = (entry: IndexEntry) =>
      entry.spaceId === scope.spaceId && entry.target === target;
    // A write from the open chat keeps the row it was last refreshed for, so an unchanged row
    // isn't downloaded again.
    const kept = signature ?? index.find(isThis)?.signature;
    const chats = index.filter((entry) => !isThis(entry));
    chats.push({ spaceId: scope.spaceId, target, ...(kept ? { signature: kept } : {}) });
    for (const evicted of chats.splice(0, Math.max(0, chats.length - SAVED_CHATS))) {
      const file = spaceFile({ ...scope, spaceId: evicted.spaceId }, evicted.target);
      if (file.exists) file.delete();
    }
    writeIndex(scope, chats);
  } catch {
    // Saved chats are optional; storage failures must not block the thread.
  }
}

/** What a chat's inbox row looked like; a change means the saved copy is behind. */
export function savedChatSignature(row: { updatedAt?: string | null; preview?: string }): string {
  return JSON.stringify([row.updatedAt ?? null, row.preview ?? ""]);
}

/**
 * Re-fetches chats that are already saved and whose inbox row changed since; chats never opened
 * on this device are never fetched. `isCurrent` gates each write against a session change.
 */
export async function refreshSavedChats(
  scope: SavedChatsScope,
  rows: Array<{ target: SavedChatTarget; signature: string }>,
  load: (target: { botId: string } | { groupId: string }) => Promise<MobileSnapshot>,
  isCurrent: () => boolean,
): Promise<void> {
  const saved = new Map(
    readIndex(scope)
      .filter((entry) => entry.spaceId === scope.spaceId)
      .map((entry) => [entry.target, entry.signature]),
  );
  for (const row of rows) {
    if (!saved.has(row.target) || saved.get(row.target) === row.signature) continue;
    const id = row.target.slice(row.target.indexOf(":") + 1);
    const writes = chatWrites.get(scopeKey(scope, row.target));
    let snapshot: MobileSnapshot;
    try {
      snapshot = await load(row.target.startsWith("group:") ? { groupId: id } : { botId: id });
    } catch {
      // One chat failing (deleted, access removed) must not keep the others stale; an outage stops.
      if (!isCurrent() || !isServerReachable()) return;
      continue;
    }
    if (!isCurrent()) return;
    // The open chat saved newer messages while this was loading.
    if (chatWrites.get(scopeKey(scope, row.target)) !== writes) continue;
    writeSavedThread(scope, row.target, snapshot, row.signature);
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
  written.clear();
  chatWrites.clear();
  verifiedScope = "";
  try {
    const root = new Directory(Paths.cache, ROOT);
    if (root.exists) root.delete();
  } catch {
    // Unreadable leftovers stay unreachable: reads need the next session's verified scope.
  }
}
