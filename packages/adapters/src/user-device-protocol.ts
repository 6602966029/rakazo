import { z } from "zod";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import { hostComputerRequest } from "./host-computer-protocol.js";

/**
 * A user's own desktop, connected outbound from the desktop app so bots on a remote server can
 * run commands there. Only runs started by the device's owner may reach it.
 */
export const USER_DEVICE_PAIR_PATH = "/api/devices/pair";
export const USER_DEVICE_CONNECT_PATH = "/api/devices/connect";
/** Owner-session revoke: DELETE `${USER_DEVICE_PATH}/:deviceId`. Device-token self revoke: DELETE `${USER_DEVICE_PATH}/self`. */
export const USER_DEVICE_PATH = "/api/devices";

export const userDevicePairRequest = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["darwin", "win32", "linux"]),
});
export type UserDevicePairRequest = z.infer<typeof userDevicePairRequest>;
export interface UserDevicePairResponse {
  deviceId: string;
  /** Shown once. The server keeps only its hash. */
  token: string;
}

/** Server to device over the connect socket. */
export const userDeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    request: hostComputerRequest,
  }),
  z.object({ type: z.literal("cancel"), id: z.string().min(1).max(64) }),
  z.object({ type: z.literal("revoked") }),
]);
export type UserDeviceServerMessage = z.infer<typeof userDeviceServerMessage>;

/** Device to server: one HostComputerFrame per message, tagged with the request id. */
export const userDeviceClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),
]);
export type UserDeviceClientMessage = z.infer<typeof userDeviceClientMessage>;

export interface UserDevice {
  deviceId: string;
  name: string;
  platform: string;
}

/** How runs reach the requesting user's connected device, from any API or worker process. */
export interface UserDeviceGateway {
  /** The user's connected device, or null when the desktop app is not connected. */
  connected(userId: string): Promise<UserDevice | null>;
  /**
   * Streams HostComputerFrame values for one request. Throws when the device is offline,
   * revoked, or disconnects mid-request; a command is never retried after a lost response.
   * Pass `deviceId` to keep every request of one operation on the same computer.
   */
  request<T>(
    userId: string,
    request: HostComputerRequest,
    signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T>;
}
