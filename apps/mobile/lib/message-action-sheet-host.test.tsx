// @vitest-environment jsdom

import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode, Ref } from "react";
import { act, useImperativeHandle } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AndroidMessageActionSheetHost from "../components/message-action-sheet-compose";
import { MessageActionSheetHost } from "../components/message-action-sheet-host";
import { isComposeViewAvailable } from "./compose-available";
import { presentMessageActionSheet } from "./message-action-sheet";

const native = vi.hoisted(() => ({ hide: vi.fn(async () => {}), host: vi.fn(), sheet: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));
vi.mock("./compose-available", () => ({ isComposeViewAvailable: vi.fn(() => true) }));
vi.mock("@expo/ui/jetpack-compose/modifiers", () => ({
  clickable: (handler: () => void) => ({ handler }),
  fillMaxWidth: () => ({}),
  padding: () => ({}),
}));
vi.mock("@expo/ui/jetpack-compose", () => ({
  Host: (props: { children: ReactNode }) => {
    native.host(props);
    return props.children;
  },
  ModalBottomSheet: (props: {
    children: ReactNode;
    ref: Ref<unknown>;
    onDismissRequest: () => void;
  }) => {
    native.sheet(props);
    useImperativeHandle(props.ref, () => ({ hide: native.hide }));
    return (
      <div>
        <button type="button" onClick={props.onDismissRequest}>
          Dismiss
        </button>
        {props.children}
      </div>
    );
  },
  LazyColumn: ({ children }: { children: ReactNode }) => <div data-scroll="true">{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItem: Object.assign(
    ({ children, modifiers }: { children: ReactNode; modifiers: { handler?: () => void }[] }) => (
      <button type="button" onClick={modifiers.find((modifier) => modifier.handler)?.handler}>
        {children}
      </button>
    ),
    { HeadlineContent: ({ children }: { children: ReactNode }) => children },
  ),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(isComposeViewAvailable).mockReturnValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(<AndroidMessageActionSheetHost />);
  });
}

it.each(["light", "dark"] as const)(
  "renders all rows in a scrolling native list with app %s colors",
  async (colorScheme) => {
    await mount();
    const onPress = vi.fn();
    act(() =>
      presentMessageActionSheet({
        actions: Array.from({ length: 100 }, (_, index) => ({ text: `Model ${index}`, onPress })),
        title: "Models",
        cancel: "Cancel",
        more: "More",
        colorScheme,
      }),
    );
    expect(container.querySelectorAll("[data-scroll] button")).toHaveLength(100);
    expect(container.textContent).toContain("Models");
    const tokens = tokensForAppearance(colorScheme);
    expect(native.host.mock.lastCall?.[0]).toMatchObject({
      colorScheme,
      seedColor: tokens.primary,
    });
    expect(native.sheet.mock.lastCall?.[0]).toMatchObject({
      containerColor: tokens.card,
      contentColor: tokens.foreground,
      scrimColor: tokens.overlay,
    });
    await act(async () => {
      (container.querySelectorAll("[data-scroll] button")[99] as HTMLButtonElement).click();
    });
    expect(native.hide).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("");
  },
);

it("routes native gesture, scrim and Back dismissal to cancellation", async () => {
  await mount();
  const onPress = vi.fn();
  act(() =>
    presentMessageActionSheet({
      actions: [{ text: "React", onPress }],
      cancel: "Cancel",
      more: "More",
      colorScheme: "light",
    }),
  );
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toBe("");
  expect(onPress).not.toHaveBeenCalled();
});

it("does not render the Compose host when a required native view is missing", async () => {
  vi.mocked(isComposeViewAvailable).mockReturnValue(false);
  await act(async () => {
    root.render(<MessageActionSheetHost />);
  });
  expect(native.host).not.toHaveBeenCalled();
  expect(native.sheet).not.toHaveBeenCalled();
});
