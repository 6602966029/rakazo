import { expect, it, vi } from "vitest";
import { createThreadHeaderStyles } from "../components/thread-header-styles";
import { HEADER_CONTROL_SIZE } from "./native-controls";
import { threadHeaderOptions } from "./thread-header";

const platform = vi.hoisted(() => ({ OS: "ios", Version: 26 as number | string }));

vi.mock("react-native", () => ({
  Platform: platform,
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({ background: "background", border: "border", card: "card" }),
}));

it("sizes the chat title like the header buttons beside it", () => {
  const { titleCapsule } = createThreadHeaderStyles();
  expect(titleCapsule.minHeight).toBe(HEADER_CONTROL_SIZE);
  expect(titleCapsule).not.toHaveProperty("paddingVertical");
});

it.each([27, "27.0", "27.0.1", 28])(
  "keeps the inverted transcript out from under the native header on iOS %s",
  (version) => {
    platform.OS = "ios";
    platform.Version = version;
    for (const background of ["light-background", "dark-background"]) {
      expect(threadHeaderOptions(background)).toEqual({
        headerTransparent: false,
        headerStyle: { backgroundColor: background },
      });
    }
  },
);

it.each([26, "26.1"])("preserves the floating header on iOS %s", (version) => {
  platform.OS = "ios";
  platform.Version = version;
  expect(threadHeaderOptions("background")).toEqual({
    headerTransparent: true,
    headerStyle: { backgroundColor: "transparent" },
  });
});

it.each([
  ["ios", "18.2"],
  ["android", 36],
] as const)("keeps the solid header on %s %s", (os, version) => {
  platform.OS = os;
  platform.Version = version;
  expect(threadHeaderOptions("background")).toEqual({
    headerTransparent: false,
    headerStyle: { backgroundColor: "background" },
  });
});
