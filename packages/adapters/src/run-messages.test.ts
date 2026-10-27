import { describe, expect, it } from "vitest";
import { redactBlocks } from "./run-messages.js";

describe("redactBlocks", () => {
  it("redacts working notes kept with tool steps", () => {
    expect(
      redactBlocks(
        [
          {
            kind: "steps",
            steps: [{ label: "Shell", count: 1 }],
            notes: ["Logging in with fake-secret-value."],
          },
        ],
        ["fake-secret-value"],
      ),
    ).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", count: 1 }],
        notes: ["Logging in with [redacted]."],
      },
    ]);
  });
});
