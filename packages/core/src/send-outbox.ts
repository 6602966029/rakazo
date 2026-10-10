import { isServerUnreachable } from "./user-error.js";

/**
 * A message the server hasn't confirmed yet: held until the live connection is back, being sent
 * (or accepted and waiting to appear in the thread), or not delivered. A failed one can be retried;
 * a refused one was rejected by the server and can't be.
 */
export type OutboxState = "queued" | "pending" | "failed" | "refused";

export type OutboxEntry = {
  state: OutboxState;
  /** It was held while offline (and may be going out now). */
  heldOffline?: boolean;
  /** The server accepted it; it is only waiting to appear in the thread. */
  acceptedSeq?: number;
};

/** After the server accepted a send, how long it may take to appear in the thread while connected. */
export const SEND_ECHO_TIMEOUT_MS = 120_000;
/** A send shows its progress only once it has taken this long. */
export const SEND_PROGRESS_DELAY_MS = 2_000;

/**
 * A new send is held while the live connection is down, and behind a held message in its thread
 * until the server has accepted that one, so it can't arrive first (e.g. while that one uploads).
 */
export function shouldHoldSend(threadEntries: readonly OutboxEntry[], linkUp: boolean): boolean {
  return (
    !linkUp ||
    threadEntries.some(
      (entry) =>
        entry.state === "queued" ||
        (entry.state === "pending" && entry.heldOffline && entry.acceptedSeq === undefined),
    )
  );
}

function failureStatus(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number") return status;
    current = current.cause;
  }
  return undefined;
}

/** Client errors a later attempt can get past: request timeout, too early, rate limit. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

/** True when the server asked the client to slow down. */
export function isRateLimited(error: unknown): boolean {
  return failureStatus(error) === 429;
}

/**
 * A send that may never have reached the server is held to go again by itself; one the server
 * rejected (4xx) is refused; anything else, a timeout or a rate limit included, failed and can
 * be retried.
 */
export function stateAfterFailure(error: unknown): "queued" | "failed" | "refused" {
  if (isServerUnreachable(error)) return "queued";
  const status = failureStatus(error);
  if (status === undefined || RETRYABLE_CLIENT_STATUSES.has(status)) return "failed";
  return status >= 400 && status < 500 ? "refused" : "failed";
}

/** Sends once more right away, with the same nonce, when the first try may not have arrived. */
export async function sendWithOneResend<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!isServerUnreachable(error)) throw error;
    return send();
  }
}

/**
 * The bubble that shows send progress (the newest one being sent) and since when: the oldest of
 * those attempts, so a row of slow sends shows one indicator.
 */
export function sendProgress<T extends OutboxEntry & { attemptedAt?: number }>(
  entries: readonly T[],
): { entry: T; since: number } | null {
  const pending = entries.filter((entry) => entry.state === "pending" && entry.attemptedAt);
  const newest = pending.at(-1);
  if (!newest) return null;
  return { entry: newest, since: Math.min(...pending.map((entry) => entry.attemptedAt!)) };
}

/**
 * Sends held entries one at a time, oldest first, so a later message never overtakes an earlier
 * one. Runs while the link is up; stops when the server is unreachable again and goes past a send
 * that failed for another reason. Call the returned function whenever the link may be back;
 * overlapping calls share one run, and a call during a run makes it look again once it ends.
 * A call with `ifIdle` does nothing during a run: use it for signals the run's own requests
 * cause (a request that succeeds before the send gets a 503), so they can't make it loop.
 */
export function createOutboxDrain<T extends OutboxEntry>(deps: {
  /** Entries in the order they were sent. */
  entries(): readonly T[];
  linkUp(): boolean;
  /** False for an entry that belongs elsewhere (another server or space) and must wait. */
  canSend(entry: T): boolean;
  send(entry: T): Promise<void>;
  begin(entry: T): void;
  failed(entry: T, state: "queued" | "failed" | "refused", error: unknown): void;
}): (options?: { ifIdle?: boolean }) => Promise<void> {
  // `active` ends in the same tick the loop does, so a call right after can't join a finished run.
  let active = false;
  let running: Promise<void> = Promise.resolve();
  let again = false;

  async function run() {
    try {
      do {
        again = false;
        while (deps.linkUp()) {
          const entry = deps
            .entries()
            .find((candidate) => candidate.state === "queued" && deps.canSend(candidate));
          if (!entry) break;
          deps.begin(entry);
          try {
            await deps.send(entry);
          } catch (error) {
            // Rate limited: keep it (and everything behind it) held for a later run rather than
            // failing the whole backlog one message at a time.
            const state = isRateLimited(error) ? "queued" : stateAfterFailure(error);
            deps.failed(entry, state, error);
            if (state === "queued") break;
          }
        }
      } while (again);
    } finally {
      active = false;
    }
  }

  return (options) => {
    if (active) {
      if (!options?.ifIdle) again = true;
      return running;
    }
    active = true;
    running = run();
    return running;
  };
}
