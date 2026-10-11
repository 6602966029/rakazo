import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  appState: new Set<(state: string) => void>(),
  token: "session-token" as string | null,
  reachable: true,
  generation: 0,
  apiBase: "https://rakazo.example",
  identity: null as null | { apiBase: string; userId: string; cacheSession: string },
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      h.appState.add(listener);
      return { remove: () => h.appState.delete(listener) };
    },
  },
}));
vi.mock("./api", () => ({
  currentApiBase: () => h.apiBase,
  isServerReachable: () => h.reachable,
  rpc: vi.fn(),
  selectedSpaceId: () => "space-1",
  subscribeServerReachable: (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./outbox-disk", () => ({ outboxDisk: { clear: vi.fn() } }));
vi.mock("./session", () => ({
  loadSessionToken: vi.fn(async () => h.token),
  loadSessionIdentity: vi.fn(async () => (h.token ? h.identity : null)),
  currentSessionIdentity: () => h.identity,
  currentSessionGeneration: () => h.generation,
}));
vi.mock("./thread-feedback", () => ({
  configureUnsentSends: vi.fn(),
  restoreUnsentSends: vi.fn(),
  sendWaitingMessages: vi.fn(async () => undefined),
}));
vi.mock("./user-error", () => ({ errorText: (_error: unknown, fallback: string) => fallback }));
vi.mock("./focus-prompt", () => ({ cancelFocusPrompt: vi.fn() }));

const { outboxDisk } = await import("./outbox-disk");
const { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } = await import(
  "./thread-feedback"
);
const { startUnsentSends, prepareUnsentSends } = await import("./unsent-sends");
const { Alert } = await import("react-native");
const { cancelFocusPrompt } = await import("./focus-prompt");

describe("unsent sends", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.token = "session-token";
    h.reachable = true;
    h.generation = 0;
    h.apiBase = "https://rakazo.example";
    h.identity = { apiBase: "https://rakazo.example", userId: "user-1", cacheSession: "cache-1" };
  });

  it("waits for cached identity before releasing a draft to the outbox", async () => {
    h.identity = null;
    const { loadSessionIdentity } = await import("./session");
    let finish!: () => void;
    vi.mocked(loadSessionIdentity).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.identity = { apiBase: "https://rakazo.example", userId: "user-1", cacheSession: "cache-1" };
      return h.identity;
    });
    const ready = prepareUnsentSends();
    expect(restoreUnsentSends).not.toHaveBeenCalled();
    finish();
    await ready;
    expect(restoreUnsentSends).toHaveBeenCalledOnce();
  });
  it("does not release a draft when identity verification is offline", async () => {
    h.identity = null;
    const { rpc } = await import("./api");
    vi.mocked(rpc).mockRejectedValueOnce(new TypeError("Network request failed"));
    await expect(prepareUnsentSends()).rejects.toThrow("Network request failed");
    expect(restoreUnsentSends).not.toHaveBeenCalled();
  });
  it("does not restart notifications with an old bearer after a server/session change", async () => {
    const { loadSessionToken } = await import("./session");
    const { resumeLiveNotifications } = await import("./live-notifications");
    let finish!: (token: string) => void;
    vi.mocked(loadSessionToken).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startUnsentSends();
    const config = vi.mocked(configureUnsentSends).mock.calls[0]![0];
    config.delivered({ payload: {} } as Parameters<typeof config.delivered>[0]);
    h.apiBase = "https://other.example";
    h.generation++;
    finish("fake-old-token");
    await Promise.resolve();
    await Promise.resolve();
    expect(resumeLiveNotifications).not.toHaveBeenCalled();
    stop();
  });
  it("cancels the bot's focus prompt once a message to it is delivered, held or not", () => {
    const stop = startUnsentSends();
    const config = vi.mocked(configureUnsentSends).mock.calls[0]![0];
    config.delivered({
      payload: { initialBotTarget: "bot-1" },
    } as Parameters<typeof config.delivered>[0]);
    expect(cancelFocusPrompt).toHaveBeenCalledWith("bot-1");
    stop();
  });

  it("shows real send errors in a system alert", () => {
    const stop = startUnsentSends();
    const config = vi.mocked(configureUnsentSends).mock.calls[0]![0];
    config.notDelivered({ error: "Bot is archived" } as Parameters<typeof config.notDelivered>[0]);
    expect(Alert.alert).toHaveBeenCalledWith("Failed to send message", "Bot is archived");
    stop();
  });

  it("sends waiting messages when the server answers again and when the app returns", async () => {
    const stop = startUnsentSends();
    expect(configureUnsentSends).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(restoreUnsentSends).toHaveBeenCalledOnce());
    expect(sendWaitingMessages).not.toHaveBeenCalled();

    h.reachable = false;
    for (const listener of h.listeners) listener();
    expect(sendWaitingMessages).not.toHaveBeenCalled();
    h.reachable = true;
    for (const listener of h.listeners) listener();
    // Sending's own requests flip reachability, so this one never asks a running send to repeat.
    expect(sendWaitingMessages).toHaveBeenLastCalledWith({ ifIdle: true });
    for (const listener of h.appState) listener("background");
    expect(sendWaitingMessages).toHaveBeenCalledTimes(1);
    for (const listener of h.appState) listener("active");
    expect(sendWaitingMessages).toHaveBeenCalledTimes(2);
    expect(sendWaitingMessages).toHaveBeenLastCalledWith();

    stop();
    expect(h.listeners.size).toBe(0);
    expect(h.appState.size).toBe(0);
  });

  it("deletes a saved outbox instead of restoring it when nobody is signed in", async () => {
    h.token = null;
    const stop = startUnsentSends();
    await vi.waitFor(() => expect(outboxDisk.clear).toHaveBeenCalledOnce());
    expect(restoreUnsentSends).not.toHaveBeenCalled();
    stop();
  });
});
