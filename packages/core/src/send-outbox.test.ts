import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./send-outbox.js";
import {
  createOutboxDrain,
  sendProgress,
  sendWithOneResend,
  shouldHoldSend,
  stateAfterFailure,
} from "./send-outbox.js";

type Entry = OutboxEntry & { id: string; threadKey: string; space?: string };

const offline = () => new TypeError("Network request failed");
const refused = () => Object.assign(new Error("Bot not found"), { status: 404 });
const broken = () => Object.assign(new Error("Internal server error"), { status: 500 });

function harness(
  entries: Entry[],
  outcomes: Record<string, Array<() => Error>> = {},
  link = { up: true },
) {
  const sent: string[] = [];
  const drain = createOutboxDrain<Entry>({
    entries: () => entries,
    linkUp: () => link.up,
    canSend: (entry) => entry.space !== "other",
    async send(entry) {
      sent.push(entry.id);
      const fail = outcomes[entry.id]?.shift();
      if (fail) throw fail();
      entries.splice(entries.indexOf(entry), 1);
    },
    begin(entry) {
      entry.state = "pending";
    },
    failed(entry, state) {
      entry.state = state;
    },
  });
  return { drain, sent };
}

describe("shouldHoldSend", () => {
  it("holds while the link is down and behind a held message in the thread", () => {
    const thread: OutboxEntry[] = [{ state: "queued" }];
    expect(shouldHoldSend([], false)).toBe(true);
    expect(shouldHoldSend([], true)).toBe(false);
    expect(shouldHoldSend(thread, true)).toBe(true);
    for (const state of ["pending", "failed", "refused"] as const) {
      thread[0]!.state = state;
      expect(shouldHoldSend(thread, true)).toBe(false);
    }
  });

  it("keeps new sends behind a held message until the server has accepted it", () => {
    const draining: OutboxEntry = { state: "pending", heldOffline: true };
    expect(shouldHoldSend([draining], true)).toBe(true);
    draining.acceptedSeq = 41;
    expect(shouldHoldSend([draining], true)).toBe(false);
    expect(shouldHoldSend([{ state: "pending" }], true)).toBe(false);
  });
});

describe("stateAfterFailure", () => {
  it("holds transport failures, refuses 4xx and lets anything else be retried", () => {
    expect(stateAfterFailure(offline())).toBe("queued");
    expect(
      stateAfterFailure(Object.assign(new Error("Request timed out"), { name: "TimeoutError" })),
    ).toBe("queued");
    expect(stateAfterFailure(Object.assign(new Error("Bad gateway"), { status: 502 }))).toBe(
      "queued",
    );
    expect(stateAfterFailure(new Error("consent", { cause: offline() }))).toBe("queued");
    expect(stateAfterFailure(refused())).toBe("refused");
    expect(stateAfterFailure(new Error("consent", { cause: refused() }))).toBe("refused");
    expect(stateAfterFailure(broken())).toBe("failed");
    for (const status of [408, 425, 429]) {
      expect(stateAfterFailure(Object.assign(new Error("Try later"), { status }))).toBe("failed");
    }
    expect(stateAfterFailure(new Error("Request canceled"))).toBe("failed");
  });
});

describe("sendWithOneResend", () => {
  it("sends once more right away after a transport failure, and only once", async () => {
    let calls = 0;
    await expect(
      sendWithOneResend(async () => {
        calls += 1;
        if (calls === 1) throw offline();
        return "accepted";
      }),
    ).resolves.toBe("accepted");
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      sendWithOneResend(async () => {
        calls += 1;
        throw offline();
      }),
    ).rejects.toThrow("Network request failed");
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      sendWithOneResend(async () => {
        calls += 1;
        throw refused();
      }),
    ).rejects.toThrow("Bot not found");
    expect(calls).toBe(1);
  });
});

describe("sendProgress", () => {
  it("shows on the newest send in flight, timed from the oldest", () => {
    const entries = [
      { state: "pending" as const, attemptedAt: 1_000 },
      { state: "queued" as const },
      { state: "pending" as const, attemptedAt: 3_000 },
      { state: "failed" as const, attemptedAt: 500 },
    ];
    expect(sendProgress(entries)).toEqual({ entry: entries[2], since: 1_000 });
    expect(sendProgress([{ state: "queued" as const }])).toBeNull();
  });
});

describe("createOutboxDrain", () => {
  it("sends held entries oldest first, one at a time", async () => {
    const entries: Entry[] = [
      { id: "a", threadKey: "bot-1", state: "queued" },
      { id: "b", threadKey: "bot-2", state: "queued" },
      { id: "c", threadKey: "bot-1", state: "queued" },
    ];
    const { drain, sent } = harness(entries);
    await drain();
    expect(sent).toEqual(["a", "b", "c"]);
    expect(entries).toEqual([]);
  });

  it("does nothing while the link is down", async () => {
    const entries: Entry[] = [{ id: "a", threadKey: "bot-1", state: "queued" }];
    const { drain, sent } = harness(entries, {}, { up: false });
    await drain();
    expect(sent).toEqual([]);
  });

  it("stops while the server is unreachable and resumes in order on the next call", async () => {
    const entries: Entry[] = [
      { id: "a", threadKey: "bot-1", state: "queued" },
      { id: "b", threadKey: "bot-1", state: "queued" },
    ];
    const { drain, sent } = harness(entries, { a: [offline] });
    await drain();
    expect(sent).toEqual(["a"]);
    expect(entries.map((entry) => entry.state)).toEqual(["queued", "queued"]);
    await drain();
    expect(sent).toEqual(["a", "a", "b"]);
    expect(entries).toEqual([]);
  });

  it("goes past a refused or failed send", async () => {
    const entries: Entry[] = [
      { id: "a", threadKey: "bot-1", state: "queued" },
      { id: "b", threadKey: "bot-1", state: "queued" },
      { id: "c", threadKey: "bot-1", state: "queued" },
    ];
    const { drain, sent } = harness(entries, { a: [refused], b: [broken] });
    await drain();
    expect(sent).toEqual(["a", "b", "c"]);
    expect(entries).toEqual([
      { id: "a", threadKey: "bot-1", state: "refused" },
      { id: "b", threadKey: "bot-1", state: "failed" },
    ]);
  });

  it("stops at a rate limit and keeps that message and the rest held, in order", async () => {
    const entries: Entry[] = [
      { id: "a", threadKey: "bot-1", state: "queued" },
      { id: "b", threadKey: "bot-1", state: "queued" },
    ];
    const limited = () => Object.assign(new Error("Too many requests"), { status: 429 });
    const { drain, sent } = harness(entries, { a: [limited] });
    await drain();
    expect(sent).toEqual(["a"]);
    expect(entries.map((entry) => entry.state)).toEqual(["queued", "queued"]);
    await drain();
    expect(sent).toEqual(["a", "a", "b"]);
  });

  it("does not retry because the attempt itself made the server look reachable", async () => {
    const entries: Entry[] = [{ id: "a", threadKey: "bot-1", state: "queued" }];
    let sends = 0;
    const drain = createOutboxDrain<Entry>({
      entries: () => entries,
      linkUp: () => true,
      canSend: () => true,
      async send() {
        sends += 1;
        await Promise.resolve();
        // A consent check answers (the server looks reachable again), then the send gets a 503.
        // Bounded so a regression fails instead of spinning forever.
        if (sends < 5) void drain({ ifIdle: true });
        throw Object.assign(new Error("Service Unavailable"), { status: 503 });
      },
      begin(entry) {
        entry.state = "pending";
      },
      failed(entry, state) {
        entry.state = state;
      },
    });
    await drain();
    expect(sends).toBe(1);
    await drain();
    expect(sends).toBe(2);
  });

  it("looks again after a failed attempt when the link came back meanwhile", async () => {
    const entries: Entry[] = [{ id: "a", threadKey: "bot-1", state: "queued" }];
    let sends = 0;
    const drain = createOutboxDrain<Entry>({
      entries: () => entries,
      linkUp: () => true,
      canSend: () => true,
      async send(entry) {
        sends += 1;
        await Promise.resolve();
        if (sends === 1) {
          // The live connection reopened while this attempt was still timing out.
          void drain();
          throw offline();
        }
        entries.splice(entries.indexOf(entry), 1);
      },
      begin(entry) {
        entry.state = "pending";
      },
      failed(entry, state) {
        entry.state = state;
      },
    });
    await drain();
    expect(sends).toBe(2);
    expect(entries).toEqual([]);
  });

  it("starts a new run for a call that comes right after a run finished, before it settled", async () => {
    const entries: Entry[] = [];
    const { drain, sent } = harness(entries);
    const idle = drain();
    entries.push({ id: "a", threadKey: "bot-1", state: "queued" });
    await drain();
    await idle;
    expect(sent).toEqual(["a"]);
  });

  it("skips entries that belong to another server or space and leaves others alone", async () => {
    const entries: Entry[] = [
      { id: "a", threadKey: "bot-1", state: "failed" },
      { id: "b", threadKey: "bot-9", state: "queued", space: "other" },
      { id: "c", threadKey: "bot-2", state: "pending" },
      { id: "d", threadKey: "bot-2", state: "queued" },
    ];
    const { drain, sent } = harness(entries);
    await drain();
    expect(sent).toEqual(["d"]);
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("shares one run between overlapping calls and picks up entries added meanwhile", async () => {
    const entries: Entry[] = [{ id: "a", threadKey: "bot-1", state: "queued" }];
    const { drain, sent } = harness(entries);
    const first = drain();
    entries.push({ id: "b", threadKey: "bot-1", state: "queued" });
    const second = drain();
    expect(second).toBe(first);
    await first;
    expect(sent).toEqual(["a", "b"]);
  });
});
