import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { observeExtraDisplayCommand, parseExtraDisplayObservation } from "./extra-displays.js";

const run = promisify(execFile);

/** Fake X tools: scrot writes its display name slowly, so overlapping calls interleave. */
function fakeTools() {
  const bin = mkdtempSync(path.join(tmpdir(), "rakazo-observe-bin-"));
  writeFileSync(
    path.join(bin, "scrot"),
    '#!/bin/sh\nfor i in 1 2 3 4 5; do printf "%s" "$DISPLAY" >> "$2"; sleep 0.05; done\n',
  );
  writeFileSync(path.join(bin, "xdotool"), "#!/bin/sh\necho X=12\necho Y=34\n");
  for (const tool of ["scrot", "xdotool"]) chmodSync(path.join(bin, tool), 0o755);
  return bin;
}

describe("observing an extra display", () => {
  it("keeps overlapping screenshots of one display apart and removes them", async () => {
    const bin = fakeTools();
    const observe = (display: string) =>
      run("sh", ["-c", observeExtraDisplayCommand({ display, displayNumber: 7 })], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
    const before = readdirSync("/tmp/rakazo", { withFileTypes: true }).length;
    const [first, second] = await Promise.all([observe(":a"), observe(":b")]);
    for (const [output, display] of [
      [first.stdout, ":a"],
      [second.stdout, ":b"],
    ] as const) {
      const observed = parseExtraDisplayObservation(output);
      expect(Buffer.from(observed.image).toString()).toBe(display.repeat(5));
      expect(observed.cursor).toEqual({ x: 12, y: 34 });
    }
    expect(readdirSync("/tmp/rakazo", { withFileTypes: true }).length).toBe(before);
  });
});
