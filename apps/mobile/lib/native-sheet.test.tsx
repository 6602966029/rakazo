// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotOrganizeModal } from "../components/bot-organize-modal";
import { NativeSheet, useNativeSheet } from "../components/native-sheet";
import { RunErrorSheetContainer } from "../components/run-error-sheet-container";

const mocks = vi.hoisted(() => ({
  missing: "",
  platform: "android",
  sheet: vi.fn(),
  confirmDelete: vi.fn(),
  modal: vi.fn(),
  views: vi.fn(),
  listeners: new Map<string, (event: { endCoordinates: { height: number } }) => void>(),
  styles: [] as Record<string, unknown>[],
}));
vi.mock("./compose-available", () => ({
  isComposeViewAvailable: (name: string) => {
    mocks.views(name);
    return name !== mocks.missing;
  },
}));
vi.mock("./native", () => ({
  native: {},
  useThemedStyles: (factory: () => unknown) => factory(),
  useMobileTokens: () => ({ background: "token-background" }),
}));
vi.mock("@expo/ui/community/bottom-sheet", () => ({
  BottomSheet: (props: { children: ReactNode }) => {
    mocks.sheet(props);
    return props.children;
  },
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./confirm-delete-section", () => ({
  confirmDeleteSection: (_section: unknown, _t: unknown, confirm: () => void) => {
    mocks.confirmDelete();
    confirm();
  },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, label),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
  }) => createElement("button", { type: "button", onClick: onPress, disabled }, children),
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (value: string) => void }) =>
    createElement("input", {
      value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    }),
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  Platform: {
    get OS() {
      return mocks.platform;
    },
  },
  Keyboard: {
    addListener: (
      name: string,
      callback: (event: { endCoordinates: { height: number } }) => void,
    ) => {
      mocks.listeners.set(name, callback);
      return { remove: () => mocks.listeners.delete(name) };
    },
  },
  useWindowDimensions: () => ({ height: 1000, width: 400 }),
  Modal: (props: { children: ReactNode }) => {
    mocks.modal(props);
    return createElement("dialog", null, props.children);
  },
  View: (props: { children: ReactNode; style: Record<string, unknown> }) => {
    mocks.styles.push(props.style);
    return createElement("div", null, props.children);
  },
  ScrollView: (props: { children: ReactNode }) => createElement("div", null, props.children),
}));

const roots: ReturnType<typeof createRoot>[] = [];
async function mount(node: ReactNode) {
  const element = document.createElement("div");
  const root = createRoot(element);
  Object.assign(root, { element });
  roots.push(root);
  await act(async () => root.render(node));
  return Object.assign(root, { element });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.missing = "";
  mocks.platform = "android";
  mocks.styles.length = 0;
});
afterEach(() =>
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  }),
);

describe("Android sheet selection", () => {
  it.each(["HostView", "ModalBottomSheetView", "RNHostView", "SlotView"])(
    "keeps the original run error Modal when %s is missing",
    async (missing) => {
      mocks.missing = missing;
      const close = vi.fn();
      await mount(
        <RunErrorSheetContainer expanded onClose={close}>
          Error
        </RunErrorSheetContainer>,
      );
      expect(mocks.sheet).not.toHaveBeenCalled();
      expect(mocks.modal.mock.lastCall?.[0]).toMatchObject({
        visible: true,
        animationType: "slide",
        onRequestClose: close,
      });
    },
  );
  it("uses the community sheet only after checking every native adapter", async () => {
    await mount(
      <RunErrorSheetContainer expanded={false} onClose={vi.fn()}>
        Error
      </RunErrorSheetContainer>,
    );
    expect(mocks.views.mock.calls.flat()).toEqual([
      "HostView",
      "ModalBottomSheetView",
      "RNHostView",
      "SlotView",
    ]);
    expect(mocks.sheet.mock.lastCall?.[0]).toMatchObject({
      enableDynamicSizing: true,
      enablePanDownToClose: true,
      backgroundStyle: { backgroundColor: "token-background" },
    });
  });
  it("does not load a Compose sheet on iOS", async () => {
    mocks.platform = "ios";
    function Probe() {
      return useNativeSheet() ? "native" : "fallback";
    }
    await mount(<Probe />);
    expect(mocks.views).not.toHaveBeenCalled();
    expect(mocks.sheet).not.toHaveBeenCalled();
  });
});

describe("native sheet behavior", () => {
  const Sheet = (props: { children?: ReactNode }) => {
    mocks.sheet(props);
    return props.children;
  };
  it.each(["swipe", "scrim", "Back"])(
    "closes once for %s and duplicate native notifications",
    async () => {
      const close = vi.fn();
      await mount(
        <NativeSheet Sheet={Sheet} onClose={close}>
          Actions
        </NativeSheet>,
      );
      const props = mocks.sheet.mock.lastCall?.[0];
      // Material routes all three dismiss gestures through onClose in the community adapter.
      act(() => {
        props.onClose();
        props.onClose();
      });
      expect(close).toHaveBeenCalledOnce();
      expect(props.enablePanDownToClose).toBe(true);
    },
  );
  it("switches from content sizing to a tall expanded run error sheet", async () => {
    const root = await mount(
      <RunErrorSheetContainer expanded={false} onClose={vi.fn()}>
        Error
      </RunErrorSheetContainer>,
    );
    expect(mocks.styles).toContainEqual({ maxHeight: 852, height: undefined });
    await act(async () =>
      root.render(
        <RunErrorSheetContainer expanded onClose={vi.fn()}>
          Error
        </RunErrorSheetContainer>,
      ),
    );
    expect(mocks.styles).toContainEqual({ maxHeight: 852, height: 852 });
  });
  it("reduces the scroll viewport above the keyboard and restores it on hide", async () => {
    await mount(
      <NativeSheet Sheet={Sheet} onClose={vi.fn()} label="Chat">
        Actions
      </NativeSheet>,
    );
    act(() => mocks.listeners.get("keyboardDidShow")?.({ endCoordinates: { height: 300 } }));
    expect(mocks.styles).toContainEqual({ maxHeight: 552, height: undefined });
    act(() => mocks.listeners.get("keyboardDidHide")?.({ endCoordinates: { height: 0 } }));
    expect(mocks.styles.at(-1)).toEqual({ maxHeight: 852, height: undefined });
  });
});

describe("inbox organization actions", () => {
  async function organize(botOverrides = {}) {
    const props = {
      bot: {
        name: "Sample chat",
        pinned: false,
        sectionId: "one",
        notifyOnFinish: true,
        ...botOverrides,
      },
      sections: [
        { id: "one", name: "First", position: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
        {
          id: "two",
          name: "Second",
          position: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      onClose: vi.fn(),
      onUpdate: vi.fn().mockResolvedValue(undefined),
      onCreateSection: vi.fn().mockResolvedValue(undefined),
      onRenameSection: vi.fn().mockResolvedValue(undefined),
      onDeleteSection: vi.fn().mockResolvedValue(undefined),
    };
    const root = await mount(<BotOrganizeModal {...props} />);
    const click = async (label: string) => {
      const button = Array.from(root.element.querySelectorAll("button")).find(
        (button) => button.textContent === label,
      );
      expect(button, label).toBeDefined();
      await act(async () => button?.click());
    };
    return { props, root, click };
  }
  it.each([
    ["Pin", { pinned: true }],
    ["Unpin", { pinned: false }],
    ["Silence notifications", { notifyOnFinish: false }],
    ["Resume notifications", { notifyOnFinish: true }],
    ["Second", { sectionId: "two" }],
    ["Unassigned", { sectionId: null }],
  ])("keeps %s working inside the native sheet", async (label, update) => {
    const { props, click } = await organize({
      pinned: label === "Unpin",
      notifyOnFinish: label !== "Resume notifications",
    });
    await click(label as string);
    expect(props.onUpdate).toHaveBeenCalledWith(update);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(mocks.sheet).toHaveBeenCalled();
  });
  it("keeps rename inputs and saving connected", async () => {
    const { props, click, root } = await organize();
    await click("Rename section");
    const input = root.element.querySelector("input");
    expect(input?.value).toBe("First");
    // Use React's native input setter to exercise the text change event.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Updated",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");
    expect(props.onRenameSection).toHaveBeenCalledWith("one", "Updated");
  });
  it("keeps creation inputs reachable and deletion confirmed", async () => {
    const { props, click, root } = await organize();
    await click("New section");
    expect(root.element.querySelector("input")).not.toBeNull();
    expect(root.element.querySelector("input")?.value).toBe("");
    await act(async () => {
      const input = root.element.querySelector("input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "New");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Create");
    expect(props.onCreateSection).toHaveBeenCalledWith("New");
    const next = await organize();
    await next.click("Delete section");
    expect(mocks.confirmDelete).toHaveBeenCalledOnce();
    expect(next.props.onDeleteSection).toHaveBeenCalledWith("one");
  });
  it("keeps the original fade Modal when native views are unavailable", async () => {
    mocks.missing = "SlotView";
    await organize();
    expect(mocks.sheet).not.toHaveBeenCalled();
    expect(mocks.modal.mock.lastCall?.[0]).toMatchObject({
      transparent: true,
      animationType: "fade",
    });
  });
});
