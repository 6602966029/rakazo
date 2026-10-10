// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeldSendsDivider } from "../components/held-sends-divider";
import { SendProgress } from "../components/send-progress";

const h = vi.hoisted(() => ({
  reduced: false,
  repeats: 0,
}));

type Props = {
  children?: ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  onPress?: () => void;
  style?: unknown;
};

vi.mock("react-native", () => ({
  View: ({ children, accessibilityLabel, accessibilityRole }: Props) =>
    createElement("div", { "aria-label": accessibilityLabel, role: accessibilityRole }, children),
  Text: ({ children }: Props) => createElement("span", null, children),
  Pressable: ({ children, onPress, accessibilityRole }: Props) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, role: accessibilityRole },
      children,
    ),
  StyleSheet: { hairlineWidth: 0.5 },
}));
vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  return {
    default: { View: () => createElement("i", { "data-segment": true }) },
    Easing: { linear: "linear" },
    useAnimatedStyle: (style: () => unknown) => style(),
    useReducedMotion: () => h.reduced,
    useSharedValue: (value: number) => useState(() => ({ value }))[0],
    withRepeat: (value: number) => {
      h.repeats += 1;
      return value;
    },
    withTiming: (value: number) => value,
  };
});
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

let root: Root;
let container: HTMLDivElement;
function render(node: ReactNode) {
  act(() => root.render(node));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  h.reduced = false;
  h.repeats = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("send progress", () => {
  it("appears only once a send has taken 2 s, as an unlabelled bar announced as Sending", () => {
    render(<SendProgress since={Date.now()} />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1_999));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Sending");
    expect(bar.textContent).toBe("");
    expect(h.repeats).toBe(1);
  });

  it("hides again when the send it times moves to a newer one that is still quick", () => {
    render(<SendProgress since={Date.now() - 5_000} />);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    render(<SendProgress since={Date.now()} />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it("shows at once for a send that started long ago, and holds still with Reduce Motion", () => {
    h.reduced = true;
    render(<SendProgress since={Date.now() - 5_000} />);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(h.repeats).toBe(0);
  });
});

describe("held sends divider", () => {
  it("reads as a header that says why the messages are waiting", () => {
    render(<HeldSendsDivider />);
    const divider = container.querySelector('[role="header"]')!;
    expect(divider.getAttribute("aria-label")).toBe(
      "Messages waiting to send until the server reconnects",
    );
    expect(divider.textContent).toBe("Send after reconnect");
  });
});
