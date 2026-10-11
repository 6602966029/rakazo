import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api";
import { savedChatTarget } from "./saved-chats";

vi.mock("expo-file-system", () => ({}));
vi.mock("./api", () => ({}));
vi.mock("./integrations-cache", () => ({}));
vi.mock("./session", () => ({}));
vi.mock("./artifact-cache-session", () => ({}));

// Exercise the screen's handlers without importing its native dependencies.
const source = readFileSync(new URL("../app/thread.tsx", import.meta.url), "utf8");
const handlers = ts.transpileModule(
  `${source.slice(
    source.indexOf("  function showSavedThread("),
    source.indexOf("  async function applyMessageJump("),
  )}\nreturn { showSavedThread, saveThread, refresh };`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function snapshot(ids: string[], botId = "bot-a"): MobileSnapshot {
  return {
    botId,
    threadId: `thread-${botId}`,
    olderCursor: null,
    run: null,
    messages: ids.map((id) => ({ id, role: "bot", blocks: [{ kind: "text", text: id }] })),
  } as MobileSnapshot;
}

function screen(options: { messageId?: string; onScreen?: MobileSnapshot } = {}) {
  const saved = snapshot(["saved-1", "saved-2"]);
  const fetched = new Promise<MobileSnapshot>(() => {});
  const scope = {
    botId: "bot-a",
    groupId: undefined,
    messageId: options.messageId,
    snapRef: { current: options.onScreen ?? null },
    commitSnap: vi.fn((next: MobileSnapshot) => {
      scope.snapRef.current = next;
    }),
    setShowingSaved: vi.fn(),
    savedChatsScope: vi.fn(
      async (): Promise<{ apiBase: string; selectionId: string | null } | null> => ({
        apiBase: "https://api.example.test",
        selectionId: "space-a",
      }),
    ),
    liveSavedChatsScope: vi.fn(
      async (): Promise<{
        apiBase: string;
        selectionId: string | null;
        sessionGeneration: number;
        userId: string;
      } | null> => ({
        apiBase: "https://api.example.test",
        selectionId: "space-a",
        sessionGeneration: 1,
        userId: "user-a",
      }),
    ),
    isIntegrationsScopeCurrent: () => true,
    readSavedThread: vi.fn(() => saved),
    writeSavedThread: vi.fn(),
    savedChatTarget,
    rpc: vi.fn(() => fetched),
    currentSessionGeneration: () => 1,
    selectedSpaceId: () => "space-a",
    snapshotOrigin: {
      current: null as null | {
        apiBase: string;
        userId: string;
        selectionId: string | null;
        sessionGeneration: number;
      },
    },
    refreshGeneration: { current: 0 },
    historyEpoch: { current: 0 },
    activeBotId: { current: "bot-a" },
    activeGroupId: { current: undefined },
    expandedHistoryThread: { current: null as string | null },
    mobileThreadRefreshResult: ({ fetched }: { fetched: MobileSnapshot }) => ({
      commit: true,
      snapshot: fetched,
    }),
    mergeMobileSnapshot: vi.fn(
      (_previous: unknown, next: MobileSnapshot, _keepHistory: boolean) => next,
    ),
    isCurrentTarget: () => true,
    feedback: { refreshed: vi.fn() },
  };
  const { showSavedThread, saveThread, refresh } = new Function(...Object.keys(scope), handlers)(
    ...Object.values(scope),
  );
  return { scope, saved, showSavedThread, saveThread, refresh };
}

describe("bot roster offline", () => {
  const roster = ts.transpileModule(
    `${source.slice(
      source.indexOf("  const refreshMentionBots = useCallback("),
      source.indexOf("  }, [botId, groupId, router]);") + "  }, [botId, groupId, router]);".length,
    )}\nreturn refreshMentionBots;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  function load(options: { bots: () => Promise<unknown>; applied?: number }) {
    let mentionBots: unknown[] = [];
    const scope = {
      botId: "bot-a",
      groupId: undefined,
      router: { setParams: vi.fn() },
      useCallback: (callback: unknown) => callback,
      mentionBotsRefreshGeneration: { current: 0 },
      mentionBotsAppliedGeneration: { current: options.applied ?? 0 },
      activeBotId: { current: "bot-a" },
      routeName: { current: "Alpha" },
      rpc: vi.fn(options.bots),
      retainUnchangedBotRoster: (_current: unknown, next: unknown[]) => next,
      setMentionBots: (update: (current: unknown[]) => unknown[]) => {
        mentionBots = update(mentionBots);
      },
      loadSavedInbox: async () => ({ bots: [{ id: "bot-a", color: "violet" }] }),
    };
    const refresh = new Function(...Object.keys(scope), roster)(...Object.values(scope));
    return { refresh, bots: () => mentionBots };
  }

  it("uses the bots saved with the inbox until the server answers", async () => {
    const offline = load({ bots: async () => Promise.reject(new Error("offline")) });
    await offline.refresh();
    expect(offline.bots()).toEqual([{ id: "bot-a", color: "violet" }]);
  });

  it("keeps a roster the server already sent", async () => {
    const stale = load({ bots: async () => Promise.reject(new Error("offline")), applied: 1 });
    await stale.refresh();
    expect(stale.bots()).toEqual([]);
  });
});

/** Waits until the scope lookup ran and its continuation finished. */
async function settled(lookup: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
  await lookup.mock.results.at(-1)!.value;
  await Promise.resolve();
}

describe("saved chat on open", () => {
  it("restarts the guarded stream after session replacement", () => {
    expect(source).toContain("useSyncExternalStore(");
    expect(source).toContain("subscribeSessionGeneration,");
    expect(source).toContain("refreshMentionBots, sessionEpoch]");
  });

  it("hides retained messages until they belong to the rendered session", () => {
    const start = source.indexOf("  const snap = snapshotOrigin.current?");
    const end = source.indexOf("  const streamResponses", start);
    const visible = new Function(
      "snapshotOrigin",
      "sessionEpoch",
      "loadedSnap",
      `${source.slice(start, end)}return snap;`,
    );
    const privateMessages = snapshot(["private"]);
    expect(visible({ current: { sessionGeneration: 0 } }, 1, privateMessages)).toBeNull();
    expect(visible({ current: { sessionGeneration: 1 } }, 1, privateMessages)).toBe(
      privateMessages,
    );
  });

  it.each(["same", "user", "server"])(
    "retains loaded history only for the same owner (%s)",
    async (change) => {
      const { scope, refresh } = screen({ onScreen: snapshot(["older"]) });
      scope.snapshotOrigin.current = {
        apiBase: change === "server" ? "https://other.example" : "https://api.example.test",
        userId: change === "user" ? "user-b" : "user-a",
        selectionId: "space-a",
        sessionGeneration: 0,
      };
      scope.expandedHistoryThread.current = "thread-bot-a";
      scope.rpc.mockResolvedValue(snapshot(["latest"]));
      await refresh();
      expect(scope.mergeMobileSnapshot).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        change === "same",
      );
    },
  );

  it("shows the saved messages before the server answers", async () => {
    const { scope, saved, showSavedThread, refresh } = screen();
    void refresh();
    showSavedThread(new AbortController().signal);
    await vi.waitFor(() => expect(scope.commitSnap).toHaveBeenCalledWith(saved));
    expect(scope.setShowingSaved).toHaveBeenCalledWith(true);
    expect(scope.rpc).toHaveBeenCalledWith("threads/get", { botId: "bot-a" });
  });

  it("lets live data replace the saved copy", async () => {
    const { scope, showSavedThread, refresh } = screen();
    showSavedThread(new AbortController().signal);
    await vi.waitFor(() => expect(scope.setShowingSaved).toHaveBeenCalledWith(true));
    const live = snapshot(["live-1"]);
    scope.rpc.mockResolvedValueOnce(live);
    await refresh();
    expect(scope.snapRef.current).toBe(live);
    expect(scope.setShowingSaved).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["live data for this chat is already on screen", { onScreen: snapshot(["live-1"]) }],
    ["the chat opens at a search hit", { messageId: "message-9" }],
  ])("keeps the screen when %s", async (_case, options) => {
    const { scope, showSavedThread } = screen(options);
    showSavedThread(new AbortController().signal);
    await settled(scope.savedChatsScope);
    expect(scope.commitSnap).not.toHaveBeenCalled();
    expect(scope.setShowingSaved).not.toHaveBeenCalled();
  });

  it("replaces the previous chat's messages after switching bots", async () => {
    const { scope, saved, showSavedThread } = screen({ onScreen: snapshot(["b-1"], "bot-b") });
    showSavedThread(new AbortController().signal);
    await vi.waitFor(() => expect(scope.commitSnap).toHaveBeenCalledWith(saved));
  });

  it("never leaves the previous chat's messages under a chat with nothing saved", async () => {
    const { scope, showSavedThread } = screen({ onScreen: snapshot(["b-1"], "bot-b") });
    scope.readSavedThread.mockReturnValue(null as unknown as MobileSnapshot);
    showSavedThread(new AbortController().signal);
    expect(scope.commitSnap).toHaveBeenCalledWith(null);
    expect(scope.setShowingSaved).toHaveBeenCalledWith(false);
    await settled(scope.savedChatsScope);
    expect(scope.snapRef.current).toBeNull();
  });

  it("saves with the identity verified after the chat opened", async () => {
    const { scope, showSavedThread, saveThread } = screen();
    // Nothing verified yet when the chat opens; the inbox verifies it a moment later.
    scope.savedChatsScope.mockResolvedValueOnce(null);
    showSavedThread(new AbortController().signal);
    await settled(scope.savedChatsScope);
    const live = snapshot(["live-1"]);
    saveThread("bot:bot-a", live, {
      sessionGeneration: 1,
      selectionId: "space-a",
      apiBase: "https://api.example.test",
      userId: "user-a",
    });
    await settled(scope.liveSavedChatsScope);
    expect(scope.writeSavedThread).toHaveBeenCalledWith(
      expect.objectContaining({ selectionId: "space-a" }),
      "bot:bot-a",
      live,
    );
  });

  it("doesn't save under a Space selected after the chat's own", async () => {
    const { scope, saveThread } = screen();
    saveThread("bot:bot-a", snapshot(["live-1"]), {
      sessionGeneration: 1,
      selectionId: "space-b",
      apiBase: "https://api.example.test",
      userId: "user-a",
    });
    await settled(scope.liveSavedChatsScope);
    expect(scope.writeSavedThread).not.toHaveBeenCalled();
  });

  it.each(["user", "server"])(
    "rejects a delayed write from another %s even with the same epoch",
    async (change) => {
      const { scope, saveThread } = screen();
      saveThread("bot:bot-a", snapshot(["private"]), {
        sessionGeneration: 1,
        selectionId: "space-a",
        apiBase: change === "server" ? "https://other.example" : "https://api.example.test",
        userId: change === "user" ? "user-b" : "user-a",
      });
      await settled(scope.liveSavedChatsScope);
      expect(scope.writeSavedThread).not.toHaveBeenCalled();
    },
  );

  it("drops a pending write from a session that has since ended", async () => {
    // A sign-out or server switch wiped the folder; the old token still verifies for a moment.
    const { scope, saveThread } = screen();
    saveThread("bot:bot-a", snapshot(["live-1"]), {
      sessionGeneration: 0,
      selectionId: "space-a",
      apiBase: "https://api.example.test",
      userId: "user-a",
    });
    await settled(scope.liveSavedChatsScope);
    expect(scope.writeSavedThread).not.toHaveBeenCalled();
  });

  it("says the saved copy couldn't refresh instead of the raw error", () => {
    expect(source).toContain(
      `{showingSaved ? t("Couldn't refresh — showing the last loaded messages.") : error}`,
    );
  });
});
