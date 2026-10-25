import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./rpc", () => {
  // Any procedure path, as the real client exposes; these tests never call one.
  const client = (): unknown => new Proxy(() => undefined, { get: () => client() });
  return {
    rpc: client(),
    createSpaceRpc: client,
    rpcForSpace: client,
    selectedSpaceId: () => null,
  };
});

import { lastChatOf, queryClient, setQueryUser, spaceQueries, spaceSeedKey } from "./query";

afterEach(() => {
  queryClient.clear();
});

describe("query scopes", () => {
  it("keeps every user and space in its own keys", () => {
    const keys = [
      spaceQueries("user-a", "space-a"),
      spaceQueries("user-a", "space-b"),
      spaceQueries("user-b", "space-a"),
      spaceQueries("user-a", null),
    ].map((scope) => JSON.stringify(scope.bootstrap.queryKey({ input: {} })));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never serves one space's cached data to another", () => {
    queryClient.setQueryData(spaceQueries("user-a", "space-a").voice.status.queryKey(), {
      ready: true,
    } as never);
    expect(
      queryClient.getQueryData(spaceQueries("user-a", "space-b").voice.status.queryKey()),
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(spaceQueries("user-b", "space-a").voice.status.queryKey()),
    ).toBeUndefined();
  });

  it("keeps the unselected space's seed apart from every chosen space", () => {
    const keys = [spaceSeedKey("user-a", null), spaceSeedKey("user-a", "space-a")].map((key) =>
      JSON.stringify(key),
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("forgets the cache when a different user signs in or everyone signs out", () => {
    const key = spaceQueries("user-a", "space-a").voice.status.queryKey();
    setQueryUser("user-a");
    queryClient.setQueryData(key, { ready: true } as never);
    setQueryUser("user-a");
    expect(queryClient.getQueryData(key)).toBeDefined();
    setQueryUser(null);
    expect(queryClient.getQueryData(key)).toBeUndefined();
    queryClient.setQueryData(key, { ready: true } as never);
    setQueryUser("user-b");
    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});

describe("lastChatOf", () => {
  const seed = (thread: { botId?: string; groupId?: string } | null) =>
    ({
      bots: [{ id: "bot-a" }],
      groups: [{ id: "group-a" }],
      thread,
    }) as never;

  it("reopens the bot or group chat a cached space was showing", () => {
    expect(lastChatOf(seed({ botId: "bot-a" }))).toEqual({ botId: "bot-a" });
    expect(lastChatOf(seed({ groupId: "group-a", botId: "bot-a" }))).toEqual({
      groupId: "group-a",
    });
  });

  it("falls back when the cached chat is gone or there is no cache", () => {
    expect(lastChatOf(seed({ botId: "bot-gone" }))).toBeUndefined();
    expect(lastChatOf(seed({ groupId: "group-gone" }))).toBeUndefined();
    expect(lastChatOf(seed(null))).toBeUndefined();
    expect(lastChatOf(undefined)).toBeUndefined();
  });
});
