// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionBar } from "../components/connection-bar";
import { DISCONNECTED_GRACE_MS, useConnectionPhase } from "./connection-phase";

const h = vi.hoisted(() => ({
  reachable: true,
  listeners: new Set<() => void>(),
  announce: vi.fn(),
}));

type Props = { children?: ReactNode; onPress?: () => void; accessibilityRole?: string };

vi.mock("react-native", () => ({
  View: ({ children }: Props) => createElement("div", null, children),
  Text: ({ children }: Props) => createElement("span", null, children),
  Pressable: ({ children, onPress, accessibilityRole }: Props) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, role: accessibilityRole },
      children,
    ),
  ActivityIndicator: () => createElement("progress"),
  AccessibilityInfo: { announceForAccessibility: h.announce },
}));
vi.mock("./api", () => ({
  isServerReachable: () => h.reachable,
  subscribeServerReachable: (listener: () => void) => {
    h.listeners.add(listener);
    return () => h.listeners.delete(listener);
  },
}));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));

let root: Root;
let container: HTMLDivElement;
function render(node: ReactNode) {
  act(() => root.render(node));
}
const reach = (reachable: boolean) =>
  act(() => {
    h.reachable = reachable;
    for (const listener of h.listeners) listener();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  h.reachable = true;
  h.announce.mockReset();
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

describe("home connection bar", () => {
  // Like the inbox: the phase lives in the screen, the bar unmounts while searching.
  function Home({
    saved,
    searching = false,
    onRetry,
  }: {
    saved: boolean;
    searching?: boolean;
    onRetry: () => void;
  }) {
    const phase = useConnectionPhase(() => h.announce("Can't reach the server"));
    return searching ? null : <ConnectionBar phase={phase} saved={saved} onRetry={onRetry} />;
  }

  it("says it is reconnecting, then after the grace that the server can't be reached, with Retry", () => {
    const retry = vi.fn();
    render(<Home saved onRetry={retry} />);
    expect(container.textContent).toBe("");
    reach(false);
    expect(container.textContent).toBe("Reconnecting to the server…");
    act(() => vi.advanceTimersByTime(DISCONNECTED_GRACE_MS - 1));
    expect(container.textContent).toBe("Reconnecting to the server…");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("Can't reach the server");
    expect(container.textContent).toContain("Your bots are safe — showing saved chats.");
    expect(h.announce).toHaveBeenCalledExactlyOnceWith("Can't reach the server");
    act(() => container.querySelector<HTMLButtonElement>('[role="button"]')!.click());
    expect(retry).toHaveBeenCalledOnce();
    reach(true);
    expect(container.textContent).toBe("");
    reach(false);
    expect(container.textContent).toBe("Reconnecting to the server…");
    expect(h.announce).toHaveBeenCalledOnce();
  });

  it("announces an outage once, not again when the bar comes back after search", () => {
    render(<Home saved onRetry={() => undefined} />);
    reach(false);
    act(() => vi.advanceTimersByTime(DISCONNECTED_GRACE_MS));
    expect(h.announce).toHaveBeenCalledOnce();
    render(<Home saved searching onRetry={() => undefined} />);
    render(<Home saved onRetry={() => undefined} />);
    expect(container.textContent).toContain("Can't reach the server");
    expect(h.announce).toHaveBeenCalledOnce();
  });

  it("doesn't claim saved chats before anything has loaded on this device", () => {
    render(<Home saved={false} onRetry={() => undefined} />);
    reach(false);
    act(() => vi.advanceTimersByTime(DISCONNECTED_GRACE_MS));
    expect(container.textContent).toBe("Can't reach the serverRetry");
  });
});
