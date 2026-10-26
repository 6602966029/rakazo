import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { UserDevicePairRequest } from "@rakazo/adapters/user-device-protocol";
import { USER_DEVICE_PAIR_PATH, USER_DEVICE_PATH } from "@rakazo/adapters/user-device-protocol";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/** OS-backed encryption (Electron safeStorage in the app). */
export interface DeviceTokenCipher {
  available(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

const MAX_TOKEN_FILE_BYTES = 8 * 1024;
const MAX_TOKEN_LENGTH = 1024;

function tokenFile(userDataDir: string, origin: string) {
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return path.join(userDataDir, "devices", `${key}.json`);
}

/** The device token for one server origin, or null when none is stored or it cannot be read. */
export async function readDeviceToken(
  userDataDir: string,
  origin: string,
  cipher: DeviceTokenCipher,
): Promise<string | null> {
  const raw = await readPrivateFile(tokenFile(userDataDir, origin), MAX_TOKEN_FILE_BYTES);
  if (raw === null) return null;
  try {
    const saved = JSON.parse(raw);
    if (saved?.origin !== origin || typeof saved.token !== "string") return null;
    const token = await cipher.decrypt(Buffer.from(saved.token, "base64"));
    return token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : null;
  } catch {
    return null;
  }
}

export async function saveDeviceToken(
  userDataDir: string,
  origin: string,
  token: string,
  cipher: DeviceTokenCipher,
): Promise<void> {
  if (!(await cipher.available())) throw new Error("Secure storage is unavailable");
  const file = tokenFile(userDataDir, origin);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const encrypted = (await cipher.encrypt(token)).toString("base64");
  await writePrivateFile(file, JSON.stringify({ origin, token: encrypted }));
}

export async function deleteDeviceToken(userDataDir: string, origin: string): Promise<void> {
  await rm(tokenFile(userDataDir, origin), { force: true });
}

/** The name people know this computer by. */
export async function deviceName(platform = process.platform): Promise<string> {
  const fallback = hostname().replace(/\.local$/, "") || "Computer";
  if (platform !== "darwin") return fallback.slice(0, 128);
  const friendly = await new Promise<string>((resolve) => {
    execFile("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }, (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    );
  });
  return (friendly || fallback).slice(0, 128);
}

export type DeviceAccessResult = "allowed" | "cancelled" | "signed-out" | "failed";

/**
 * Lets bots on a remote server use this computer. Only `request`, after the native consent
 * prompt, pairs a device; the token stays in the main process and app-private storage.
 */
export function createUserDeviceAccess(deps: {
  userDataDir: string;
  cipher: DeviceTokenCipher;
  device: () => Promise<UserDevicePairRequest>;
  /** The native consent prompt. Resolves true only when the person clicks Allow. */
  confirm: (host: string) => Promise<boolean>;
  /** Fetch with the app window's session (its cookies) for the given server. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  connect: (origin: string, token: string, onRevoked: () => void) => { close(): void };
  onChange: () => void;
}) {
  let current: string | null = null;
  let generation = 0;
  let client: { origin: string; close(): void } | undefined;
  let requesting = false;
  const paired = new Set<string>();

  function disconnect() {
    client?.close();
    client = undefined;
  }

  function start(origin: string, token: string) {
    disconnect();
    const active = { origin, close: () => connection.close() };
    // Revoked by the server or its token was rejected: forget it so access must be granted again.
    const connection = deps.connect(origin, token, () => {
      if (client === active) client = undefined;
      paired.delete(origin);
      void deleteDeviceToken(deps.userDataDir, origin).catch(() => undefined);
      deps.onChange();
    });
    client = active;
  }

  return {
    /** Whether the current server may use this computer. */
    isAllowed: () => current !== null && paired.has(current),
    /** Switches to a server origin (or none), connecting when it was allowed before. */
    async select(origin: string | null) {
      if (origin === current) return;
      const selection = ++generation;
      disconnect();
      current = origin;
      if (origin === null) return;
      const token = await readDeviceToken(deps.userDataDir, origin, deps.cipher);
      if (selection !== generation) return;
      if (token) {
        paired.add(origin);
        start(origin, token);
      } else paired.delete(origin);
      deps.onChange();
    },
    async request(): Promise<DeviceAccessResult> {
      const origin = current;
      if (origin === null || requesting) return "cancelled";
      if (paired.has(origin)) return "allowed";
      requesting = true;
      try {
        if (!(await deps.cipher.available())) return "failed";
        if (!(await deps.confirm(new URL(origin).host)) || current !== origin) return "cancelled";
        let token: string;
        try {
          const response = await deps.fetch(new URL(USER_DEVICE_PAIR_PATH, origin).href, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(await deps.device()),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            return response.status === 401 ? "signed-out" : "failed";
          }
          const body = (await response.json()) as { token?: unknown };
          if (
            typeof body?.token !== "string" ||
            body.token.length === 0 ||
            body.token.length > MAX_TOKEN_LENGTH
          )
            return "failed";
          token = body.token;
        } catch {
          return "failed";
        }
        try {
          await saveDeviceToken(deps.userDataDir, origin, token, deps.cipher);
        } catch {
          // A token that cannot be kept must not stay valid on the server.
          await revokeToken(origin, token);
          return "failed";
        }
        paired.add(origin);
        if (current === origin) start(origin, token);
        deps.onChange();
        return "allowed";
      } finally {
        requesting = false;
      }
    },
    /** Stops access for the current server, locally even when the server cannot be reached. */
    async revoke() {
      const origin = current;
      if (origin === null) return;
      if (client?.origin === origin) disconnect();
      paired.delete(origin);
      const token = await readDeviceToken(deps.userDataDir, origin, deps.cipher);
      try {
        await deleteDeviceToken(deps.userDataDir, origin);
      } finally {
        deps.onChange();
        if (token) await revokeToken(origin, token);
      }
    },
    close() {
      ++generation;
      current = null;
      disconnect();
    },
  };

  async function revokeToken(origin: string, token: string) {
    try {
      const response = await deps.fetch(new URL(`${USER_DEVICE_PATH}/self`, origin).href, {
        method: "DELETE",
        credentials: "omit",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
    } catch {
      /* The local token is deleted regardless. */
    }
  }
}

export type UserDeviceAccess = ReturnType<typeof createUserDeviceAccess>;
