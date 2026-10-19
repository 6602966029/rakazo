import { describe, expect, it } from "vitest";
import { parseAllowlist, platformModelAllowed } from "./signup-policy.js";

describe("platform model allowlist", () => {
  it.each([
    [undefined, "user@example.test", false, true],
    ["  ", "user@example.test", false, true],
    ["other@example.test", "user@example.test", true, true],
    ["USER@example.test", "user@EXAMPLE.test", false, true],
    ["@EXAMPLE.test", "USER@example.test", false, true],
    ["@example.test", "user@sub.example.test", false, false],
    ["other@example.test", "user@example.test", false, false],
  ])("checks %s for %s (owner %s)", (raw, email, isOwner, allowed) => {
    expect(platformModelAllowed({ allowlist: parseAllowlist(raw), email, isOwner })).toBe(allowed);
  });
});
