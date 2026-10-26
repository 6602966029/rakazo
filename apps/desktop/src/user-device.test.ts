import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceTokenCipher } from "./user-device.js";
import {
  createUserDeviceAccess,
  deleteDeviceToken,
  readDeviceToken,
  saveDeviceToken,
} from "./user-device.js";

const origin = "https://rakazo.example.com";
const other = "https://other.example.com";

// Reversible stand-in for OS encryption that still keeps the plaintext off disk.
const cipher: DeviceTokenCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(value.split("").reverse().join("")),
  decrypt: async (value) => value.toString().split("").reverse().join(""),
};

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "rakazo-device-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("device token storage", () => {
  it("keeps one encrypted, owner-only token per server origin", async () => {
    await saveDeviceToken(userData, origin, "secret-token", cipher);
    await saveDeviceToken(userData, other, "other-token", cipher);
    expect(await readDeviceToken(userData, origin, cipher)).toBe("secret-token");
    expect(await readDeviceToken(userData, other, cipher)).toBe("other-token");
    const dir = path.join(userData, "devices");
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      expect(await readFile(file, "utf8")).not.toContain("secret-token");
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
    }
    await deleteDeviceToken(userData, origin);
    expect(await readDeviceToken(userData, origin, cipher)).toBeNull();
    expect(await readDeviceToken(userData, other, cipher)).toBe("other-token");
  });

  it("refuses to store a token without secure storage and ignores undecryptable ones", async () => {
    await expect(
      saveDeviceToken(userData, origin, "t", { ...cipher, available: async () => false }),
    ).rejects.toThrow();
    expect(await readDeviceToken(userData, origin, cipher)).toBeNull();
    await saveDeviceToken(userData, origin, "t", cipher);
    expect(
      await readDeviceToken(userData, origin, {
        ...cipher,
        decrypt: async () => {
          throw new Error("locked");
        },
      }),
    ).toBeNull();
  });
});

describe("remote computer access", () => {
  function setup(overrides: Partial<Parameters<typeof createUserDeviceAccess>[0]> = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    const clients: { origin: string; token: string; closed: boolean; revoke: () => void }[] = [];
    const access = createUserDeviceAccess({
      userDataDir: userData,
      cipher,
      device: async () => ({ name: "Test Mac", platform: "darwin" }),
      confirm: async () => true,
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith("/api/devices/pair"))
          return Response.json({ deviceId: "device-1", token: "device-token" });
        return new Response(null, { status: 204 });
      },
      connect: (serverOrigin, token, onRevoked) => {
        const client = { origin: serverOrigin, token, closed: false, revoke: onRevoked };
        clients.push(client);
        return {
          close: () => {
            client.closed = true;
          },
        };
      },
      onChange: () => undefined,
      ...overrides,
    });
    return { access, requests, clients };
  }

  it("pairs with the window session only after the native prompt allows it, then connects", async () => {
    const confirm = vi.fn(async () => true);
    const { access, requests, clients } = setup({ confirm });
    await access.select(origin);
    expect(access.isAllowed()).toBe(false);
    expect(clients).toEqual([]);
    expect(await access.request()).toBe("allowed");
    expect(confirm).toHaveBeenCalledWith("rakazo.example.com");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${origin}/api/devices/pair`);
    expect(requests[0]!.init).toMatchObject({ method: "POST", credentials: "include" });
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      name: "Test Mac",
      platform: "darwin",
    });
    expect(clients).toMatchObject([{ origin, token: "device-token", closed: false }]);
    expect(access.isAllowed()).toBe(true);
    expect(await readDeviceToken(userData, origin, cipher)).toBe("device-token");
  });

  it("does nothing when the prompt is cancelled or the server changes behind it", async () => {
    const { access, requests } = setup({ confirm: async () => false });
    await access.select(origin);
    expect(await access.request()).toBe("cancelled");
    let switchDuringPrompt: (() => Promise<void>) | undefined;
    const second = setup({
      confirm: async () => {
        await switchDuringPrompt?.();
        return true;
      },
    });
    await second.access.select(origin);
    switchDuringPrompt = () => second.access.select(other);
    expect(await second.access.request()).toBe("cancelled");
    expect([...requests, ...second.requests]).toEqual([]);
    expect(await readDeviceToken(userData, origin, cipher)).toBeNull();
  });

  it("reports a signed-out session and never prompts without secure storage", async () => {
    const signedOut = setup({ fetch: async () => new Response(null, { status: 401 }) });
    await signedOut.access.select(origin);
    expect(await signedOut.access.request()).toBe("signed-out");
    expect(signedOut.clients).toEqual([]);
    const confirm = vi.fn(async () => true);
    const noStorage = setup({ confirm, cipher: { ...cipher, available: async () => false } });
    await noStorage.access.select(origin);
    expect(await noStorage.access.request()).toBe("failed");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("reconnects on launch, disconnects when switching servers, and stops on close", async () => {
    await saveDeviceToken(userData, origin, "saved-token", cipher);
    const { access, clients } = setup();
    await access.select(origin);
    expect(clients).toMatchObject([{ origin, token: "saved-token", closed: false }]);
    await access.select(other);
    expect(clients[0]!.closed).toBe(true);
    expect(access.isAllowed()).toBe(false);
    expect(clients).toHaveLength(1);
    await access.select(origin);
    expect(clients).toHaveLength(2);
    access.close();
    expect(clients[1]!.closed).toBe(true);
  });

  it("revokes on the server and always forgets the token locally", async () => {
    await saveDeviceToken(userData, origin, "saved-token", cipher);
    const { access, requests, clients } = setup({
      fetch: async (url, init) => {
        requests.push({ url, init });
        throw new Error("offline");
      },
    });
    await access.select(origin);
    await access.revoke();
    expect(clients[0]!.closed).toBe(true);
    expect(access.isAllowed()).toBe(false);
    expect(await readDeviceToken(userData, origin, cipher)).toBeNull();
    expect(requests).toMatchObject([
      {
        url: `${origin}/api/devices/self`,
        init: {
          method: "DELETE",
          credentials: "omit",
          headers: { authorization: "Bearer saved-token" },
        },
      },
    ]);
  });

  it("forgets a token the server revoked", async () => {
    await saveDeviceToken(userData, origin, "saved-token", cipher);
    const onChange = vi.fn();
    const { access, clients } = setup({ onChange });
    await access.select(origin);
    clients[0]!.revoke();
    expect(access.isAllowed()).toBe(false);
    expect(onChange).toHaveBeenCalled();
    await vi.waitFor(async () =>
      expect(await readDeviceToken(userData, origin, cipher)).toBeNull(),
    );
  });
});
