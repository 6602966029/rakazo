import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMe, MobileSnapshot, MobileSpaceNavigation } from "./api";
import type { SavedChatsScope } from "./saved-chats";
import {
  clearSavedChats,
  liveSavedChatsScope,
  loadSavedInbox,
  readSavedInbox,
  readSavedThread,
  refreshSavedChats,
  SAVED_CHAT_MESSAGES,
  SAVED_CHAT_WRITE_DELAY_MS,
  SAVED_CHATS,
  savedChatSignature,
  savedChatsScope,
  savedChatWriter,
  saveInbox,
  writeSavedInbox,
  writeSavedThread,
} from "./saved-chats";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  broken: false,
  current: true,
  verified: null as null | {
    apiBase: string;
    userId: string;
    spaceId: string;
    selectionId: string | null;
  },
  selection: "space-a" as string | null,
  rpc: vi.fn(),
  saveVerified: vi.fn(),
  verifyOnline: vi.fn(),
  reachable: true,
  namespace: "ns-1",
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => state.namespace }));
vi.mock("./api", () => ({
  rpc: state.rpc,
  isServerReachable: () => state.reachable,
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => state.selection,
}));
vi.mock("./integrations-cache", () => ({
  isIntegrationsScopeCurrent: () => state.current,
  integrationsCacheScope: state.verifyOnline,
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  loadSessionToken: async () => "fake-token",
  loadVerifiedIntegrationsScope: async () => state.verified,
  saveVerifiedIntegrationsScope: state.saveVerified,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    get exists() {
      return [...state.files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    create() {}
    delete() {
      for (const path of [...state.files.keys()]) {
        if (path.startsWith(`${this.uri}/`)) state.files.delete(path);
      }
    }
  }
  class File extends Directory {
    override get exists() {
      return state.files.has(this.uri);
    }
    override create() {
      if (state.broken) throw new Error("disk unavailable");
    }
    override delete() {
      state.files.delete(this.uri);
    }
    textSync() {
      return state.files.get(this.uri);
    }
    write(value: string) {
      state.files.set(this.uri, value);
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

const scope: SavedChatsScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  spaceId: "space-a",
  sessionGeneration: 1,
  selectionId: "space-a",
  namespace: "ns-1",
};
const me = {
  userId: "user-a",
  spaceId: "space-a",
  name: "Ada Example",
  email: "ada@example.test",
} as MobileMe;
const bot = {
  id: "bot-a",
  name: "Alpha",
  color: "blue",
  preview: "Hi",
  unread: true,
  pinned: true,
};
const navigation = {
  current: {
    id: "space-a",
    name: "Personal",
    bots: [{ ...bot, instructions: "Private bot instructions", teamChatRules: "Private rules" }],
    groups: [{ id: "group-a", name: "Team", preview: "Yo", members: [], unread: false }],
    externalConversations: [{ id: "external-a", participantNames: ["Private Person"] }],
    botSections: [{ id: "section-a", name: "Work" }],
  },
  spaces: [
    {
      id: "space-a",
      name: "Personal",
      bots: [],
      groups: [],
      externalConversations: [{ id: "external-a", participantNames: ["Private Person"] }],
    },
  ],
} as unknown as MobileSpaceNavigation;
const savedInbox = {
  bots: [bot],
  groups: [{ id: "group-a", name: "Team", preview: "Yo", members: [], unread: false }],
  botSections: [{ id: "section-a", name: "Work" }],
  spaces: [{ id: "space-a", name: "Personal", bots: [], groups: [], externalConversations: [] }],
  me: { userId: "user-a", spaceId: "space-a", name: "Ada Example" },
};

function thread(count: number, botId = "bot-a"): MobileSnapshot {
  return {
    botId,
    threadId: `thread-${botId}`,
    cursor: 42,
    olderCursor: 7,
    run: { id: "run-a", status: "running" },
    activeRuns: [{ id: "run-a", status: "running" }],
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 ? "bot" : "user",
      blocks: [{ kind: "text", text: `message ${index}` }],
    })) as MobileSnapshot["messages"],
  };
}

beforeEach(() => {
  state.files.clear();
  state.broken = false;
  state.current = true;
  state.verified = null;
  state.selection = "space-a";
  state.rpc.mockReset().mockReturnValue(new Promise(() => {}));
  state.saveVerified.mockReset();
  state.reachable = true;
  state.namespace = "ns-1";
  state.verifyOnline.mockReset().mockRejectedValue(new Error("offline"));
});

describe("saved inbox", () => {
  it("round trips only what the inbox shows", () => {
    expect(readSavedInbox(scope)).toBeNull();
    writeSavedInbox(scope, navigation, me);
    expect(readSavedInbox(scope)).toEqual(savedInbox);
    const [contents] = [...state.files.values()];
    expect(contents).not.toContain("Private");
  });

  it("keys files by ids only and never stores the email", () => {
    writeSavedInbox(scope, navigation, me);
    writeSavedThread(scope, "bot:bot-a", thread(2));
    for (const [path, contents] of state.files) {
      expect(path).not.toContain("ada");
      expect(contents).not.toContain("ada@example.test");
      expect(contents).not.toMatch(/token/i);
    }
  });

  it.each([
    { apiBase: "https://other.example.test" },
    { userId: "user-b" },
    { spaceId: "space-b" },
  ])("never reads another scope %j", (change) => {
    writeSavedInbox(scope, navigation, me);
    expect(readSavedInbox({ ...scope, ...change })).toBeNull();
  });
});

// What the inbox passes in: the load's verified scope, before the session namespace is added.
const { namespace: _loadedNamespace, ...loaded } = scope;

const verified = {
  apiBase: scope.apiBase,
  userId: "user-a",
  spaceId: "space-a",
  selectionId: "space-a",
};

describe("saved chats scope", () => {
  it("saves and reads a chat under the Space selected to open it, not the inbox's last one", async () => {
    // The inbox last loaded in space-a; opening a bot from space-b selected space-b first.
    state.verified = verified;
    state.selection = "space-b";
    const opened = (await savedChatsScope())!;
    expect(opened).toEqual({ ...scope, spaceId: "space-b", selectionId: "space-b" });
    writeSavedThread(opened, "bot:bot-b", thread(2, "bot-b"));
    expect(readSavedThread(opened, "bot:bot-b")?.messages).toHaveLength(2);
    expect(readSavedThread(scope, "bot:bot-b")).toBeNull();
  });

  it("asks the server who the user is when a live chat has no verified identity yet", async () => {
    // Right after sign-in or a password change, before the inbox has verified the new session.
    expect(await savedChatsScope()).toBeNull();
    const { namespace: _namespace, ...online } = scope;
    state.verifyOnline.mockResolvedValue(online);
    expect(await liveSavedChatsScope()).toEqual(scope);
    state.verified = verified;
    state.verifyOnline.mockClear();
    expect(await liveSavedChatsScope()).toEqual(scope);
    expect(state.verifyOnline).not.toHaveBeenCalled();
  });

  it("never reads what an earlier session of the same account left behind", async () => {
    // A wipe failed; signing in again rotates the namespace, so the old files are unreachable.
    state.verified = verified;
    writeSavedThread((await savedChatsScope())!, "bot:bot-a", thread(2));
    writeSavedInbox((await savedChatsScope())!, navigation, me);
    state.namespace = "ns-2";
    const next = (await savedChatsScope())!;
    expect(next.namespace).toBe("ns-2");
    expect(readSavedThread(next, "bot:bot-a")).toBeNull();
    expect(await loadSavedInbox()).toBeNull();
  });

  it("falls back to the verified default Space before any Space was selected", async () => {
    state.verified = { ...verified, selectionId: null };
    state.selection = null;
    expect((await savedChatsScope())?.spaceId).toBe("space-a");
    state.verified = verified;
    expect(await savedChatsScope()).toBeNull();
  });
});

describe("inbox hydrate and save", () => {
  it("hydrates the saved inbox from the persisted scope before any request answers", async () => {
    writeSavedInbox(scope, navigation, me);
    state.verified = verified;
    expect(await loadSavedInbox()).toEqual(readSavedInbox(scope));
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("hydrates nothing without a verified scope or after the session changed", async () => {
    writeSavedInbox(scope, navigation, me);
    expect(await loadSavedInbox()).toBeNull();
    state.verified = { ...verified, apiBase: "https://other.example.test" };
    expect(await loadSavedInbox()).toBeNull();
    state.verified = verified;
    state.current = false;
    expect(await loadSavedInbox()).toBeNull();
  });

  it("saves a load with its verified identity, and drops one from a changed session", async () => {
    saveInbox(loaded, navigation, me);
    await vi.waitFor(() => expect(readSavedInbox(scope)).toEqual(savedInbox));
    expect(state.saveVerified).toHaveBeenCalledWith(1, {
      apiBase: scope.apiBase,
      userId: "user-a",
      spaceId: "space-a",
      selectionId: "space-a",
    });
    // The 5 s inbox poll saves the identity once, not on every load.
    saveInbox(loaded, navigation, me);
    expect(state.saveVerified).toHaveBeenCalledTimes(1);
    state.files.clear();
    state.current = false;
    saveInbox(loaded, navigation, me);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.files.size).toBe(0);
  });

  it("brings a saved chat up to date after an inbox load, never an unsaved one", async () => {
    writeSavedThread(scope, "bot:bot-a", thread(1));
    state.rpc.mockResolvedValue(thread(4));
    saveInbox(loaded, navigation, me);
    await vi.waitFor(() => expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(4));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("threads/get", { botId: "bot-a" });
  });
});

describe("saved chats", () => {
  it("keeps the last 100 messages, display-only", () => {
    writeSavedThread(scope, "bot:bot-a", thread(SAVED_CHAT_MESSAGES + 20));
    const saved = readSavedThread(scope, "bot:bot-a")!;
    expect(saved.messages).toHaveLength(SAVED_CHAT_MESSAGES);
    expect(saved.messages[0]!.id).toBe("m-20");
    expect(saved.messages.at(-1)!.id).toBe(`m-${SAVED_CHAT_MESSAGES + 19}`);
    expect(saved.olderCursor).toBeNull();
    expect(saved.run).toBeNull();
    expect(saved).not.toHaveProperty("cursor");
    expect(saved).not.toHaveProperty("activeRuns");
    const [contents] = [...state.files.values()].filter((value) => value.includes("thread-"));
    expect(JSON.parse(contents!).snapshot).not.toHaveProperty("cursor");
  });

  it("evicts the chat written longest ago past 40 chats and deletes its file", () => {
    for (let index = 0; index < SAVED_CHATS; index++) {
      writeSavedThread(scope, `bot:bot-${index}`, thread(1, `bot-${index}`));
    }
    // Writing bot-0 again makes bot-1 the oldest.
    writeSavedThread(scope, "bot:bot-0", thread(2, "bot-0"));
    writeSavedThread(scope, "group:group-x", {
      ...thread(1),
      botId: undefined,
      groupId: "group-x",
    });
    expect(readSavedThread(scope, "bot:bot-1")).toBeNull();
    expect([...state.files.keys()].some((path) => path.includes("bot%3Abot-1."))).toBe(false);
    expect(readSavedThread(scope, "bot:bot-0")?.messages).toHaveLength(2);
    expect(readSavedThread(scope, "bot:bot-2")).not.toBeNull();
    expect(readSavedThread(scope, "group:group-x")).not.toBeNull();
    const chatFiles = [...state.files.keys()].filter((path) => !path.endsWith("index.json"));
    expect(chatFiles).toHaveLength(SAVED_CHATS);
  });

  it.each([
    ["server", { apiBase: "https://other.example.test" }],
    ["user", { userId: "user-b" }],
    ["space", { spaceId: "space-b" }],
  ])("is a miss, not a partial hydrate, when the %s differs", (_part, change) => {
    writeSavedThread(scope, "bot:bot-a", thread(3));
    writeSavedInbox(scope, navigation, me);
    const other = { ...scope, ...change };
    // Plant this scope's files at the other scope's paths: the key inside must still match.
    for (const [path, contents] of [...state.files]) {
      const moved = path
        .replace(encodeURIComponent(scope.apiBase), encodeURIComponent(other.apiBase))
        .replace(`user-${scope.userId}`, `user-${other.userId}`)
        .replace(`space-${scope.spaceId}`, `space-${other.spaceId}`);
      state.files.set(moved, contents);
    }
    expect(readSavedThread(other, "bot:bot-a")).toBeNull();
    expect(readSavedInbox(other)).toBeNull();
  });

  it("is a miss when the chat differs, even with the file in its place", () => {
    writeSavedThread(scope, "bot:bot-a", thread(3));
    const [path, contents] = [...state.files].find(([key]) => key.includes("bot%3Abot-a"))!;
    state.files.set(path.replace("bot-a", "bot-b"), contents);
    expect(readSavedThread(scope, "bot:bot-b")).toBeNull();
  });

  it("treats corrupt files and disk failures as misses", () => {
    writeSavedThread(scope, "bot:bot-a", thread(1));
    const [path] = [...state.files.keys()].filter((key) => key.includes("bot%3Abot-a"));
    state.files.set(path!, "{");
    expect(readSavedThread(scope, "bot:bot-a")).toBeNull();
    state.broken = true;
    expect(() => writeSavedThread(scope, "bot:bot-a", thread(1))).not.toThrow();
    expect(() => writeSavedInbox(scope, navigation, me)).not.toThrow();
  });

  it("clears everything", () => {
    writeSavedInbox(scope, navigation, me);
    writeSavedThread(scope, "bot:bot-a", thread(1));
    clearSavedChats();
    expect(state.files.size).toBe(0);
    expect(readSavedInbox(scope)).toBeNull();
  });
});

describe("background refresh", () => {
  it("re-fetches only saved chats whose row changed", async () => {
    writeSavedThread(scope, "bot:bot-a", thread(1));
    const load = vi.fn(async (target: { botId: string } | { groupId: string }) =>
      thread(3, "botId" in target ? target.botId : target.groupId),
    );
    const rows = [
      { target: "bot:bot-a", signature: savedChatSignature({ updatedAt: "t1", preview: "Hi" }) },
      { target: "bot:bot-new", signature: savedChatSignature({ updatedAt: "t1", preview: "Hi" }) },
    ];
    await refreshSavedChats(scope, rows, load, () => true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ botId: "bot-a" });
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(3);
    expect(readSavedThread(scope, "bot:bot-new")).toBeNull();

    await refreshSavedChats(scope, rows, load, () => true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps newer messages the open chat saved while a background answer was loading", async () => {
    writeSavedThread(scope, "bot:bot-a", thread(1));
    let answer!: (snapshot: MobileSnapshot) => void;
    const refreshing = refreshSavedChats(
      scope,
      [{ target: "bot:bot-a", signature: "changed" }],
      () => new Promise((resolve) => (answer = resolve)),
      () => true,
    );
    await vi.waitFor(() => expect(answer).toBeDefined());
    writeSavedThread(scope, "bot:bot-a", thread(5));
    answer(thread(2));
    await refreshing;
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(5);
  });

  it("doesn't download an unchanged chat again after the open chat saved it", async () => {
    const signature = savedChatSignature({ updatedAt: "t1", preview: "Hi" });
    writeSavedThread(scope, "bot:bot-a", thread(1), signature);
    writeSavedThread(scope, "bot:bot-a", thread(2));
    const load = vi.fn(async () => thread(3));
    await refreshSavedChats(scope, [{ target: "bot:bot-a", signature }], load, () => true);
    expect(load).not.toHaveBeenCalled();
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(2);
  });

  it("skips a chat that fails to load and refreshes the rest, but stops in an outage", async () => {
    writeSavedThread(scope, "bot:bot-gone", thread(1, "bot-gone"));
    writeSavedThread(scope, "bot:bot-a", thread(1));
    const rows = [
      { target: "bot:bot-gone", signature: "changed" },
      { target: "bot:bot-a", signature: "changed" },
    ];
    const load = vi.fn(async (target: { botId: string } | { groupId: string }) => {
      if ("botId" in target && target.botId === "bot-gone") throw new Error("Bot not found");
      return thread(3);
    });
    await refreshSavedChats(scope, rows, load, () => true);
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(3);

    writeSavedThread(scope, "bot:bot-a", thread(1));
    state.reachable = false;
    load.mockClear();
    const later = rows.map((row) => ({ ...row, signature: "changed again" }));
    await refreshSavedChats(scope, later, load, () => true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(1);
  });

  it("drops a result that returns after the session changed", async () => {
    writeSavedThread(scope, "bot:bot-a", thread(1));
    await refreshSavedChats(
      scope,
      [{ target: "bot:bot-a", signature: "changed" }],
      async () => thread(3),
      () => false,
    );
    expect(readSavedThread(scope, "bot:bot-a")?.messages).toHaveLength(1);
  });
});

describe("chat writes", () => {
  it("coalesces stream updates into one write after they settle, and flushes on leave", () => {
    vi.useFakeTimers();
    try {
      const writer = savedChatWriter();
      const writes: number[] = [];
      for (let update = 1; update <= 5; update++) {
        writer.schedule(() => writes.push(update));
        vi.advanceTimersByTime(SAVED_CHAT_WRITE_DELAY_MS - 1);
      }
      expect(writes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(writes).toEqual([5]);
      writer.schedule(() => writes.push(6));
      writer.flush();
      writer.flush();
      vi.runAllTimers();
      expect(writes).toEqual([5, 6]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("app wiring", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("deletes saved chats and downloaded previews with every session change", () => {
    const layout = read("../app/_layout.tsx");
    expect(layout).toContain("registerSessionDiskCache(clearSavedChats);");
    expect(layout).toContain("registerSessionDiskCache(clearArtifactPreviews);");
  });

  it("never tells an inbox that hasn't loaded yet to create a bot", () => {
    const inbox = read("../app/index.tsx");
    const empty = inbox.slice(
      inbox.indexOf("ListEmptyComponent={"),
      inbox.indexOf("ListFooterComponent={"),
    );
    expect(empty).toMatch(/me\s*\?\s*t\("Tap \+ to create a bot"\)\s*:\s*null/);
    // The bar takes the inbox error line's place at the top of the list, never under the
    // iOS 26 bottom search bar.
    const header = inbox.slice(
      inbox.indexOf("ListHeaderComponent={"),
      inbox.indexOf("ListEmptyComponent={"),
    );
    expect(header).toContain("<ConnectionBar");
    // The home bar only says chats are saved once the inbox has rows to show.
    expect(inbox).toContain("saved={me !== null}");
    // The saved inbox is applied only until the first live load.
    expect(inbox).toMatch(/if \(cancelled \|\| !saved \|\| inboxLoaded\.current\) return;/);
  });
});
