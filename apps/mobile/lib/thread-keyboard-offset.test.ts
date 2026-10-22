import { describe, expect, it } from "vitest";
import { threadKeyboardOffset } from "./thread-keyboard-offset";

describe("threadKeyboardOffset", () => {
  // Before iOS 26 the chat header is opaque, so the chat starts below it. The avoiding view
  // reads its own frame relative to that origin and needs the header height to line up with
  // the keyboard. Without it the keyboard covers the composer.
  it("offsets by the native header on iOS before 26", () => {
    expect(
      threadKeyboardOffset({
        os: "ios",
        floatingHeader: false,
        nativeHeaderHeight: 103,
        measuredOffset: 0,
      }),
    ).toBe(103);
  });

  // From iOS 26 the header floats over the chat, which starts at the top of the screen.
  it("does not offset on iOS 26 and later, where the header floats", () => {
    expect(
      threadKeyboardOffset({
        os: "ios",
        floatingHeader: true,
        nativeHeaderHeight: 116,
        measuredOffset: 0,
      }),
    ).toBe(0);
  });

  it("uses the measured window position on Android", () => {
    expect(
      threadKeyboardOffset({
        os: "android",
        floatingHeader: false,
        nativeHeaderHeight: 64,
        measuredOffset: 88,
      }),
    ).toBe(88);
  });
});
