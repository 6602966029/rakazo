import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("fails when the package index cannot be updated", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "rakazo-prepare-"));
    try {
      const calls = path.join(bin, "calls");
      // No novnc directory exists on test hosts, so setup always needs apt.
      writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n');
      writeFileSync(
        path.join(bin, "apt-get"),
        `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ "$1" != update ]\n`,
      );
      chmodSync(path.join(bin, "sudo"), 0o755);
      chmodSync(path.join(bin, "apt-get"), 0o755);
      const result = spawnSync("sh", ["-c", PREPARE_LINUX_DESKTOP], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(readFileSync(calls, "utf8").trim()).toBe("update -qq");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
