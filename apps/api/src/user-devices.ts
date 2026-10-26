import type { UserDeviceHub, UserDevices } from "@rakazo/adapters";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  USER_DEVICE_DISCONNECT_PATH,
  USER_DEVICE_FORWARD_PATH,
  USER_DEVICE_LIMIT,
  userDeviceForwardBody,
  validUserDeviceForwardSecret,
} from "@rakazo/adapters";
import type { UserDevicePairResponse } from "@rakazo/adapters/user-device-protocol";
import {
  USER_DEVICE_CONNECT_PATH,
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
  userDevicePairRequest,
} from "@rakazo/adapters/user-device-protocol";
import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

const FORWARD_BODY_MAX_BYTES = 13 * 1024 * 1024;

export interface UserDeviceRouteDeps {
  prisma: PrismaClient;
  hub: UserDeviceHub;
  devices: UserDevices;
  forwardSecret: string;
  /** The signed-in user of a request, or null. */
  sessionUserId: (request: Request) => Promise<string | null>;
  trustedOrigin: (origin: string) => boolean;
}

/**
 * Pairing, listing and revoking a user's own computers, plus the internal endpoints other
 * processes forward device requests through. The socket itself is upgraded by the hub.
 */
export function mountUserDeviceRoutes(app: Hono, deps: UserDeviceRouteDeps) {
  const { prisma } = deps;
  app.use(`${USER_DEVICE_PATH}/*`, async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.post(USER_DEVICE_PAIR_PATH, async (c) => {
    // The desktop main process sends no Origin. A JSON content type forces a CORS preflight,
    // so a cross-site page cannot pair with the user's cookie either way.
    const origin = c.req.header("origin");
    if (origin && !deps.trustedOrigin(origin)) return c.json({ error: "Forbidden" }, 403);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Expected JSON" }, 415);
    const userId = await deps.sessionUserId(c.req.raw);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 4096);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDevicePairRequest.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid device" }, 400);
    const token = createUserDeviceToken();
    const device = await runAsSystem("pair a user device", async () => {
      const active = await prisma.userDevice.count({ where: { userId, revokedAt: null } });
      if (active >= USER_DEVICE_LIMIT) return null;
      return prisma.userDevice.create({
        data: {
          userId,
          name: input.data.name,
          platform: input.data.platform,
          tokenHash: hashUserDeviceToken(token),
        },
        select: { id: true },
      });
    });
    if (!device) return c.json({ error: "Remove a computer before adding another" }, 409);
    await recordSecurityEvent({
      type: "device.paired",
      userId,
      metadata: { deviceId: device.id, platform: input.data.platform },
    });
    return c.json({ deviceId: device.id, token } satisfies UserDevicePairResponse, 201);
  });

  app.get(USER_DEVICE_PATH, async (c) => {
    const userId = await deps.sessionUserId(c.req.raw);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const [devices, connected] = await Promise.all([
      runAsSystem("list a user's devices", () =>
        prisma.userDevice.findMany({
          where: { userId, revokedAt: null },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, platform: true, createdAt: true, lastSeenAt: true },
        }),
      ),
      deps.devices.connected(userId),
    ]);
    return c.json({
      devices: devices.map((device) => ({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
        createdAt: device.createdAt.toISOString(),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
        connected: connected?.deviceId === device.id,
      })),
    });
  });

  // A plain request to the socket path: the hub upgrades real connections before Hono sees them.
  app.get(USER_DEVICE_CONNECT_PATH, (c) => c.json({ error: "Upgrade required" }, 426));

  const revoke = async (deviceId: string, userId: string, by: "owner" | "device") => {
    const { count } = await runAsSystem("revoke a user device", () =>
      prisma.userDevice.updateMany({
        where: { id: deviceId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    if (!count) return false;
    await recordSecurityEvent({ type: "device.revoked", userId, metadata: { deviceId, by } });
    await deps.devices.disconnect(deviceId);
    return true;
  };

  // Registered before `:deviceId` so "self" is never read as an id.
  app.delete(`${USER_DEVICE_PATH}/self`, async (c) => {
    const device = await deps.hub.authenticate(c.req.header("authorization"));
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    await revoke(device.id, device.userId, "device");
    return c.body(null, 204);
  });

  app.delete(`${USER_DEVICE_PATH}/:deviceId`, async (c) => {
    const userId = await deps.sessionUserId(c.req.raw);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const revoked = await revoke(c.req.param("deviceId"), userId, "owner");
    return revoked ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  });

  app.post(USER_DEVICE_FORWARD_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, FORWARD_BODY_MAX_BYTES);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    const input = userDeviceForwardBody.safeParse(parseJson(body));
    if (!input.success) return c.json({ error: "Invalid request" }, 400);
    const { request, ...route } = input.data;
    return deps.hub.stream(route, request, c.req.raw.signal);
  });

  app.post(USER_DEVICE_DISCONNECT_PATH, async (c) => {
    if (!validUserDeviceForwardSecret(deps.forwardSecret, c.req.header("authorization")))
      return c.json({ error: "Unauthorized" }, 401);
    const body = await readBoundedBody(c.req.raw, 1024);
    const deviceId = (parseJson(body ?? "") as { deviceId?: unknown } | undefined)?.deviceId;
    if (typeof deviceId !== "string") return c.json({ error: "Invalid request" }, 400);
    deps.hub.disconnect(deviceId);
    return c.body(null, 204);
  });
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
