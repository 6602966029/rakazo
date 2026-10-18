// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchSheet from "../app/search";
import type { InboxSpace } from "./inbox-spaces";
import { searchKindLabel } from "./search-sheet";

const state = vi.hoisted(() => ({
  search: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  selectSpace: vi.fn(),
  dismiss: vi.fn(),
  alert: vi.fn(),
  platform: { OS: "ios" },
}));
const bot = {
  id: "bot-a",
  name: "Scout",
  title: "Research",
  preview: "Latest reply",
  spaceId: "space-a",
  color: "gray",
  status: "idle",
};
const group = {
  id: "group-a",
  name: "Team",
  preview: "Team reply",
  spaceId: "space-b",
  members: [],
};
const spaces = [{ id: "space-a", bots: [bot], groups: [group] }] as unknown as InboxSpace[];
const message = {
  kind: "message" as const,
  botId: "bot-a",
  botName: "Scout",
  title: "Found note",
  snippet: "A **matching** line",
  messageId: "message-a",
};
vi.mock("expo-router", () => ({ useRouter: () => state }));
vi.mock("./api", () => ({ selectSpace: state.selectSpace }));
vi.mock("./search", () => ({ querySpaceSearch: state.search }));
vi.mock("./search-inbox", () => ({
  getSearchInbox: () => spaces,
  subscribeSearchInbox: () => () => {},
}));
vi.mock("./appearance", () => ({
  mobileTokens: () => ({}),
  resolveMobileAppearance: () => "dark",
}));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text, locale: "en" }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: state.dismiss },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <span>bot avatar</span> }));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => <span>group avatar</span> }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: ({ testID, onPress }: { testID: string; onPress: () => void }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      Close
    </button>
  ),
}));
vi.mock("react-native", () => ({
  Platform: state.platform,
  Alert: { alert: state.alert },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ width: 390 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    ref,
    value,
    onChangeText,
    testID,
    ...props
  }: {
    ref: React.Ref<HTMLInputElement>;
    value: string;
    onChangeText: (text: string) => void;
    testID: string;
  }) => (
    <input
      ref={ref}
      data-testid={testID}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      data-keyboard={JSON.stringify(props)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  FlatList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data: { key: string }[];
    renderItem: (info: { item: unknown }) => ReactNode;
    ListEmptyComponent: ReactNode;
  }) => (
    <div>
      {data.length
        ? data.map((item) => <div key={item.key}>{renderItem({ item })}</div>)
        : ListEmptyComponent}
    </div>
  ),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.platform.OS = "ios";
  state.search.mockResolvedValue([]);
  state.selectSpace.mockResolvedValue(true);
  state.dismiss.mockResolvedValue(undefined);
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<SearchSheet />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function row(label: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}
async function type(text: string) {
  await act(async () => {
    const field = container.querySelector("input")!;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("renders inbox chats before typing and closes with the close button", async () => {
  expect(row("Scout, Bot").textContent).toContain("Latest reply");
  expect(row("Team, Group").textContent).toContain("Team reply");
  expect(state.search).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="search-sheet-close"]')!.click(),
  );
  expect(state.back).toHaveBeenCalledOnce();
});
it("debounces typing, renders server hits and preserves the message jump destination", async () => {
  state.search.mockResolvedValue([message, message]);
  await type("matching");
  expect(container.textContent).toContain("Searching…");
  await act(async () => vi.advanceTimersByTime(199));
  expect(state.search).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(state.search).toHaveBeenCalledWith("matching");
  expect(container.querySelectorAll('button[aria-label="Found note, Message"]')).toHaveLength(1);
  expect(row("Found note, Message").textContent).toContain("Scout · A matching line");
  await act(async () => row("Found note, Message").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.dismiss).toHaveBeenCalledOnce();
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout", messageId: "message-a" },
  });
  expect(state.dismiss.mock.invocationCallOrder[0]).toBeLessThan(
    state.replace.mock.invocationCallOrder[0]!,
  );
});
it("keeps local name matching and does not duplicate conversation hits", async () => {
  state.search.mockResolvedValue([{ ...message, kind: "conversation", title: "Scout" }]);
  await type("Scout");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.querySelectorAll('button[aria-label="Scout, Bot"]')).toHaveLength(1);
  expect(row("Team, Group")).toBeNull();
});
it("opens a group after switching spaces and keeps the sheet on switch failure", async () => {
  state.selectSpace.mockResolvedValueOnce(false);
  await act(async () => row("Team, Group").click());
  expect(state.alert).toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
  await act(async () => row("Team, Group").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-b");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/group-thread",
    params: { groupId: "group-a", name: "Team" },
  });
});
it("ignores stale server responses and restores chats when cleared", async () => {
  let resolve!: (hits: (typeof message)[]) => void;
  state.search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await type("first");
  await act(async () => vi.advanceTimersByTime(200));
  await type("second");
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.textContent).toContain("No results");
  await act(async () => resolve([message]));
  expect(row("Found note, Message")).toBeNull();
  await type("");
  expect(row("Scout, Bot")).not.toBeNull();
});
it.each([
  ["conversation", "Bot"],
  ["message", "Message"],
  ["file", "File"],
  ["link", "Link"],
  ["routine", "Routine"],
] as const)("labels %s hits", (kind, label) => {
  expect(searchKindLabel({ ...message, kind })).toBe(label);
});

it("retries focus after the sheet attaches and keeps the native search keyboard options", () => {
  const field = container.querySelector("input")!;
  const focus = vi.spyOn(field, "focus");
  act(() => vi.advanceTimersByTime(350));
  expect(focus).toHaveBeenCalledOnce();
  expect(JSON.parse(field.dataset.keyboard!)).toMatchObject({
    autoFocus: true,
    autoCorrect: false,
    autoCapitalize: "none",
    returnKeyType: "search",
    keyboardAppearance: "dark",
    clearButtonMode: "while-editing",
    placeholder: "Search",
  });
});

it("opens an inbox bot with the home thread destination", async () => {
  await act(async () => row("Scout, Bot").click());
  expect(state.selectSpace).toHaveBeenCalledWith("space-a");
  expect(state.replace).toHaveBeenCalledWith({
    pathname: "/thread",
    params: { botId: "bot-a", name: "Scout" },
  });
});

it("clears the Android field and restores inbox chats", async () => {
  state.platform.OS = "android";
  await type("no match");
  await act(async () => row("Clear").click());
  expect(container.querySelector("input")!.value).toBe("");
  expect(row("Scout, Bot")).not.toBeNull();
});
