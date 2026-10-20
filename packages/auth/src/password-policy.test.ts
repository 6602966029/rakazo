import { hashPassword } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";

// Better Auth's real routes and hashing over its offline memory adapter.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter: (prisma: { authData: Record<string, unknown[]> }) =>
      memoryAdapter(prisma.authData),
  };
});
vi.mock("@rakazo/db", () => ({ bootstrapUserSpace: vi.fn(async () => ({ spaceId: "space-1" })) }));

const baseURL = "http://auth.example.test";
const webOrigin = "http://web.example.test";
const strongPassword = "offline-password-1234";

function fixture({ breachedPasswordCheck = false } = {}) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const prisma = {
    authData: data,
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        signupsEnabled: true,
        signupAllowlist: "",
        signupPolicyInitialized: true,
      })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ spaceId: "space-1" })) },
  };
  const log = vi.fn();
  const auth = createAuth(prisma as never, {
    secret: "offline-auth-secret-at-least-32-characters",
    baseURL,
    webOrigin,
    signupsEnabled: "true",
    signupAllowlist: "",
    breachedPasswordCheck,
    logger: { level: "error", log },
  });
  const request = (path: string, body: unknown, token?: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: webOrigin,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const signup = (password: string) =>
    request("/sign-up/email", { email: "ada@example.test", password, name: "Ada" });
  return { data, request, signup, log };
}

/** A Have I Been Pwned range response listing `password` as breached. */
async function pwnedRange(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  const hex = Buffer.from(digest).toString("hex").toUpperCase();
  return `${hex.slice(5)}:42\r\n0000000000000000000000000000000000A:0`;
}

afterEach(() => vi.unstubAllGlobals());

describe("password length", () => {
  it("rejects new passwords shorter than 12 characters", async () => {
    const f = fixture();
    const short = await f.signup("elevenchars");
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect((await f.signup("twelve-chars")).status).toBe(200);
  });

  it("rejects a short new password on change", async () => {
    const f = fixture();
    const { token } = (await (await f.signup(strongPassword)).json()) as { token: string };
    const change = await f.request(
      "/change-password",
      { currentPassword: strongPassword, newPassword: "too-short" },
      token,
    );
    expect(change.status).toBe(400);
    expect(await change.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
  });

  it("still signs in an existing account whose password predates the minimum", async () => {
    const f = fixture();
    const now = new Date();
    f.data.user!.push({
      id: "legacy-user",
      email: "legacy@example.test",
      name: "Legacy",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    f.data.account!.push({
      id: "legacy-account",
      userId: "legacy-user",
      accountId: "legacy-user",
      providerId: "credential",
      password: await hashPassword("eight-ch"),
      createdAt: now,
      updatedAt: now,
    });
    const signin = await f.request("/sign-in/email", {
      email: "legacy@example.test",
      password: "eight-ch",
    });
    expect(signin.status).toBe(200);
  });
});

describe("breached password check", () => {
  it("never contacts the breach service unless enabled", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await fixture().signup(strongPassword)).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a breached new password and sends only a hash prefix", async () => {
    const fetch = vi.fn(async () => new Response(await pwnedRange(strongPassword)));
    vi.stubGlobal("fetch", fetch);
    const f = fixture({ breachedPasswordCheck: true });
    const signup = await f.signup(strongPassword);
    expect(signup.status).toBe(400);
    expect(await signup.json()).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    const url = String((fetch.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    expect(url).not.toContain(strongPassword);
  });

  it("accepts a password the service does not list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(await pwnedRange("some-other-password"))),
    );
    expect((await fixture({ breachedPasswordCheck: true }).signup(strongPassword)).status).toBe(
      200,
    );
  });

  it("fails open and logs when the service is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const f = fixture({ breachedPasswordCheck: true });
    expect((await f.signup(strongPassword)).status).toBe(200);
    expect(f.log).toHaveBeenCalledWith(
      "error",
      "Breached password check unavailable",
      expect.anything(),
    );
  });

  it("does not check passwords at sign-in", async () => {
    const f = fixture({ breachedPasswordCheck: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("")),
    );
    expect((await f.signup(strongPassword)).status).toBe(200);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const signin = await f.request("/sign-in/email", {
      email: "ada@example.test",
      password: strongPassword,
    });
    expect(signin.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});
