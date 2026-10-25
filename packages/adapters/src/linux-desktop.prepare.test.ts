import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_POLICY, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";

describe("provider desktop preparation", () => {
  it("applies the same browser policy as the computer image", () => {
    const imagePolicy = readFileSync(
      new URL("../../../infra/sandboxes/computer/browser-policy.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(BROWSER_POLICY)).toEqual(JSON.parse(imagePolicy));
  });

  it("installs the emoji font and writes the policy for every Chrome-family browser", () => {
    expect(PREPARE_LINUX_DESKTOP).toContain("fonts-noto-color-emoji");
    for (const dir of [
      "/etc/chromium/policies/managed",
      "/etc/opt/chrome/policies/managed",
      "/etc/brave/policies/managed",
    ]) {
      expect(PREPARE_LINUX_DESKTOP).toContain(dir);
    }
    execFileSync("sh", ["-n", "-c", PREPARE_LINUX_DESKTOP]);
  });
});
