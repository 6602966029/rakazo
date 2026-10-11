import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMention, OutboxState, resolveComposerSendPlan } from "@rakazo/core";
import {
  createOutboxDrain,
  mentionChipKey,
  SEND_ECHO_TIMEOUT_MS,
  sendWithOneResend,
  shouldHoldSend,
  stateAfterFailure,
} from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { rpc } from "./api";
import type { PickedAttachment } from "./pick-attachments";

export type ComposerSnapshot = {
  promptText: string;
  /** The typed text without chips; Cancel send puts it back. */
  draft: string;
  mentions: ComposerMention[];
  skill: AgentSkillCatalogEntry | null;
  replyTargetId?: string;
  replyQuote: string | null;
  attachmentIds: string[];
};

/** What the composer held, so Cancel send can put it back as it was. */
export type ComposerDraft = {
  draft: string;
  mentions: ComposerMention[];
  skill: AgentSkillCatalogEntry | null;
};

/** The composer after Cancel send: the message's text, mention chips and skill after anything typed meanwhile. */
export function restoreComposerDraft(
  current: ComposerDraft,
  cancelled: ComposerDraft,
): ComposerDraft {
  const selected = new Set(current.mentions.map(mentionChipKey));
  return {
    draft: current.draft.trim() ? `${current.draft}\n${cancelled.draft}` : cancelled.draft,
    mentions: [
      ...current.mentions,
      ...cancelled.mentions.filter((mention) => !selected.has(mentionChipKey(mention))),
    ],
    skill: current.skill ?? cancelled.skill,
  };
}

export type SendPayload = {
  originThreadKey: string;
  composer: ComposerDraft;
  displayText: string;
  replyPreview: string | null;
  initialBotTarget?: string;
  botTarget?: string;
  groupTarget?: string;
  reroutedToGroup: boolean;
  plan: ReturnType<typeof resolveComposerSendPlan>;
  attachments: PickedAttachment[];
  replyTargetId?: string;
  replyQuote: string | null;
};

export type SendAttempt = {
  payload: SendPayload;
  clientNonce: string;
  artifactIds: Map<string, string>;
  state: OutboxState;
  /** It was held while offline; its bubble says so while it goes out. */
  heldOffline: boolean;
  /** When it was written, in epoch ms. */
  createdAt: number;
  /** When the current attempt started, in epoch ms. */
  attemptedAt?: number;
  /** The server accepted it as this message; the bubble goes when that message appears. */
  acceptedSeq?: number;
  /** The signed-in session the attempt began in; a failure after sign-out is dropped. */
  session: number;
  /** The server and Space it was written in; it is only ever sent there. */
  apiBase: string;
  spaceId: string | null;
  userId: string | null;
  cacheSession: string | null;
  error?: string;
};

/** Uploads get longer than other requests: a 10 MiB attachment can take a while on a slow link. */
const UPLOAD_TIMEOUT_MS = 60_000;

/** Sends the message; resolves with the seq of the message the server stored, if it sent one. */
export async function deliverSend(
  payload: SendPayload,
  attempt: SendAttempt,
  request: typeof rpc,
): Promise<number | undefined> {
  const { plan, groupTarget, botTarget, reroutedToGroup, attachments } = payload;
  if (plan.shouldRunRoutines) {
    await Promise.all(
      plan.routineIds.map((routineId) =>
        request("routines/testRun", {
          routineId,
          clientNonce: `routine-mention:${attempt.clientNonce}:${routineId}`,
        }),
      ),
    );
  }
  if (!plan.shouldSend) return undefined;
  const artifactIds: string[] = [];
  for (const [index, pending] of attachments.entries()) {
    let id = attempt.artifactIds.get(pending.id);
    if (!id) {
      const artifact = await request<{ id: string }>(
        "artifacts/create",
        {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
          clientNonce: `${attempt.clientNonce}:${index}`,
        },
        { timeoutMs: UPLOAD_TIMEOUT_MS },
      );
      id = artifact.id;
      attempt.artifactIds.set(pending.id, id);
    }
    artifactIds.push(id);
  }
  const sent = await request<{ seq: number }>("threads/send", {
    ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
    clientNonce: attempt.clientNonce,
    text: plan.trimmed || undefined,
    mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
    artifactIds: artifactIds.length ? artifactIds : undefined,
    replyToMessageId: reroutedToGroup ? undefined : payload.replyTargetId,
    replyQuote: reroutedToGroup ? undefined : (payload.replyQuote ?? undefined),
  });
  return sent.seq;
}

/** Where unsent messages are kept across app restarts. */
export type UnsentDisk = {
  /** Stores the attachments of an attempt about to be kept; false when it would exceed the outbox limits. */
  admit(attempt: SendAttempt): boolean;
  /** Writes the list of admitted attempts. */
  save(attempts: SendAttempt[]): void;
  forget(attempt: SendAttempt): void;
  /** Restores the saved list; files of `live` nonces (already in memory) are kept as they are. */
  load(
    session: number,
    live: ReadonlySet<string>,
    scope: { apiBase: string; userId: string | null; cacheSession: string | null },
  ): SendAttempt[];
  /**
   * Reads back attachment content that restoring left on disk. For the composer (Cancel send) it
   * reads already uploaded files too and points previews at the bytes, as the folder goes next.
   */
  hydrate(attempt: SendAttempt, options?: { forComposer?: boolean }): Promise<void>;
  clear(): void;
};

export type UnsentSendsConfig = {
  request: typeof rpc;
  serverReachable(): boolean;
  /** The server and Space new messages go to now. */
  scope(): {
    apiBase: string;
    spaceId: string | null;
    userId: string | null;
    cacheSession: string | null;
  };
  disk: UnsentDisk;
  errorText(error: unknown): string;
  /** A send the server refused or that failed; the app shows "Message not delivered". */
  notDelivered(attempt: SendAttempt): void;
  /** After the server accepted a message. */
  delivered(attempt: SendAttempt): void;
};

/** What a long-press Cancel send did: put it back, kept it (nowhere to put it), or it is already going out. */
export type CancelSendResult = "cancelled" | "kept" | "sending";

// Unsent messages outlive the thread screen: switching bots replaces it, and a send can fail after that.
let unsentSends: SendAttempt[] = [];
let sessionCount = 0;
let config: UnsentSendsConfig | undefined;
let restored = false;
/**
 * Thread screens can stack (a pushed chat leaves the one below mounted), so each mounted screen
 * and each open live connection is counted per thread rather than tracked in one slot.
 */
const threadScreens = new Map<string, { count: number; seqs: Set<number> }>();
const threadStreams = new Map<string, number>();
const echoTimers = new Map<SendAttempt, ReturnType<typeof setTimeout>>();
const deliveredListeners = new Set<(attempt: SendAttempt) => void>();
const watchers = new Set<() => void>();

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

function getUnsentSends(): SendAttempt[] {
  return unsentSends;
}

/** Accepted and waiting to appear: not resent after a restart, but its files stay until then. */
function awaitingEcho(attempt: SendAttempt) {
  return attempt.state === "pending" && attempt.acceptedSeq !== undefined;
}

function setUnsentSends(update: (current: SendAttempt[]) => SendAttempt[]) {
  unsentSends = update(unsentSends);
  if (restored) config?.disk.save(unsentSends.filter((attempt) => !awaitingEcho(attempt)));
  for (const watcher of [...watchers]) watcher();
}

function changed() {
  setUnsentSends((current) => [...current]);
}

function threadLinkUp(threadKey: string) {
  return (threadStreams.get(threadKey) ?? 0) > 0;
}

/** Any thread's live connection; with no thread on screen, whether the server last answered. */
function linkUp() {
  if (threadStreams.size > 0) return true;
  return threadScreens.size === 0 && (config?.serverReachable() ?? false);
}

function add(attempt: SendAttempt) {
  setUnsentSends((current) => (current.includes(attempt) ? [...current] : [...current, attempt]));
}

function remove(attempt: SendAttempt) {
  stopEchoTimer(attempt);
  config?.disk.forget(attempt);
  setUnsentSends((current) => current.filter((item) => item !== attempt));
}

/** Holds a message to go out once the link is back, on disk when it fits; one that does not fit fails. */
function hold(attempt: SendAttempt) {
  if (!restored && config?.scope().userId) restoreUnsentSends();
  attempt.state = "queued";
  attempt.heldOffline = true;
  attempt.attemptedAt = undefined;
  if (config && !config.disk.admit(attempt)) attempt.state = "failed";
  add(attempt);
}

function stopEchoTimer(attempt: SendAttempt) {
  clearTimeout(echoTimers.get(attempt));
  echoTimers.delete(attempt);
}

/** An accepted message that doesn't appear within the timeout while connected was not delivered. */
function armEchoTimer(attempt: SendAttempt) {
  stopEchoTimer(attempt);
  if (!threadLinkUp(attempt.payload.originThreadKey)) return;
  echoTimers.set(
    attempt,
    setTimeout(() => {
      echoTimers.delete(attempt);
      if (attempt.state !== "pending" || attempt.acceptedSeq === undefined) return;
      if (!unsentSends.includes(attempt) || !threadLinkUp(attempt.payload.originThreadKey)) return;
      // Keeps acceptedSeq, so the message still replaces this bubble if it shows up late.
      attempt.state = "failed";
      attempt.error = undefined;
      changed();
    }, SEND_ECHO_TIMEOUT_MS),
  );
}

/** A message already going out (or already delivered) can't be taken back. */
function cancelable(attempt: SendAttempt) {
  return attempt.state !== "pending" && unsentSends.includes(attempt);
}

function begin(attempt: SendAttempt) {
  if (!restored && config?.scope().userId) restoreUnsentSends();
  attempt.state = "pending";
  attempt.attemptedAt = Date.now();
  attempt.acceptedSeq = undefined;
  attempt.error = undefined;
  add(attempt);
}

function accept(attempt: SendAttempt, seq: number | undefined) {
  config?.delivered(attempt);
  for (const listener of [...deliveredListeners]) listener(attempt);
  const { originThreadKey, reroutedToGroup } = attempt.payload;
  // Only the open thread can show the message arriving; elsewhere the next load shows it.
  if (
    seq === undefined ||
    reroutedToGroup ||
    !threadScreens.get(originThreadKey) ||
    threadScreens.get(originThreadKey)!.seqs.has(seq)
  ) {
    remove(attempt);
    return;
  }
  attempt.acceptedSeq = seq;
  armEchoTimer(attempt);
  changed();
}

function fail(attempt: SendAttempt, state: "queued" | "failed" | "refused", error: unknown) {
  stopEchoTimer(attempt);
  if (attempt.session !== sessionCount) return;
  // Moved to another server or Space mid-send: hold it for when that one is current again.
  if (error instanceof SendOutOfScope || state === "queued") {
    hold(attempt);
    return;
  }
  attempt.state = state;
  attempt.error = config?.errorText(error);
  changed();
  config?.notDelivered(attempt);
}

/** The account signed out, or the app moved to another server or Space, since the attempt began. */
class SendOutOfScope extends Error {
  constructor() {
    super("The send no longer belongs to the current account or Space");
  }
}

function inScope(attempt: SendAttempt) {
  if (!config || attempt.session !== sessionCount) return false;
  const { apiBase, spaceId, userId, cacheSession } = config.scope();
  return (
    !!userId &&
    !!cacheSession &&
    attempt.cacheSession === cacheSession &&
    attempt.userId === userId &&
    attempt.apiBase === apiBase &&
    attempt.spaceId === spaceId
  );
}

async function transmit(attempt: SendAttempt) {
  await config!.disk.hydrate(attempt);
  // Every request (uploads, the send, its one resend) goes out only under the account, server
  // and Space the message was written in; credentials are read per request.
  const request = ((...args: Parameters<typeof rpc>) => {
    if (!inScope(attempt)) throw new SendOutOfScope();
    return config!.request(...args);
  }) as typeof rpc;
  const seq = await sendWithOneResend(() => deliverSend(attempt.payload, attempt, request));
  if (attempt.session === sessionCount) accept(attempt, seq);
}

const drain = createOutboxDrain<SendAttempt>({
  entries: getUnsentSends,
  linkUp,
  canSend: inScope,
  send: transmit,
  begin,
  failed: fail,
});

/** Wires the queue to the API; the app calls this once at startup. */
export function configureUnsentSends(next: UnsentSendsConfig) {
  config = next;
}

/**
 * Sends held messages, oldest first: when the link is back and when the app returns. Pass
 * `ifIdle` for signals that sending itself can cause, such as the server answering a request.
 */
export function sendWaitingMessages(options?: { ifIdle?: boolean }): Promise<void> {
  return drain(options);
}

/** Hears about every message the server accepts, whether it went out at once or was held. */
export function subscribeDelivered(listener: (attempt: SendAttempt) => void): () => void {
  deliveredListeners.add(listener);
  return () => {
    deliveredListeners.delete(listener);
  };
}

/** A thread screen is showing this thread; call the returned function when it closes. */
export function showThread(threadKey: string): () => void {
  const screen = threadScreens.get(threadKey) ?? { count: 0, seqs: new Set<number>() };
  screen.count += 1;
  threadScreens.set(threadKey, screen);
  let shown = true;
  return () => {
    if (!shown) return;
    shown = false;
    screen.count -= 1;
    if (screen.count === 0 && threadScreens.get(threadKey) === screen)
      threadScreens.delete(threadKey);
  };
}

/**
 * A thread's live connection opened; call the returned function when it closes. New messages in a
 * thread are held while none of its connections is open. Every open sends held messages and
 * restarts the wait for accepted ones to appear.
 */
export function threadStreamOpened(threadKey: string): () => void {
  threadStreams.set(threadKey, (threadStreams.get(threadKey) ?? 0) + 1);
  for (const attempt of unsentSends) {
    if (
      attempt.state === "pending" &&
      attempt.acceptedSeq !== undefined &&
      attempt.payload.originThreadKey === threadKey
    ) {
      armEchoTimer(attempt);
    }
  }
  void drain();
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    const count = (threadStreams.get(threadKey) ?? 1) - 1;
    if (count > 0) {
      threadStreams.set(threadKey, count);
      return;
    }
    threadStreams.delete(threadKey);
    for (const attempt of unsentSends) {
      if (attempt.payload.originThreadKey === threadKey) stopEchoTimer(attempt);
    }
  };
}

/** A thread screen loaded these messages; accepted sends among them are delivered. */
export function confirmEchoes(threadKey: string, seqs: Iterable<number>) {
  const screen = threadScreens.get(threadKey);
  if (!screen) return;
  screen.seqs = new Set(seqs);
  for (const attempt of unsentSends) {
    if (
      attempt.payload.originThreadKey === threadKey &&
      attempt.acceptedSeq !== undefined &&
      screen.seqs.has(attempt.acceptedSeq)
    ) {
      remove(attempt);
    }
  }
}

/** Brings back what was held when the app last closed (signed in), then tries to send it. */
export function restoreUnsentSends() {
  if (restored || !config) return;
  restored = true;
  // A thread can queue a message before this runs; that one is already saved and stays as is.
  const live = new Set(unsentSends.map((attempt) => attempt.clientNonce));
  let saved: SendAttempt[] = [];
  try {
    saved = config.disk.load(sessionCount, live, config.scope());
  } catch {
    // Nothing usable on disk; what is in memory keeps working.
  }
  setUnsentSends((current) => [
    ...saved.filter((attempt) => !live.has(attempt.clientNonce)),
    ...current,
  ]);
  void drain();
}

/** Forgets every unsent message, including sends still in flight and the copy on disk, when the account signs out. */
export function clearUnsentSends() {
  sessionCount += 1;
  // Restoring happens once per signed-in session.
  restored = false;
  for (const attempt of [...echoTimers.keys()]) stopEchoTimer(attempt);
  config?.disk.clear();
  setUnsentSends(() => []);
}

export function useThreadFeedback(threadKey: string | undefined, newNonce: () => string) {
  const [error, setError] = useState<string | null>(null);
  const allUnsentSends = useSyncExternalStore(subscribe, getUnsentSends, getUnsentSends);
  const activeThread = useRef(threadKey);
  activeThread.current = threadKey;

  useEffect(() => setError(null), [threadKey]);

  const threadUnsentSends = allUnsentSends.filter(
    (attempt) =>
      attempt.payload.originThreadKey === threadKey &&
      attempt.apiBase === config?.scope().apiBase &&
      attempt.userId === config?.scope().userId &&
      attempt.cacheSession === config?.scope().cacheSession &&
      attempt.spaceId === config?.scope().spaceId,
  );

  return {
    error,
    setError(value: string | null) {
      if (threadKey === activeThread.current) setError(value);
    },
    refreshed(key = threadKey) {
      if (key === activeThread.current) setError(null);
    },
    unsentSends: threadUnsentSends,
    /** True when a new message here is held instead of going out now. */
    shouldHold() {
      return shouldHoldSend(threadUnsentSends, threadKey ? threadLinkUp(threadKey) : false);
    },
    sendAttempt(payload: SendPayload): SendAttempt {
      const scope = config?.scope() ?? {
        apiBase: "",
        spaceId: null,
        userId: null,
        cacheSession: null,
      };
      return {
        payload,
        clientNonce: newNonce(),
        artifactIds: new Map(),
        state: "pending",
        heldOffline: false,
        createdAt: Date.now(),
        session: sessionCount,
        ...scope,
      };
    },
    /** Holds a message until the link is back, and sends right away if it already is. */
    queue(attempt: SendAttempt) {
      if (attempt.session !== sessionCount) return;
      hold(attempt);
      if (linkUp()) void drain();
    },
    /** Shows the message at once and sends it; resolves true once the server accepted it. */
    async send(attempt: SendAttempt): Promise<boolean> {
      if (attempt.session !== sessionCount) return false;
      if (unsentSends.includes(attempt) && attempt.state === "pending") return false;
      begin(attempt);
      try {
        await transmit(attempt);
        return attempt.session === sessionCount;
      } catch (error) {
        fail(attempt, stateAfterFailure(error), error);
        return false;
      }
    },
    /** Cancel send: the message to put back in the composer, unless it is already going out. */
    /**
     * Cancel send: reads the message's files back and hands it to `putBack`, then removes it.
     * If `putBack` can't take it (the screen closed meanwhile), the message stays as it was.
     */
    async cancel(
      attempt: SendAttempt,
      putBack: (attempt: SendAttempt) => boolean,
    ): Promise<CancelSendResult> {
      if (!cancelable(attempt)) return "sending";
      await config?.disk.hydrate(attempt, { forComposer: true }).catch(() => undefined);
      // The queue may have started or finished sending it meanwhile.
      if (!cancelable(attempt)) return "sending";
      if (!putBack(attempt)) return "kept";
      remove(attempt);
      return "cancelled";
    },
  };
}
