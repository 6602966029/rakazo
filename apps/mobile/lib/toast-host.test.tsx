// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastHost } from "../components/toast-host";
import { toast } from "./toast";

function flatStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(Number.POSITIVE_INFINITY).filter(Boolean));
}

const motion = vi.hoisted(() => ({
  glass: true,
  reduced: false,
  springs: 0,
  styles: [] as Record<string, unknown>[],
  timings: [] as Record<string, unknown>[],
  delays: [] as Record<string, unknown>[],
  accessibilityAction: undefined as
    | ((event: { nativeEvent: { actionName: string } }) => void)
    | undefined,
  announce: vi.fn(),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibilityWithOptions: motion.announce },
  Platform: { OS: "ios" },
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    accessible?: boolean;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityActions?: { name: string }[];
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => {
    if (props.accessibilityActions) motion.accessibilityAction = props.onAccessibilityAction;
    return createElement(
      "div",
      {
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        "aria-hidden": props.accessible === false ? "true" : undefined,
        "data-actions": props.accessibilityActions?.map((item) => item.name).join(","),
        // The innermost Pressable takes the touch, as React Native's responder does.
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          props.onPress?.();
        },
      },
      props.children,
    );
  },
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  Text: (props: {
    children?: ReactNode;
    numberOfLines?: number;
    maxFontSizeMultiplier?: number;
    style?: Record<string, unknown>[];
  }) =>
    createElement(
      "span",
      {
        "data-lines": props.numberOfLines,
        "data-max-scale": props.maxFontSizeMultiplier,
        "data-color": Object.assign({}, ...(props.style ?? [])).color,
        "data-opacity": Object.assign({}, ...(props.style ?? [])).opacity,
      },
      props.children,
    ),
  View: (props: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityLabel?: string;
    style?: unknown;
  }) =>
    createElement(
      "div",
      {
        "data-accessible": props.accessible,
        "aria-label": props.accessibilityLabel,
        "data-surface": flatStyle(props.style).backgroundColor,
      },
      props.children,
    ),
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("react-native-reanimated", async () => {
  const { useState } = await import("react");
  return {
    default: {
      View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
        createElement(
          "div",
          { "data-layer": "animated", "data-opacity": flatStyle(style).opacity },
          children,
        ),
    },
    Easing: { in: (easing: unknown) => easing, cubic: "cubic" },
    ReduceMotion: { Never: "never", System: "system" },
    useAnimatedStyle: (style: () => Record<string, unknown>) => {
      const value = style();
      motion.styles.push(value);
      return value;
    },
    useReducedMotion: () => motion.reduced,
    useSharedValue: (value: number) => useState(() => ({ value }))[0],
    withDelay: (delay: number, value: number, reduceMotion: string) => {
      motion.delays.push({ delay, reduceMotion });
      return value;
    },
    withSpring: (value: number) => {
      motion.springs += 1;
      return value;
    },
    withTiming: (value: number, config: Record<string, unknown>) => {
      motion.timings.push(config);
      return value;
    },
  };
});
vi.mock("react-native-gesture-handler", () => {
  const fling = { direction: () => fling, runOnJS: () => fling, onEnd: () => fling };
  return {
    Directions: { UP: 4 },
    Gesture: { Fling: () => fling },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47 }) }));
vi.mock("expo-glass-effect", () => ({
  isLiquidGlassAvailable: () => motion.glass,
  GlassView: (props: {
    children?: ReactNode;
    tintColor?: string;
    style?: unknown;
    glassEffectStyle?: { style: string };
  }) =>
    createElement(
      "div",
      {
        "data-glass-tint": props.tintColor,
        "data-glass-style": props.glassEffectStyle?.style,
        "data-surface": flatStyle(props.style).backgroundColor,
      },
      props.children,
    ),
}));
vi.mock("./native", () => ({
  useResolvedAppearance: () => "light",
  useMobileTokens: () => ({
    primary: "token-primary",
    primaryForeground: "token-primary-foreground",
    destructive: "token-destructive",
    foreground: "token-foreground",
  }),
}));
vi.mock("./appearance", () => ({
  mobileTokens: (preference: string) => ({
    destructive: `${preference}-destructive`,
    destructiveForeground: `${preference}-destructive-foreground`,
    success: `${preference}-success`,
  }),
}));
// The real component isn't imported; a glass card would show up as this marker.
vi.mock("../components/glass-surface", () => ({
  GlassSurface: () => createElement("div", { "data-glass": true }),
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: ({ ios, color }: { ios: string; color?: string }) =>
    createElement("i", { "data-symbol": ios, "data-color": color }),
}));
vi.mock("../components/toast-overlay", () => ({
  ToastOverlay: ({ children }: { children?: ReactNode }) => children,
}));

describe("ToastHost", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    motion.glass = true;
    motion.reduced = false;
    motion.springs = 0;
    motion.styles = [];
    motion.timings = [];
    motion.delays = [];
    motion.accessibilityAction = undefined;
    motion.announce.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ToastHost />));
  });

  afterEach(() => {
    act(() => {
      toast.clear();
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders nothing without a toast", () => {
    expect(container.innerHTML).toBe("");
  });

  it.each([
    // Red in both themes, from the light palette, so white text passes 4.5:1.
    [
      "error",
      "exclamationmark.circle.fill",
      "light-destructive",
      "light-destructive-foreground",
      "light-destructive-foreground",
    ],
    [
      "info",
      "info.circle.fill",
      "token-primary",
      "token-primary-foreground",
      "token-primary-foreground",
    ],
    // White on green misses 4.5:1, so success is ink with a green check.
    [
      "success",
      "checkmark.circle.fill",
      "token-primary",
      "token-primary-foreground",
      "light-success",
    ],
  ] as const)("colours the %s variant", (variant, symbol, surface, text, icon) => {
    act(() => toast.show("Saved", { variant, detail: "Detail" }));
    // UIKit glass tinted by variant; a SwiftUI GlassSurface draws nothing in the overlay window.
    expect(container.querySelector("[data-glass]")).toBeNull();
    expect(container.querySelector("[data-glass-tint]")?.getAttribute("data-glass-tint")).toBe(
      surface,
    );
    expect(container.querySelector("[data-surface]")).toBeNull();
    const symbolView = container.querySelector("[data-symbol]");
    expect(symbolView?.getAttribute("data-symbol")).toBe(symbol);
    expect(symbolView?.getAttribute("data-color")).toBe(icon);
    for (const line of container.querySelectorAll("span")) {
      expect(line.getAttribute("data-color")).toBe(text);
      // Full opacity keeps the detail at the title's contrast.
      expect(line.getAttribute("data-opacity")).toBeNull();
    }
  });

  it("fills the card with the variant colour where Liquid Glass is unavailable", () => {
    motion.glass = false;
    act(() => toast.show("Could not delete bot", { variant: "error" }));
    expect(container.querySelector("[data-surface]")?.getAttribute("data-surface")).toBe(
      "light-destructive",
    );
  });

  it("is one accessible element, announced without taking focus", () => {
    act(() =>
      toast.show("Could not restore bot", {
        variant: "error",
        detail: "Could not reach the server",
      }),
    );
    const cards = container.querySelectorAll("[aria-label]");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("aria-label")).toBe(
      "Could not restore bot. Could not reach the server",
    );
    expect(cards[0]?.getAttribute("role")).toBeNull();
    expect(cards[0]?.getAttribute("data-actions")).toBeNull();
    expect(motion.announce).toHaveBeenCalledWith(
      "Could not restore bot. Could not reach the server",
      { queue: true },
    );
  });

  it("caps text scaling and line counts", () => {
    act(() => toast.show("Title", { variant: "error", detail: "Detail" }));
    const [title, detail] = container.querySelectorAll("span");
    expect(title?.getAttribute("data-lines")).toBe("2");
    expect(detail?.getAttribute("data-lines")).toBe("3");
    expect(title?.getAttribute("data-max-scale")).toBe("1.35");
    expect(detail?.getAttribute("data-max-scale")).toBe("1.35");
  });

  it("runs the action only from its row and dismisses", () => {
    const run = vi.fn();
    act(() =>
      toast.show("Failed to send message", { variant: "error", action: { label: "Retry", run } }),
    );
    const card = container.querySelector("[aria-label]");
    expect(card?.getAttribute("role")).toBe("button");
    expect(card?.getAttribute("aria-label")).toBe("Failed to send message. Retry");
    const row = container.querySelector("[aria-hidden='true']") as HTMLElement | null;
    expect(row?.textContent).toContain("Retry");

    act(() => row?.click());
    expect(run).toHaveBeenCalledOnce();
    act(() => vi.runAllTimers());
    expect(container.innerHTML).toBe("");
  });

  it("only dismisses when the card is tapped outside the action row", () => {
    const run = vi.fn();
    act(() =>
      toast.show("Failed to send message", { variant: "error", action: { label: "Retry", run } }),
    );
    act(() => (container.querySelector("[aria-label]") as HTMLElement).click());
    expect(run).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(container.innerHTML).toBe("");
  });

  it("runs the action from VoiceOver's activate on the one card element", () => {
    const run = vi.fn();
    act(() =>
      toast.show("Failed to send message", { variant: "error", action: { label: "Retry", run } }),
    );
    expect(container.querySelector("[aria-label]")?.getAttribute("data-actions")).toBe("activate");
    act(() => motion.accessibilityAction?.({ nativeEvent: { actionName: "activate" } }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("springs down from above, or only fades with Reduce Motion", () => {
    act(() => toast.show("First", { variant: "info" }));
    expect(motion.springs).toBeGreaterThan(0);
    // The first frame starts 26 pt above its resting place.
    expect(motion.styles.find((style) => "transform" in style)?.transform).toEqual([
      { translateY: -26 },
    ]);

    act(() => toast.clear());
    motion.reduced = true;
    motion.springs = 0;
    motion.styles = [];
    act(() => toast.show("Second", { variant: "info" }));
    expect(motion.springs).toBe(0);
    expect(
      motion.styles.filter((style) => "transform" in style).map((style) => style.transform),
    ).not.toContainEqual([{ translateY: -26 }]);
    expect(motion.styles.find((style) => "transform" in style)?.transform).toEqual([]);
  });

  it("materializes the glass and fades only the content, never the glass's parents", () => {
    const layers = () =>
      Array.from(container.querySelectorAll("[data-layer='animated']")).map((layer) =>
        layer.getAttribute("data-opacity"),
      );
    const glassStyle = () =>
      container.querySelector("[data-glass-style]")?.getAttribute("data-glass-style");

    act(() => toast.show("Saved", { variant: "info" }));
    expect(glassStyle()).toBe("regular");
    expect(layers()).toEqual(["1", "1"]);

    act(() => toast.dismiss());
    expect(glassStyle()).toBe("none");
    // The card's wrapper stays opaque; only the content inside the glass fades out.
    expect(layers()).toEqual(["1", "0"]);
  });

  it("fades the whole solid card where Liquid Glass is unavailable", () => {
    motion.glass = false;
    act(() => toast.show("Saved", { variant: "info" }));
    act(() => toast.dismiss());
    expect(
      Array.from(container.querySelectorAll("[data-layer='animated']")).map((layer) =>
        layer.getAttribute("data-opacity"),
      ),
    ).toEqual(["0", "1"]);
  });

  it("still fades in and out with Reduce Motion instead of jumping", () => {
    motion.reduced = true;
    act(() => toast.show("Saved", { variant: "info" }));
    act(() => toast.dismiss());
    // The card's fade and, on glass, the content's fade, in and out.
    expect(motion.timings).toHaveLength(4);
    for (const timing of motion.timings) {
      expect(timing).toMatchObject({ duration: 220, reduceMotion: "never" });
    }
  });

  it("holds the text back until the glass has materialized", () => {
    act(() => toast.show("Saved", { variant: "info" }));
    expect(motion.delays).toEqual([{ delay: 150, reduceMotion: "never" }]);

    motion.glass = false;
    motion.delays = [];
    act(() => toast.clear());
    act(() => toast.show("Saved", { variant: "info" }));
    expect(motion.delays).toEqual([]);
  });
});
