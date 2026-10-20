import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { BoatSandboxEmulator } from "./boat-emulator.js";

const context = {
  operationId: "boat-emulator-test",
  traceId: "boat-emulator-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("Boat emulator", () => {
  it("rate limits starts beyond the account quota", async () => {
    const boat = new BoatSandboxEmulator({ startLimit: 1 });
    await expect(
      boat.provision({ botId: "bot-1", homePath: "/home" }, context),
    ).resolves.toMatchObject({ kind: "boat" });
    await expect(
      boat.provision({ botId: "bot-2", homePath: "/home" }, context),
    ).rejects.toBeInstanceOf(SandboxRateLimitError);
  });
});
