import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactCacheSession } from "./artifact-cache-session";
import { AVATAR_STYLE_KEY, getCachedAvatarStyle, saveAvatarStyle } from "./avatar-style.js";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionIdentity,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
  restoreSessionToken,
  saveAvatarStyleIfCurrent,
  saveSessionIdentity,
  saveSessionToken,
  saveVerifiedIntegrationsScope,
  snapshotSessionToken,
  tokenFromAuthResponse,
} from "./session.js";
import { clearUnsentSends } from "./thread-feedback.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./thread-feedback.js", () => ({ clearUnsentSends: vi.fn() }));

describe("mobile session storage", () => {
  beforeEach(async () => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await restoreSessionToken("");
  });

  it("hides the previous bearer while a replacement token is being stored", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("fake-old-token");
    let finish!: () => void;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const saving = saveSessionToken("fake-new-token");
    expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
    finish();
    await saving;
  });

  it("rejects a token read that finishes after the session changes", async () => {
    let finish!: (token: string) => void;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const reading = snapshotSessionToken();
    await saveSessionToken("fake-new-token");
    finish("fake-old-token");
    expect(await reading).toEqual({ ok: true, value: "" });
  });

  it("stores and clears only the session token key", async () => {
    await saveSessionToken("secret-token");
    await clearSessionToken();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "secret-token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.session_token");
  });

  it("rotates the artifact namespace on session save, clear and restore", async () => {
    await saveSessionToken("fake-cache-token");
    let previous = await artifactCacheSession("fake-cache-token");
    for (const change of [
      () => saveSessionToken("fake-cache-token"),
      () => clearSessionToken(),
      () => restoreSessionToken("fake-cache-token"),
    ]) {
      await change();
      const next = await artifactCacheSession("fake-cache-token");
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("wipes the outbox on sign-out, sign-in and session restore", async () => {
    for (const change of [
      () => clearSessionToken(),
      () => saveSessionToken("fake-next-session"),
      () => restoreSessionToken(""),
    ]) {
      vi.mocked(clearUnsentSends).mockClear();
      await change();
      expect(clearUnsentSends).toHaveBeenCalled();
    }
  });

  it("forgets the cached avatar style on sign-out", async () => {
    await saveAvatarStyle("organic");
    await clearSessionToken();

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(AVATAR_STYLE_KEY);
    expect(getCachedAvatarStyle()).toBe("robot");
  });

  it("ignores an avatar style response from a session that was cleared", async () => {
    const generation = currentSessionGeneration();
    await clearSessionToken();
    vi.mocked(SecureStore.setItemAsync).mockClear();

    await expect(saveAvatarStyleIfCurrent(generation, "organic")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(AVATAR_STYLE_KEY, "organic");
    expect(getCachedAvatarStyle()).toBe("robot");
  });

  it("does not let an in-flight style write land after sign-out", async () => {
    const disk = new Map<string, string>();
    let releaseWrite: () => void = () => undefined;
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === AVATAR_STYLE_KEY) await write;
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });

    try {
      const generation = currentSessionGeneration();
      const saving = saveAvatarStyleIfCurrent(generation, "organic");
      await Promise.resolve();
      const clearing = clearSessionToken();
      releaseWrite();
      await saving;
      await clearing;

      expect(disk.has(AVATAR_STYLE_KEY)).toBe(false);
      expect(getCachedAvatarStyle()).toBe("robot");
    } finally {
      releaseWrite();
      vi.mocked(SecureStore.setItemAsync).mockReset();
      vi.mocked(SecureStore.deleteItemAsync).mockReset();
    }
  });

  it("still clears the session when the avatar style cannot be wiped", async () => {
    const disk = new Map<string, string>();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await saveAvatarStyle("organic");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === AVATAR_STYLE_KEY) throw new Error("device locked");
      disk.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === AVATAR_STYLE_KEY) throw new Error("device locked");
      disk.set(key, value);
    });

    try {
      await expect(clearSessionToken()).resolves.toBe(true);
      expect(disk.has("rakazo.session_token")).toBe(false);
      expect(disk.get(AVATAR_STYLE_KEY)).toBe("organic");
    } finally {
      vi.mocked(SecureStore.setItemAsync).mockReset();
      vi.mocked(SecureStore.deleteItemAsync).mockReset();
    }
  });

  it("overwrites the token when SecureStore delete fails", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.session_token") throw new Error("device locked");
    });
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.session_token", "");
  });

  it("invalidates the in-memory session when SecureStore cannot clear the token", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("secret-token");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when secure storage is empty or unavailable", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(loadSessionToken()).resolves.toBe("");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadSessionToken()).resolves.toBe("");

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(1, "rakazo.session_token");
    expect(SecureStore.getItemAsync).toHaveBeenNthCalledWith(2, "rakazo.session_token");
  });

  it("restores the active session in memory when persistence is unavailable", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await restoreSessionToken("secret-token");
    await expect(loadSessionToken()).resolves.toBe("secret-token");
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "secret-token" });

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("distinguishes an unreadable token store from an empty session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));

    await expect(snapshotSessionToken()).resolves.toEqual({ ok: false });
  });
});

describe("auth response token parsing", () => {
  it("prefers explicit JSON tokens, including nested session responses", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=cookie-token; Path=/" },
    });

    expect(tokenFromAuthResponse(response, { token: "body-token" })).toBe("body-token");
    expect(tokenFromAuthResponse(response, { session: { token: "nested-token" } })).toBe(
      "nested-token",
    );
  });

  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "falls back to and decodes the %s cookie",
    (name) => {
      const response = new Response(null, {
        headers: { "set-cookie": `${name}=abc%2F123%3D; Path=/; HttpOnly` },
      });

      expect(tokenFromAuthResponse(response, {})).toBe("abc/123=");
    },
  );

  it("finds a secure session after another Set-Cookie value", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie":
          "other=value; Path=/, __Secure-better-auth.session_token=secure-token; Path=/; HttpOnly",
      },
    });

    expect(tokenFromAuthResponse(response, {})).toBe("secure-token");
  });

  it("rejects unrelated cookies and malformed response bodies", () => {
    const unrelated = new Response(null, {
      headers: { "set-cookie": "notbetter-auth.session_token=attacker; Path=/" },
    });
    const malformed = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=bad%ZZ; Path=/" },
    });
    expect(tokenFromAuthResponse(unrelated, { token: 123 })).toBe("");
    expect(tokenFromAuthResponse(unrelated, null)).toBe("");
    expect(tokenFromAuthResponse(malformed, {})).toBe("");
  });
});

describe("verified integration session scope", () => {
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  };
  let disk: Map<string, string>;
  beforeEach(async () => {
    disk = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => disk.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await restoreSessionToken("");
    await saveSessionToken("fake-session-a");
  });
  it("binds cached identity to the exact bearer and server", async () => {
    await saveSessionIdentity(currentSessionGeneration(), scope);
    expect(await loadSessionIdentity(scope.apiBase)).toMatchObject({
      userId: scope.userId,
      apiBase: scope.apiBase,
    });
    expect(await loadSessionIdentity("https://other.example.test")).toBeNull();
    disk.set("rakazo.session_token", "fake-session-b");
    expect(await loadSessionIdentity(scope.apiBase)).toBeNull();
  });
  it.each(["sign-out", "sign-in", "restore"])(
    "invalidates cached identity on %s even if deletion fails",
    async (change) => {
      await saveSessionIdentity(currentSessionGeneration(), scope);
      vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("storage unavailable"));
      if (change === "sign-out") await clearSessionToken();
      if (change === "sign-in") await saveSessionToken("fake-session-a");
      if (change === "restore") await restoreSessionToken("fake-session-a");
      expect(await loadSessionIdentity(scope.apiBase)).toBeNull();
    },
  );
  it("loads the scope only for the exact stored session", async () => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    expect(await loadVerifiedIntegrationsScope()).toEqual(scope);
    disk.set("rakazo.session_token", "fake-session-b");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
  it.each(["sign-out", "replacement", "restore"])("invalidates the scope on %s", async (change) => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    if (change === "sign-out") await clearSessionToken();
    if (change === "replacement") await saveSessionToken("fake-session-a");
    if (change === "restore") await restoreSessionToken("fake-session-a");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("rejects a late verification after session replacement", async () => {
    const generation = currentSessionGeneration();
    await saveSessionToken("fake-session-b");
    await saveVerifiedIntegrationsScope(generation, scope);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("serializes an in-flight scope write before sign-out deletes it", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.integrations-scope") await pending;
      disk.set(key, value);
    });
    const saving = saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    await Promise.resolve();
    await Promise.resolve();
    const clearing = clearSessionToken();
    release();
    await Promise.all([saving, clearing]);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
  it("treats malformed stored scopes as misses", async () => {
    await saveVerifiedIntegrationsScope(currentSessionGeneration(), scope);
    disk.set("rakazo.integrations-scope", "{");
    expect(await loadVerifiedIntegrationsScope()).toBeNull();
  });
});
