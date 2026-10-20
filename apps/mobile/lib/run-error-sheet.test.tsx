// @vitest-environment jsdom

import * as Clipboard from "expo-clipboard";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunErrorSheet, useRunError } from "../components/run-error-sheet";

vi.mock("react-native", () => ({
  Modal: ({ children }: { children: ReactNode }) =>
    createElement("dialog", { open: true }, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  Platform: { OS: "ios" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./native", () => ({ useMobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, values?: Record<string, string>) =>
      key.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? name),
  }),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));

const details =
  '403: {"message":"OpenRouter weekly key limit exceeded; resets 2026-10-21T00:00:00Z"}';
const roots: ReturnType<typeof createRoot>[] = [];
function mount(element: ReactNode) {
  const node = document.createElement("div");
  const root = createRoot(node);
  roots.push(root);
  act(() => root.render(element));
  return node;
}
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
});

describe("run error recovery", () => {
  it("removes the upcoming date while the same saved error remains open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T23:59:59Z"));
    function Probe() {
      return createElement("p", null, useRunError(details)?.summary);
    }
    const node = mount(createElement(Probe));
    expect(node.textContent).toBe("OpenRouter key hit its weekly limit. Resets Oct 21.");
    act(() => vi.advanceTimersByTime(1000));
    expect(node.textContent).toBe("OpenRouter key hit its weekly limit.");
  });
  it("shows recovery and ownership uncertainty before diagnostics, and copies only on request", () => {
    const onConnection = vi.fn();
    const onModel = vi.fn();
    const node = mount(
      createElement(RunErrorSheet, { details, onClose: vi.fn(), onConnection, onModel }),
    );
    expect(node.textContent).toContain("personal or shared key");
    expect(node.textContent).not.toContain("403:");
    const click = (label: string) =>
      act(() => {
        Array.from(node.querySelectorAll("button"))
          .find((button) => button.textContent === label)
          ?.click();
      });
    click("Connection settings");
    click("Change model");
    expect(onConnection).toHaveBeenCalledOnce();
    expect(onModel).toHaveBeenCalledOnce();
    click("Technical details");
    expect(node.textContent).toContain(details);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    click("Copy");
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(details);
    click("Technical details");
    expect(node.textContent).not.toContain("403:");
  });
  it("offers model recovery without suggesting a key failure for a missing model", () => {
    const node = mount(
      createElement(RunErrorSheet, {
        details: '404: {"message":"Model unavailable"}',
        onClose: vi.fn(),
        onConnection: vi.fn(),
        onModel: vi.fn(),
      }),
    );
    expect(node.textContent).toContain("Change model");
    expect(node.textContent).not.toContain("Connection settings");
    expect(node.textContent).not.toContain("personal or shared key");
  });
  it("does not mount a native modal when closed", () => {
    const node = mount(
      createElement(RunErrorSheet, { details: null, onClose: vi.fn(), onConnection: vi.fn() }),
    );
    expect(node.querySelector("dialog")).toBeNull();
  });
});
