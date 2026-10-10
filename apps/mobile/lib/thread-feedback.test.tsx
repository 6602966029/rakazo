// @vitest-environment jsdom

import type { ComposerMention } from "@rakazo/core";
import { resolveComposerSendPlan, serializeComposerPrompt } from "@rakazo/core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptimisticSendBubble } from "../components/optimistic-send-bubble";
import type { SendAttempt, SendPayload, UnsentDisk } from "./thread-feedback";
import {
  clearUnsentSends,
  configureUnsentSends,
  confirmEchoes,
  deliverSend,
  restoreComposerDraft,
  restoreUnsentSends,
  sendWaitingMessages,
  showThread,
  subscribeDelivered,
  threadStreamOpened,
  useThreadFeedback,
} from "./thread-feedback";

type Props = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  onPress?: () => void;
};

vi.mock("react-native", () => ({
  View: ({ children, accessibilityLabel, style }: Props & { style?: Record<string, unknown> }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        "data-align-self": style?.alignSelf,
        "data-align-items": style?.alignItems,
      },
      children,
    ),
  Text: ({
    children,
    accessibilityElementsHidden,
  }: Props & { accessibilityElementsHidden?: boolean }) =>
    createElement("span", { "aria-hidden": accessibilityElementsHidden }, children),
  Image: () => null,
  Pressable: ({ children, onPress, accessibilityLabel }: Props) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
      children,
    ),
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("../components/message-context-menu", () => ({
  MessageContextMenu: ({
    actions,
    children,
    onAction,
  }: {
    actions: Array<{ id: string; title: string }>;
    children?: ReactNode;
    onAction: (id: string) => void;
  }) =>
    createElement(
      "div",
      null,
      children,
      actions.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-menu": action.id,
            onClick: () => onAction(action.id),
          },
          action.title,
        ),
      ),
    ),
}));
vi.mock("../components/send-progress", () => ({
  SendProgress: ({ since }: { since: number }) =>
    createElement("i", { "data-progress-since": since }),
}));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({}),
  useResolvedAppearance: () => "light",
}));
vi.mock("./i18n", () => ({
  dateLocaleForUi: () => "en-US",
  useI18n: () => ({
    locale: "en",
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? key),
  }),
}));

/** One thread screen and its live connection, as the thread screen drives them. */
let screen: { key: string; hide: () => void } | undefined;
let stream: (() => void) | undefined;
function watchThread(key: string | null, live: boolean) {
  if (screen?.key !== key) {
    stream?.();
    stream = undefined;
    screen?.hide();
    screen = key ? { key, hide: showThread(key) } : undefined;
  }
  if (!live) {
    stream?.();
    stream = undefined;
  } else if (key && !stream) {
    stream = threadStreamOpened(key);
  }
}

let feedback: ReturnType<typeof useThreadFeedback>;
let nonces = 0;
const retry = vi.fn();
const cancelSend = vi.fn();
const selectText = vi.fn();
function Probe({ threadKey }: { threadKey: string }) {
  feedback = useThreadFeedback(threadKey, () => `nonce-${++nonces}`);
  return feedback.unsentSends.map((attempt) => (
    <OptimisticSendBubble
      key={attempt.clientNonce}
      attempt={attempt}
      onRetry={retry}
      onCancelSend={cancelSend}
      onSelectText={selectText}
    />
  ));
}

const server = {
  reachable: true,
  scope: { apiBase: "https://rakazo.example", spaceId: "space-1" as string | null },
  request: vi.fn(),
  delivered: vi.fn(),
  notDelivered: vi.fn(),
};
const disk = {
  admit: vi.fn<UnsentDisk["admit"]>(() => true),
  save: vi.fn<UnsentDisk["save"]>(),
  forget: vi.fn<UnsentDisk["forget"]>(),
  load: vi.fn<UnsentDisk["load"]>(() => []),
  hydrate: vi.fn<UnsentDisk["hydrate"]>(async () => undefined),
  clear: vi.fn<UnsentDisk["clear"]>(),
};
configureUnsentSends({
  request: server.request,
  serverReachable: () => server.reachable,
  scope: () => server.scope,
  disk,
  errorText: (error) => (error instanceof Error ? error.message : "Failed"),
  notDelivered: server.notDelivered,
  delivered: server.delivered,
});

/** Takes a cancelled message the way an open composer does. */
const putBack = vi.fn<(attempt: SendAttempt) => boolean>(() => true);

const offline = () => new TypeError("Network request failed");
const refused = (message = "Bot is archived") => Object.assign(new Error(message), { status: 400 });
const broken = () => Object.assign(new Error("Internal server error"), { status: 500 });
/** threads/send accepts with this seq; uploads return an artifact. */
function accepts(seq = 41) {
  return async (method: string) =>
    method === "artifacts/create"
      ? { id: "artifact-1" }
      : method === "threads/send"
        ? { seq }
        : undefined;
}

function payload(text = "Hello"): SendPayload {
  return {
    originThreadKey: "bot-1",
    composer: { draft: text, mentions: [], skill: null },
    displayText: text,
    replyPreview: "Quoted message",
    initialBotTarget: "bot-1",
    botTarget: "bot-1",
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text, mentions: [], hasAttachments: true }),
    attachments: [
      { id: "attachment-1", name: "photo.png", mimeType: "image/png", contentBase64: "fake" },
    ],
    replyTargetId: "reply-1",
    replyQuote: "Quoted message",
  };
}

describe("thread feedback", () => {
  let root: Root;
  let container: HTMLDivElement;
  function render(threadKey: string) {
    act(() => root.render(<Probe threadKey={threadKey} />));
  }
  const bubble = (index = 0) =>
    container.querySelectorAll<HTMLDivElement>("div[aria-label]")[index]!;
  const menu = (id: string) => container.querySelector<HTMLButtonElement>(`[data-menu="${id}"]`);
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    server.reachable = true;
    server.scope = { apiBase: "https://rakazo.example", spaceId: "space-1" };
    server.request.mockReset();
    disk.admit.mockImplementation(() => true);
    putBack.mockImplementation(() => true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => watchThread("bot-1", true));
    render("bot-1");
  });
  afterEach(() => {
    act(() => root.unmount());
    act(() => clearUnsentSends());
    act(() => watchThread(null, false));
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function send(attempt: SendAttempt) {
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    let result = false;
    await act(async () => {
      result = await sending;
    });
    return result;
  }

  it("shows the message at once, before the server answers, and keeps it until it appears", async () => {
    let accept!: (value: { seq: number }) => void;
    server.request.mockImplementation((method: string) =>
      method === "threads/send"
        ? new Promise((resolve) => {
            accept = resolve;
          })
        : Promise.resolve({ id: "artifact-1" }),
    );
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    expect(attempt.state).toBe("pending");
    expect(container.textContent).toContain("Hello");
    expect(bubble().getAttribute("aria-label")).toBe("Hello, photo.png. Sending");
    expect(menu("cancelSend")).toBeNull();
    expect(menu("copy")).not.toBeNull();
    expect(menu("select")).not.toBeNull();
    await act(async () => {
      await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
      accept({ seq: 41 });
      expect(await sending).toBe(true);
    });
    expect(attempt.acceptedSeq).toBe(41);
    expect(feedback.unsentSends).toEqual([attempt]);
    act(() => confirmEchoes("bot-1", [12, 41]));
    expect(feedback.unsentSends).toEqual([]);
    expect(server.delivered).toHaveBeenCalledOnce();
  });

  it("keeps the bubble at the right edge however wide its footer is", async () => {
    act(() => watchThread("bot-1", false));
    act(() => feedback.queue(feedback.sendAttempt({ ...payload("v1"), attachments: [] })));
    server.request.mockImplementation(async () => {
      throw broken();
    });
    await act(async () => {
      watchThread("bot-1", true);
      await sendWaitingMessages({ ifIdle: true });
    });
    expect(container.textContent).toContain("Not delivered");
    // The column aligns each row (bubble, footer) to the end instead of stretching them to the
    // widest one, so a footer wider than the bubble can't pull the bubble off the right edge.
    const column = container.querySelector<HTMLDivElement>('div[data-align-self="flex-end"]')!;
    expect(column.getAttribute("data-align-items")).toBe("flex-end");
  });

  it("drops an accepted message at once when its thread is not on screen or already shows it", async () => {
    server.request.mockImplementation(accepts(41));
    act(() => confirmEchoes("bot-1", [41]));
    expect(await send(feedback.sendAttempt(payload()))).toBe(true);
    expect(feedback.unsentSends).toEqual([]);
    act(() => watchThread("bot-2", true));
    expect(await send(feedback.sendAttempt(payload()))).toBe(true);
    expect(feedback.unsentSends).toEqual([]);
  });

  it("marks an accepted message not delivered when it hasn't appeared after 120 s while connected", async () => {
    vi.useFakeTimers();
    server.request.mockImplementation(accepts(41));
    const attempt = feedback.sendAttempt(payload());
    await send(attempt);
    act(() => watchThread("bot-1", false));
    await act(() => vi.advanceTimersByTimeAsync(200_000));
    expect(attempt.state).toBe("pending");
    act(() => watchThread("bot-1", true));
    await act(() => vi.advanceTimersByTimeAsync(119_000));
    expect(attempt.state).toBe("pending");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(attempt.state).toBe("failed");
    expect(container.textContent).toContain("Not delivered");
    expect(container.textContent).toContain("Retry");
    expect(server.notDelivered).not.toHaveBeenCalled();
    // The message still replaces the bubble if it shows up late.
    act(() => confirmEchoes("bot-1", [41]));
    expect(feedback.unsentSends).toEqual([]);
  });

  it("sends once more right away after a transport failure, then holds the message to go out later", async () => {
    server.request
      .mockResolvedValueOnce({ id: "artifact-1" })
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce({ seq: 41 });
    const resent = feedback.sendAttempt(payload());
    expect(await send(resent)).toBe(true);
    const sends = server.request.mock.calls.filter(([method]) => method === "threads/send");
    expect(sends.map(([, input]) => input.clientNonce)).toEqual([
      resent.clientNonce,
      resent.clientNonce,
    ]);

    server.request.mockReset();
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-2" };
      throw Object.assign(new Error("Bad gateway"), { status: 502 });
    });
    const held = feedback.sendAttempt(payload("Later"));
    expect(await send(held)).toBe(false);
    expect(server.request.mock.calls.filter(([method]) => method === "threads/send")).toHaveLength(
      2,
    );
    expect(held.state).toBe("queued");
    expect(held.heldOffline).toBe(true);
    expect(disk.admit).toHaveBeenCalledWith(held);
    expect(server.notDelivered).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Not delivered");
    expect(menu("cancelSend")).not.toBeNull();
  });

  it("shows Not delivered for a refused send, without Retry, and with Retry when it failed otherwise", async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      throw refused();
    });
    const rejected = feedback.sendAttempt(payload("Rejected"));
    await send(rejected);
    expect(rejected.state).toBe("refused");
    expect(rejected.error).toBe("Bot is archived");
    expect(server.notDelivered).toHaveBeenCalledWith(rejected);
    expect(bubble().getAttribute("aria-label")).toBe("Rejected, photo.png. Not delivered");
    // The caption is in the bubble's label, so VoiceOver doesn't read it a second time.
    const caption = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "Not delivered",
    )!;
    expect(caption.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('button[aria-label="Retry send"]')).toBeNull();

    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      throw broken();
    });
    const failed = feedback.sendAttempt(payload("Broken"));
    await send(failed);
    expect(failed.state).toBe("failed");
    const retryButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Retry send"]',
    )!;
    act(() => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
    expect(server.request.mock.calls.filter(([method]) => method === "threads/send")).toHaveLength(
      2,
    );
  });

  it("retries a failed message with the same nonce and its uploaded files", async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      throw broken();
    });
    const attempt = feedback.sendAttempt(payload());
    await send(attempt);
    server.request.mockReset();
    server.request.mockImplementation(accepts(41));
    expect(await send(attempt)).toBe(true);
    expect(server.request).toHaveBeenCalledWith(
      "threads/send",
      expect.objectContaining({ clientNonce: attempt.clientNonce, artifactIds: ["artifact-1"] }),
    );
    expect(server.request.mock.calls.filter(([method]) => method === "artifacts/create")).toEqual(
      [],
    );
  });

  it("holds new messages while the live connection is down and sends them in order when it is back", async () => {
    act(() => watchThread("bot-1", false));
    expect(feedback.shouldHold()).toBe(true);
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    act(() => {
      feedback.queue(first);
      feedback.queue(second);
    });
    expect(server.request).not.toHaveBeenCalled();
    expect([first.state, second.state]).toEqual(["queued", "queued"]);
    expect(bubble().getAttribute("aria-label")).toBe(
      "First, photo.png. Messages waiting to send until the server reconnects",
    );

    let release!: () => void;
    server.request.mockImplementation(async (method: string, input: { text?: string }) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      if (input.text === "First")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { seq: input.text === "First" ? 41 : 42 };
    });
    act(() => watchThread("bot-1", true));
    await act(async () => {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    });
    expect(first.state).toBe("pending");
    expect(second.state).toBe("queued");
    expect(container.textContent).toMatch(/Sent while offline · \w{3} \d+/);
    // A message written meanwhile still waits behind the held ones.
    expect(feedback.shouldHold()).toBe(true);
    await act(async () => {
      release();
      await sendWaitingMessages();
    });
    const sends = server.request.mock.calls.filter(([method]) => method === "threads/send");
    expect(sends.map(([, input]) => [input.text, input.clientNonce])).toEqual([
      ["First", first.clientNonce],
      ["Second", second.clientNonce],
    ]);
    // Accepted: off the saved list, but its files stay until the message shows up.
    expect(disk.forget).not.toHaveBeenCalled();
    act(() => confirmEchoes("bot-1", [41, 42]));
    expect(feedback.unsentSends).toEqual([]);
    expect(disk.forget).toHaveBeenCalledWith(first);
    expect(feedback.shouldHold()).toBe(false);
  });

  it("keeps a new message behind a held one that is still being sent, until the server accepts it", async () => {
    act(() => watchThread("bot-1", false));
    const held = feedback.sendAttempt(payload("First"));
    act(() => feedback.queue(held));
    let upload!: () => void;
    server.request.mockImplementation(async (method: string, input: { text?: string }) => {
      if (method === "artifacts/create") {
        await new Promise<void>((resolve) => {
          upload = resolve;
        });
        return { id: "artifact-1" };
      }
      return { seq: input.text === "First" ? 41 : 42 };
    });
    act(() => watchThread("bot-1", true));
    await act(async () => {
      await vi.waitFor(() => expect(upload).toBeTypeOf("function"));
    });
    expect(held.state).toBe("pending");
    // Still uploading: a new message must not go out first.
    expect(feedback.shouldHold()).toBe(true);
    const next = feedback.sendAttempt({ ...payload("Second"), attachments: [] });
    act(() => feedback.queue(next));
    expect(next.state).toBe("queued");
    await act(async () => {
      upload();
      await sendWaitingMessages({ ifIdle: true });
    });
    const sends = server.request.mock.calls.filter(([method]) => method === "threads/send");
    expect(sends.map(([, input]) => input.text)).toEqual(["First", "Second"]);
  });

  it("lets a rate-limited send be retried instead of refusing it", async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      throw Object.assign(new Error("Too many requests"), { status: 429 });
    });
    const limited = feedback.sendAttempt(payload());
    await send(limited);
    expect(limited.state).toBe("failed");
    expect(container.querySelector('button[aria-label="Retry send"]')).not.toBeNull();
  });

  it("sends once per trigger while only the send itself gets a 503", async () => {
    act(() => watchThread("bot-1", false));
    const attempt = feedback.sendAttempt({ ...payload(), attachments: [] });
    act(() => feedback.queue(attempt));
    server.request.mockImplementation(async () => {
      await Promise.resolve();
      // The consent check answered, so the server looks reachable again and that triggers sending.
      void sendWaitingMessages({ ifIdle: true });
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    });
    await act(async () => {
      watchThread("bot-1", true);
      // Waits for the run the reconnect started without asking for another.
      await sendWaitingMessages({ ifIdle: true });
    });
    // One send and its one immediate resend.
    expect(server.request).toHaveBeenCalledTimes(2);
    expect(attempt.state).toBe("queued");
    await act(() => sendWaitingMessages());
    expect(server.request).toHaveBeenCalledTimes(4);
  });

  it("sends a held message when the connection comes back while a failing attempt is still out", async () => {
    act(() => watchThread("bot-1", false));
    const attempt = feedback.sendAttempt({ ...payload(), attachments: [] });
    act(() => feedback.queue(attempt));
    let calls = 0;
    server.request.mockImplementation(async () => {
      calls += 1;
      await Promise.resolve();
      if (calls <= 2) {
        // The live connection drops and reopens while this attempt is still timing out.
        if (calls === 2) {
          watchThread("bot-1", false);
          watchThread("bot-1", true);
        }
        throw offline();
      }
      return { seq: 41 };
    });
    await act(async () => {
      watchThread("bot-1", true);
      await sendWaitingMessages({ ifIdle: true });
    });
    expect(attempt.acceptedSeq).toBe(41);
  });

  it("sends a held message when the reopened stream is the first answer from the server", async () => {
    act(() => watchThread("bot-1", false));
    const attempt = feedback.sendAttempt({ ...payload(), attachments: [] });
    act(() => feedback.queue(attempt));
    server.request.mockImplementation(accepts(41));
    await act(async () => {
      // The subscribe response marks the server reachable, which starts an idle run that finds the
      // stream still closed, and then reports the stream open, all in one tick.
      void sendWaitingMessages({ ifIdle: true });
      watchThread("bot-1", true);
      await sendWaitingMessages({ ifIdle: true });
    });
    expect(attempt.acceptedSeq).toBe(41);
  });

  it("sends held messages when a chat that is also open further back in the stack reconnects", async () => {
    // The same chat is open twice (a pushed screen keeps the one below mounted).
    const hideBelow = showThread("bot-1");
    let below: (() => void) | undefined = threadStreamOpened("bot-1");
    try {
      act(() => watchThread("bot-1", false));
      // The screen below still has its stale stream, so the chat counts as connected.
      act(() => below?.());
      below = undefined;
      expect(feedback.shouldHold()).toBe(true);
      const attempt = feedback.sendAttempt({ ...payload(), attachments: [] });
      act(() => feedback.queue(attempt));
      server.request.mockImplementation(accepts(41));
      // The screen below reconnects first, then the one on top; either reopening sends.
      await act(async () => {
        below = threadStreamOpened("bot-1");
        await sendWaitingMessages({ ifIdle: true });
      });
      expect([attempt.state, server.request.mock.calls.length]).toEqual(["pending", 1]);
      expect(attempt.acceptedSeq).toBe(41);
      // The top screen's stream closing doesn't hold new messages while the one below is open.
      act(() => watchThread("bot-1", false));
      expect(feedback.shouldHold()).toBe(false);
    } finally {
      below?.();
      hideBelow();
    }
  });

  it("goes past a held message the server refuses and reports it", async () => {
    act(() => watchThread("bot-1", false));
    const first = feedback.sendAttempt(payload("First"));
    const second = feedback.sendAttempt(payload("Second"));
    act(() => {
      feedback.queue(first);
      feedback.queue(second);
    });
    server.request.mockImplementation(async (method: string, input: { text?: string }) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      if (input.text === "First") throw refused();
      return { seq: 42 };
    });
    await act(async () => {
      watchThread("bot-1", true);
      await sendWaitingMessages();
    });
    expect(first.state).toBe("refused");
    expect(server.notDelivered).toHaveBeenCalledWith(first);
    expect(second.acceptedSeq).toBe(42);
  });

  it("keeps a held message that does not fit on disk as not delivered", () => {
    act(() => watchThread("bot-1", false));
    disk.admit.mockReturnValue(false);
    const attempt = feedback.sendAttempt(payload());
    act(() => feedback.queue(attempt));
    expect(attempt.state).toBe("failed");
    expect(container.textContent).toContain("Not delivered");
  });

  it("cancels a held or failed message with its content, and not one already sending", async () => {
    act(() => watchThread("bot-1", false));
    const held = feedback.sendAttempt(payload());
    held.payload.attachments[0]!.contentBase64 = "";
    act(() => feedback.queue(held));
    act(() => menu("cancelSend")!.click());
    expect(cancelSend).toHaveBeenCalledOnce();
    disk.hydrate.mockImplementationOnce(async (target) => {
      target.payload.attachments[0]!.contentBase64 = "restored";
    });
    const cancelling = feedback.cancel(held, putBack);
    await act(() => cancelling);
    expect(await cancelling).toBe("cancelled");
    expect(putBack).toHaveBeenCalledWith(held);
    // Every file comes back, uploaded ones too.
    expect(disk.hydrate).toHaveBeenCalledWith(held, { forComposer: true });
    expect(held.payload.attachments[0]?.contentBase64).toBe("restored");
    expect(feedback.unsentSends).toEqual([]);
    expect(disk.forget).toHaveBeenCalledWith(held);

    act(() => watchThread("bot-1", true));
    let finish!: () => void;
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { seq: 41 };
    });
    const going = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(going);
    });
    await act(async () => {
      expect(await feedback.cancel(going, putBack)).toBe("sending");
    });
    expect(feedback.unsentSends).toEqual([going]);
    await act(async () => {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      finish();
      await sending;
    });
    act(() => confirmEchoes("bot-1", [41]));
    await act(async () => {
      expect(await feedback.cancel(going, putBack)).toBe("sending");
    });
  });

  it("keeps a cancelled message when its chat closed while its files were read", async () => {
    act(() => watchThread("bot-1", false));
    const held = feedback.sendAttempt(payload());
    act(() => feedback.queue(held));
    putBack.mockReturnValue(false);
    const cancelling = feedback.cancel(held, putBack);
    await act(() => cancelling);
    expect(await cancelling).toBe("kept");
    expect(feedback.unsentSends).toEqual([held]);
    expect(held.state).toBe("queued");
    expect(disk.forget).not.toHaveBeenCalled();
  });

  it("restores saved messages once, alongside one a chat queued before restoring ran", async () => {
    act(() => watchThread("bot-1", false));
    const early = feedback.sendAttempt(payload("Early"));
    act(() => feedback.queue(early));
    const savedCopy: SendAttempt = { ...early, artifactIds: new Map() };
    const other: SendAttempt = { ...feedback.sendAttempt(payload("Saved")), state: "queued" };
    disk.load.mockReturnValueOnce([savedCopy, other]);
    act(() => restoreUnsentSends());
    expect(disk.load).toHaveBeenCalledWith(expect.any(Number), new Set([early.clientNonce]));
    expect(feedback.unsentSends).toEqual([other, early]);
  });

  it("does not cancel a held message the queue started sending after the menu opened", async () => {
    act(() => watchThread("bot-1", false));
    const attempt = feedback.sendAttempt(payload());
    act(() => feedback.queue(attempt));
    let finish!: () => void;
    server.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: "artifact-1" });
        }),
    );
    server.request.mockImplementation(accepts(41));
    act(() => watchThread("bot-1", true));
    await act(async () => undefined);
    expect(attempt.state).toBe("pending");
    await act(async () => {
      expect(await feedback.cancel(attempt, putBack)).toBe("sending");
    });
    expect(feedback.unsentSends).toEqual([attempt]);
    expect(container.textContent).toContain("Sent while offline");
    await act(async () => {
      finish();
      await sendWaitingMessages();
    });
    act(() => confirmEchoes("bot-1", [41]));
    expect(disk.forget).toHaveBeenCalledWith(attempt);
  });

  it("puts a cancelled group message back with its mention chips, so sending it again reaches the same bot", async () => {
    const scout: ComposerMention = { kind: "bot", id: "bot-scout", name: "Scout" };
    const composer = { draft: "check the build", mentions: [scout], skill: null };
    const text = serializeComposerPrompt(composer.draft, composer.skill, composer.mentions);
    const plan = resolveComposerSendPlan({
      text,
      mentions: composer.mentions,
      hasAttachments: false,
    });
    render("group-1");
    act(() => watchThread("group-1", false));
    const attempt = feedback.sendAttempt({
      ...payload(text),
      originThreadKey: "group-1",
      composer,
      initialBotTarget: undefined,
      botTarget: undefined,
      groupTarget: "group-1",
      plan,
      attachments: [],
    });
    act(() => feedback.queue(attempt));
    let cancelled!: SendAttempt;
    const cancelling = feedback.cancel(attempt, (taken) => {
      cancelled = taken;
      return true;
    });
    await act(() => cancelling);
    await cancelling;

    const restored = restoreComposerDraft(
      { draft: "", mentions: [], skill: null },
      cancelled.payload.composer,
    );
    expect(restored).toEqual(composer);
    const again = resolveComposerSendPlan({
      text: serializeComposerPrompt(restored.draft, restored.skill, restored.mentions),
      mentions: restored.mentions,
      hasAttachments: false,
    });
    expect(again.mentionPayload).toEqual(plan.mentionPayload);
    expect(again.mentionPayload).not.toEqual([]);
  });

  it("adds a cancelled message after what the composer already holds without duplicating chips", () => {
    const scout: ComposerMention = { kind: "bot", id: "bot-scout", name: "Scout" };
    const chief: ComposerMention = { kind: "bot", id: "bot-chief", name: "Chief" };
    const skill = {
      id: "skill-1",
      name: "review",
      description: "",
      source: "user",
      readOnly: false,
    } as const;
    expect(
      restoreComposerDraft(
        { draft: "also", mentions: [chief], skill: null },
        { draft: "check the build", mentions: [scout, chief], skill },
      ),
    ).toEqual({ draft: "also\ncheck the build", mentions: [chief, scout], skill });
  });

  it("copies and selects the message from the context menu", () => {
    act(() => watchThread("bot-1", false));
    act(() => feedback.queue(feedback.sendAttempt(payload())));
    act(() => menu("select")!.click());
    expect(selectText).toHaveBeenCalledWith("Hello");
  });

  it("only sends a held message to the server and Space it was written in", async () => {
    act(() => watchThread("bot-1", false));
    const attempt = feedback.sendAttempt(payload());
    act(() => feedback.queue(attempt));
    server.scope = { apiBase: "https://rakazo.example", spaceId: "space-2" };
    server.request.mockImplementation(accepts(41));
    await act(async () => {
      watchThread("bot-1", true);
      await sendWaitingMessages();
    });
    expect(server.request).not.toHaveBeenCalled();
    server.scope = { apiBase: "https://rakazo.example", spaceId: "space-1" };
    await act(() => sendWaitingMessages());
    expect(attempt.acceptedSeq).toBe(41);
  });

  it("keeps messages scoped to their thread and drops a send from a signed-out session", async () => {
    act(() => watchThread("bot-1", false));
    const held = feedback.sendAttempt(payload());
    act(() => feedback.queue(held));
    render("bot-2");
    expect(feedback.unsentSends).toEqual([]);
    expect(container.textContent).toBe("");
    render("bot-1");
    expect(feedback.unsentSends).toEqual([held]);
    act(() => clearUnsentSends());

    act(() => watchThread("bot-1", true));
    let fail!: (error: Error) => void;
    server.request.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const inFlight = feedback.sendAttempt({ ...payload("Another"), attachments: [] });
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(inFlight);
    });
    await act(async () => {
      await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    });
    // Sign out (and in again) while the first request is still out; it then fails as unreachable.
    act(() => clearUnsentSends());
    expect(disk.clear).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
    await act(async () => {
      fail(offline());
      await sending;
    });
    // The one resend would carry the next session's credentials, so it never goes out.
    expect(server.request).toHaveBeenCalledOnce();
    expect(feedback.unsentSends).toEqual([]);
    expect(server.notDelivered).not.toHaveBeenCalled();
  });

  it("holds a send instead of sending it to the Space the app moved to meanwhile", async () => {
    let upload!: () => void;
    server.request.mockImplementation(async (method: string) => {
      if (method === "artifacts/create") {
        await new Promise<void>((resolve) => {
          upload = resolve;
        });
        return { id: "artifact-1" };
      }
      return { seq: 41 };
    });
    const attempt = feedback.sendAttempt(payload());
    let sending!: Promise<boolean>;
    act(() => {
      sending = feedback.send(attempt);
    });
    await act(async () => {
      await vi.waitFor(() => expect(upload).toBeTypeOf("function"));
    });
    server.scope = { apiBase: "https://rakazo.example", spaceId: "space-2" };
    await act(async () => {
      upload();
      expect(await sending).toBe(false);
    });
    expect(server.request.mock.calls.filter(([method]) => method === "threads/send")).toEqual([]);
    expect(attempt.state).toBe("queued");
    server.scope = { apiBase: "https://rakazo.example", spaceId: "space-1" };
    await act(() => sendWaitingMessages());
    expect(attempt.acceptedSeq).toBe(41);
  });

  it("keeps an accepted message's files until it shows up, so Cancel send after the timeout gets them back", async () => {
    vi.useFakeTimers();
    server.request.mockImplementation(accepts(41));
    const attempt = feedback.sendAttempt(payload());
    await send(attempt);
    expect(disk.forget).not.toHaveBeenCalled();
    // Accepted messages aren't resent after a restart.
    expect(disk.save.mock.lastCall?.[0]).not.toContain(attempt);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(attempt.state).toBe("failed");
    const cancelling = feedback.cancel(attempt, putBack);
    await act(() => cancelling);
    expect(await cancelling).toBe("cancelled");
    expect(disk.hydrate).toHaveBeenLastCalledWith(attempt, { forComposer: true });
    expect(disk.forget).toHaveBeenCalledWith(attempt);
    expect(disk.hydrate.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      disk.forget.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("announces every accepted message, held or sent at once, for the screen's follow-up", async () => {
    const delivered = vi.fn();
    const unsubscribe = subscribeDelivered(delivered);
    try {
      server.request.mockImplementation(accepts(41));
      const direct = feedback.sendAttempt({ ...payload("Direct"), attachments: [] });
      await send(direct);
      act(() => watchThread("bot-1", false));
      const held = feedback.sendAttempt({ ...payload("Held"), attachments: [] });
      act(() => feedback.queue(held));
      await act(async () => {
        watchThread("bot-1", true);
        await sendWaitingMessages({ ifIdle: true });
      });
      expect(delivered.mock.calls.map(([attempt]) => attempt)).toEqual([direct, held]);
    } finally {
      unsubscribe();
    }
  });

  it("restores saved messages first and sends them", async () => {
    const saved: SendAttempt = {
      ...feedback.sendAttempt(payload("Saved")),
      state: "queued",
      heldOffline: true,
    };
    disk.load.mockReturnValueOnce([saved]);
    server.request.mockImplementation(accepts(41));
    await act(async () => {
      restoreUnsentSends();
      await sendWaitingMessages();
    });
    expect(server.request).toHaveBeenCalledWith(
      "threads/send",
      expect.objectContaining({ text: "Saved", clientNonce: saved.clientNonce }),
    );
  });

  it("keeps load failures separate from sends and clears them when a refresh reaches the server", () => {
    act(() => feedback.setError("Could not reach the server"));
    expect(feedback.error).toBe("Could not reach the server");
    act(() => feedback.refreshed());
    expect(feedback.error).toBeNull();
    act(() => feedback.setError("Load failed"));
    render("bot-2");
    expect(feedback.error).toBeNull();
    act(() => feedback.setError("Current load failed"));
    act(() => feedback.refreshed("bot-1"));
    expect(feedback.error).toBe("Current load failed");
  });
});

describe("deliverSend", () => {
  it("reuses the frozen target, nonce, routine nonces and uploaded artifact ids, and returns the seq", async () => {
    const frozen = payload();
    frozen.groupTarget = "rerouted-group";
    frozen.botTarget = undefined;
    frozen.reroutedToGroup = true;
    frozen.plan.shouldRunRoutines = true;
    frozen.plan.routineIds = ["routine-1"];
    const attempt = {
      payload: frozen,
      clientNonce: "nonce-x",
      artifactIds: new Map<string, string>(),
    } as SendAttempt;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "artifacts/create") return { id: "artifact-1" };
      if (method === "threads/send") throw new Error("Response lost");
    });
    await expect(deliverSend(frozen, attempt, request)).rejects.toThrow("Response lost");
    request.mockImplementation(async (method: string) =>
      method === "artifacts/create" ? { id: "artifact-2" } : { seq: 7 },
    );
    await expect(deliverSend(frozen, attempt, request)).resolves.toBe(7);
    const sends = request.mock.calls.filter(([method]) => method === "threads/send");
    expect(sends[0]).toEqual(sends[1]);
    expect(sends[1]![1]).toMatchObject({
      groupId: "rerouted-group",
      text: "Hello",
      clientNonce: "nonce-x",
      artifactIds: ["artifact-1"],
    });
    expect(sends[1]![1].replyToMessageId).toBeUndefined();
    const uploads = request.mock.calls.filter(([method]) => method === "artifacts/create");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]![1].clientNonce).toBe("nonce-x:0");
    expect(uploads[0]![2]).toEqual({ timeoutMs: 60_000 });
    const routines = request.mock.calls.filter(([method]) => method === "routines/testRun");
    expect(routines[1]![1].clientNonce).toBe("routine-mention:nonce-x:routine-1");
  });
});
