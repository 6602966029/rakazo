// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModelPickerScreen from "../app/(settings)/model-picker";
import Models from "../app/(settings)/models";
import BotModelScreen from "../app/bot-model";
import BotSettingsScreen from "../app/bot-settings";
import { ModelPickerList } from "../components/model-picker-list";
import { modelPickerRequest } from "./model-picker-selection";

const mocks = vi.hoisted(() => ({
  focused: true,
  platform: "ios",
  connected: true,
  catalogEmpty: false,
  vendorLabels: false,
  subscriptionSignIn: false,
  completeOAuth: vi.fn(),
  rpc: vi.fn(),
  dismissKeyboard: vi.fn(),
  listProps: {} as Record<string, unknown>,
  params: {} as Record<string, string | undefined>,
  update: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  dismissTo: vi.fn(),
  setParams: vi.fn(),
  setOptions: vi.fn(),
  announce: vi.fn(),
}));

const catalog = Array.from({ length: 11 }, (_, index) => ({
  provider: "openrouter",
  providerName: "OpenRouter",
  id: `vendor/model-${index + 1}`,
  label: `Model ${index + 1}`,
  billing: "",
  thinkingLevels: ["low", "medium", "high"],
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 34 }),
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./message-action-sheet", () => ({ presentMessageActionSheet: vi.fn() }));

vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({}),
  selectedSpaceId: () => "space-fixture",
  rpc: async (procedure: string, input?: unknown, options?: { signal?: AbortSignal }) => {
    mocks.rpc(procedure, input);
    if (procedure === "models/beginOAuth")
      return {
        loginId: "login-fixture",
        mode: "device-code",
        verificationUri: "https://example.com/sign-in",
        userCode: "FIXTURE",
        expiresInSeconds: 600,
      };
    if (procedure === "models/completeOAuth") return mocks.completeOAuth(options?.signal);
    if (procedure === "bots/update") return mocks.update(input);
    if (procedure === "bots/get")
      return { id: "bot-fixture", name: "Fixture", title: "", computerMode: "team" };
    if (procedure === "me")
      return {
        userId: "user-fixture",
        spaceId: "space-fixture",
        defaultProvider: "openrouter",
        defaultModel: "vendor/model-1",
      };
    if (procedure === "models/list")
      return mocks.catalogEmpty
        ? []
        : mocks.vendorLabels
          ? catalog.map((entry, index) => ({
              ...entry,
              label:
                index === 0
                  ? "Anthropic: Claude Sonnet 4.5"
                  : index === 1
                    ? "Google: Gemini"
                    : entry.label,
            }))
          : mocks.subscriptionSignIn
            ? catalog.map((entry) => ({ ...entry, signIn: "device-code" }))
            : catalog;
    if (procedure === "models/credentials")
      return mocks.connected
        ? [
            {
              provider: "openrouter",
              label: "OpenRouter",
              modelId: "vendor/model-1",
              thinkingLevel: "high",
            },
          ]
        : [];
    return [];
  },
}));
vi.mock("./bot-voices", () => ({
  voiceLabel: () => "",
  deviceVoices: async () => [],
  voiceForBot: async () => undefined,
  setVoiceForBot: async () => undefined,
}));
vi.mock("./device-voice", () => ({ loadDeviceVoiceEnabled: async () => false }));
vi.mock("./voice", () => ({ stopVoicePlayback: () => undefined }));
vi.mock("expo-speech", () => ({ stop: async () => undefined, speak: () => undefined }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    back: mocks.back,
    push: mocks.push,
    dismissTo: mocks.dismissTo,
    setParams: mocks.setParams,
  }),
  useNavigation: () => ({ setOptions: mocks.setOptions }),
  useLocalSearchParams: () => mocks.params,
  useFocusEffect: (effect: () => (() => void) | undefined) =>
    useEffect(() => (mocks.focused ? effect() : undefined), [effect, mocks.focused]),
}));
vi.mock("react-native", () => {
  const view = ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessibilityValue,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { text: string };
  }) =>
    createElement(
      "div",
      {
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
        "aria-valuetext": accessibilityValue?.text,
      },
      children,
    );
  return {
    AccessibilityInfo: { announceForAccessibility: mocks.announce },
    ActivityIndicator: () => createElement("i", { "data-loading": true }),
    Platform: {
      get OS() {
        return mocks.platform;
      },
    },
    Keyboard: { dismiss: mocks.dismissKeyboard },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    ScrollView: view,
    View: view,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    TextInput: ({
      value,
      onChangeText,
      accessibilityLabel,
      placeholder,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      accessibilityLabel?: string;
      placeholder?: string;
    }) =>
      createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
        "aria-label": accessibilityLabel,
        placeholder,
      }),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityValue,
      accessibilityRole,
    }: {
      accessibilityRole?: string;
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityValue?: { text: string };
    }) =>
      createElement(
        "button",
        {
          type: "button",
          role: accessibilityRole,
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-valuetext": accessibilityValue?.text,
        },
        children,
      ),
    SectionList: ({
      sections,
      renderItem,
      renderSectionHeader,
      keyExtractor,
      ListEmptyComponent,
      ListHeaderComponent,
      automaticallyAdjustKeyboardInsets,
      contentContainerStyle,
      contentInsetAdjustmentBehavior,
    }: {
      sections: { key: string; heading?: string; data: { key: string }[] }[];
      renderItem: (info: {
        item: { key: string };
        index: number;
        section: { data: { key: string }[] };
      }) => ReactNode;
      renderSectionHeader: (info: { section: { heading?: string } }) => ReactNode;
      keyExtractor: (item: { key: string }) => string;
      ListEmptyComponent: ReactNode;
      ListHeaderComponent?: ReactNode;
      automaticallyAdjustKeyboardInsets: boolean;
      contentContainerStyle: unknown;
      contentInsetAdjustmentBehavior: string;
    }) => {
      mocks.listProps = {
        automaticallyAdjustKeyboardInsets,
        contentContainerStyle,
        contentInsetAdjustmentBehavior,
      };
      return createElement(
        "ul",
        {},
        ListHeaderComponent,
        sections.length
          ? sections.map((section) =>
              createElement(
                "section",
                { key: section.key },
                renderSectionHeader({ section }),
                section.data.map((item, index) =>
                  createElement(
                    "li",
                    { key: keyExtractor(item) },
                    renderItem({ item, index, section }),
                  ),
                ),
              ),
            )
          : ListEmptyComponent,
      );
    },
  };
});
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useMobileTokens: () => ({ mutedForeground: "muted", foreground: "ink", destructive: "error" }),
  useResolvedAppearance: () => "light",
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./i18n", () => {
  const t = (text: string) => text;
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/settings-group", () => ({
  SettingsLabel: ({ children }: { children: ReactNode }) => createElement("h2", {}, children),
  SettingsFooter: ({ children }: { children: ReactNode }) => createElement("span", {}, children),
  SettingsRow: ({
    title,
    detail,
    accessibilityState,
    onPress,
    trailing,
    value,
    accessibilityLabel,
    accessibilityValue,
  }: {
    value?: string;
    accessibilityLabel?: string;
    accessibilityValue?: { text: string };
    title: string;
    detail?: string;
    accessibilityState?: { selected: boolean };
    onPress: () => void;
    trailing: ReactNode;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "aria-valuetext": accessibilityValue?.text,
        "aria-selected": accessibilityState?.selected,
        onClick: onPress,
      },
      title,
      value,
      detail ? createElement("small", {}, detail) : null,
      trailing,
    ),
}));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("./bot-avatar-edit", () => ({
  avatarColor: (value: string) => value,
  avatarShape: () => null,
  isAvatarPhoto: () => false,
  withAvatarColor: (_value: string, color: string) => color,
  withAvatarShape: (value: string) => value,
}));
vi.mock("../components/computer-mode-picker", () => ({ ComputerModePicker: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-switch", () => ({ NativeSwitch: () => null }));
vi.mock("../components/row-accessories", () => ({
  Chevron: () => null,
  Checkmark: () => createElement("i", { "data-checkmark": true }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "data-menu": title }, children),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.focused = true;
  mocks.platform = "ios";
  mocks.connected = true;
  mocks.catalogEmpty = false;
  mocks.vendorLabels = false;
  mocks.subscriptionSignIn = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("chat settings model row", () => {
  const render = async () => {
    await act(async () => root.render(<BotSettingsScreen />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Advanced"]')!.click());
  };

  it("opens the searchable model list when there are too many models for a menu", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    expect(container.querySelector('[data-menu="Model"]')).toBeNull();
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("Space default (Model 1)");
    act(() => row!.click());
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-model",
      params: { botId: "bot-fixture", value: "" },
    });
  });

  it("stages the model the list hands back until Save", async () => {
    mocks.params = { botId: "bot-fixture" };
    await render();
    mocks.params = { botId: "bot-fixture", model: "openrouter::vendor/model-3" };
    await act(async () => root.render(<BotSettingsScreen />));
    expect(mocks.setParams).toHaveBeenCalledWith({ model: undefined });
    const row = container.querySelector('button[aria-label="Model"]');
    expect(row?.getAttribute("aria-valuetext")).toBe("OpenRouter · Model 3");
    expect(mocks.update).not.toHaveBeenCalled();
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save!.click());
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openrouter", modelId: "vendor/model-3" }),
    );
  });
});

describe("chat model list", () => {
  const search = (text: string) =>
    act(() => {
      const options = mocks.setOptions.mock.lastCall![0];
      options.headerSearchBarOptions.onChangeText({ nativeEvent: { text } });
    });
  const rows = () => [...container.querySelectorAll("li button")];

  it("checks the current model, filters by name or id, and returns the pick", async () => {
    mocks.params = { botId: "bot-fixture", value: "openrouter::vendor/model-2" };
    await act(async () => root.render(<BotModelScreen />));
    expect(rows()).toHaveLength(12);
    expect(mocks.listProps).toMatchObject({
      automaticallyAdjustKeyboardInsets: true,
      contentInsetAdjustmentBehavior: "automatic",
      contentContainerStyle: expect.arrayContaining([
        expect.objectContaining({ paddingBottom: 106 }),
      ]),
    });
    expect(container.querySelectorAll("h2")).toHaveLength(1);
    expect(container.querySelector("h2")?.textContent).toBe("OpenRouter");
    expect(rows()[0]?.querySelector("small")?.textContent).toBe("Model 1");
    expect(rows()[0]!.textContent).toBe("Space defaultModel 1");
    const checked = rows().filter((row) => row.getAttribute("aria-selected") === "true");
    expect(checked.map((row) => row.textContent)).toEqual(["Model 2"]);
    expect(checked[0]!.querySelector("[data-checkmark]")).not.toBeNull();

    search("MODEL 1");
    expect(rows().map((row) => row.textContent)).toEqual([
      "Space defaultModel 1",
      "Model 1",
      "Model 10",
      "Model 11",
    ]);
    search("vendor/model-7");
    expect(rows().map((row) => row.textContent)).toEqual(["Model 7"]);

    act(() => (rows()[0] as HTMLButtonElement).click());
    expect(mocks.dismissTo).toHaveBeenCalledExactlyOnceWith({
      pathname: "/bot-settings",
      params: { botId: "bot-fixture", model: "openrouter::vendor/model-7" },
    });
  });

  it("remounts the list only when the search query changes", async () => {
    mocks.params = { botId: "bot-fixture", value: "" };
    await act(async () => root.render(<BotModelScreen />));
    const initialList = container.querySelector("ul");
    expect(initialList).not.toBeNull();

    search("vendor/model-7");
    const filteredList = container.querySelector("ul");
    expect(filteredList).not.toBe(initialList);
    search("vendor/model-7");
    expect(container.querySelector("ul")).toBe(filteredList);
    search("no such model");
    const emptyList = container.querySelector("ul");
    expect(emptyList).not.toBe(filteredList);
    search("no such model");
    expect(container.querySelector("ul")).toBe(emptyList);
    search("vendor/model-2");
    const nextList = container.querySelector("ul");
    expect(nextList).not.toBe(emptyList);
    act(() => mocks.setOptions.mock.lastCall![0].headerSearchBarOptions.onCancelButtonPress());
    expect(container.querySelector("ul")).not.toBe(nextList);
    expect(rows()).toHaveLength(12);
  });

  it("says when nothing matches", async () => {
    mocks.params = { botId: "bot-fixture", value: "" };
    await act(async () => root.render(<BotModelScreen />));
    search("no such model");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledExactlyOnceWith("No matching models");
  });
});

// Keep Models mounted as the native stack does, and simulate blur/focus on push/back.
function SettingsStackFixture() {
  return (
    <>
      <div hidden={!mocks.focused}>
        <Models />
      </div>
      {!mocks.focused ? <SettingsModelPickerScreen key={mocks.params.requestId} /> : null}
    </>
  );
}

function modelRow() {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
}

async function renderModels() {
  mocks.params = {};
  mocks.push.mockImplementation(({ params }: { params: Record<string, string> }) => {
    mocks.params = params;
    mocks.focused = false;
    root.render(<SettingsStackFixture />);
  });
  mocks.back.mockImplementation(() => {
    mocks.focused = true;
    root.render(<SettingsStackFixture />);
  });
  await act(async () => root.render(<SettingsStackFixture />));
}

function searchModels(text: string) {
  act(() =>
    mocks.setOptions.mock.calls
      .findLast(([options]) => options.headerSearchBarOptions)![0]
      .headerSearchBarOptions.onChangeText({
        nativeEvent: { text },
      }),
  );
}

function pickerRows() {
  return [...container.querySelectorAll<HTMLButtonElement>("li button")];
}

describe("connection settings model picker", () => {
  it("replaces the catalog radios and search with one row and preserves a pick until Use", async () => {
    await renderModels();
    expect(modelRow().getAttribute("aria-valuetext")).toBe("Model 1");
    expect(modelRow().querySelector("small")).toBeNull();
    expect(modelRow().textContent).toBe("ModelModel 1");
    expect(container.querySelectorAll('button[aria-label="Model"]')).toHaveLength(1);
    expect(container.querySelector('input[aria-label="Search models"]')).toBeNull();
    expect(container.querySelector('[role="radio"]')).toBeNull();
    expect(container.textContent).not.toContain("Model 11");
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("Advanced");
    expect(container.textContent).toContain("Backup models");
    act(() => modelRow().click());
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: "/model-picker",
      params: { requestId: expect.any(String) },
    });
    const id = mocks.params.requestId!;
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Model" });
    expect(pickerRows()).toHaveLength(11);
    expect(
      pickerRows()
        .filter((row) => row.getAttribute("aria-selected") === "true")
        .map((row) => row.textContent),
    ).toEqual(["Model 1"]);
    expect(pickerRows()[0]?.querySelector("[data-checkmark]")).not.toBeNull();
    searchModels("OpenRouter");
    expect(pickerRows()).toHaveLength(11);
    searchModels("vendor/model-3");
    expect(pickerRows().map((row) => row.textContent)).toEqual(["Model 3"]);
    act(() => pickerRows()[0]!.click());
    expect(mocks.back).toHaveBeenCalledOnce();
    expect(modelPickerRequest(id)).toBeUndefined();
    expect(modelRow().getAttribute("aria-valuetext")).toBe("Model 3");
    expect(mocks.dismissKeyboard).toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.filter(([procedure]) => procedure === "models/list")).toHaveLength(
      1,
    );
    expect(mocks.rpc.mock.calls.some(([procedure]) => procedure === "models/setDefault")).toBe(
      false,
    );
    const use = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Use this model",
    )!;
    await act(async () => use.click());
    expect(mocks.rpc).toHaveBeenCalledWith("models/setDefault", {
      provider: "openrouter",
      modelId: "vendor/model-3",
      thinkingLevel: null,
    });
  });

  it("shows only the stripped staged name in the row and vendor-only headings in the settings picker", async () => {
    mocks.vendorLabels = true;
    await renderModels();
    expect(modelRow().getAttribute("aria-valuetext")).toBe("Claude Sonnet 4.5");
    expect(modelRow().querySelector("small")).toBeNull();
    expect(modelRow().textContent).toBe("ModelClaude Sonnet 4.5");
    act(() => modelRow().click());
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Anthropic",
      "Google",
    ]);
    expect(pickerRows()[0]?.textContent).toBe("Claude Sonnet 4.5");
    expect(pickerRows()[0]?.getAttribute("aria-label")).toBe("Anthropic: Claude Sonnet 4.5");
    expect(pickerRows()[1]?.textContent).toBe("Gemini");
    searchModels("does not exist");
    expect(pickerRows()).toHaveLength(0);
    expect(container.querySelector("ul")?.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledWith("No matching models");
  });

  it("keeps the model row usable without a connected key and cancels without losing the draft", async () => {
    mocks.connected = false;
    await renderModels();
    expect(modelRow().getAttribute("aria-valuetext")).toBe("Model 1");
    act(() => modelRow().click());
    const id = mocks.params.requestId!;
    expect(pickerRows()).toHaveLength(11);
    act(() => mocks.back());
    expect(modelRow().getAttribute("aria-valuetext")).toBe("Model 1");
    expect(modelPickerRequest(id)).toBeUndefined();
  });

  it("cleans up requests if the settings owner unmounts while the picker is open", async () => {
    await renderModels();
    act(() => modelRow().click());
    const id = mocks.params.requestId!;
    expect(modelPickerRequest(id)).toBeDefined();
    act(() => root.render(null));
    expect(modelPickerRequest(id)).toBeUndefined();
  });

  it("aborts pending subscription sign-in when settings unmounts with the picker open", async () => {
    mocks.subscriptionSignIn = true;
    let completeSignIn!: (result: { status: "ready" }) => void;
    mocks.completeOAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        completeSignIn = resolve;
      }),
    );
    await renderModels();
    const signIn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Sign in again",
    )!;
    await act(async () => signIn.click());
    expect(mocks.completeOAuth).toHaveBeenCalledOnce();
    const signal = mocks.completeOAuth.mock.lastCall![0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => modelRow().click());
    const id = mocks.params.requestId!;
    expect(modelPickerRequest(id)).toBeDefined();
    expect(signal.aborted).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalledWith("models/cancelOAuth", expect.anything());

    act(() => root.render(null));
    expect(modelPickerRequest(id)).toBeUndefined();
    expect(signal.aborted).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("models/cancelOAuth", { loginId: "login-fixture" });
    await act(async () => completeSignIn({ status: "ready" }));
    expect(mocks.rpc).not.toHaveBeenCalledWith("models/finishOAuth", expect.anything());
  });

  it("omits the model row for an empty catalog", async () => {
    mocks.catalogEmpty = true;
    await renderModels();
    expect(modelRow()).toBeNull();
  });

  it("uses the shared searchable picker to add a backup and saves only on Save backups", async () => {
    await renderModels();
    const add = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Add connected model",
    )!;
    expect(add).toBeDefined();
    act(() => add.click());
    expect(mocks.setOptions).toHaveBeenCalledWith({ title: "Add connected model" });
    expect(pickerRows()).toHaveLength(11);
    searchModels("vendor/model-4");
    act(() => pickerRows()[0]!.click());
    expect(container.textContent).toContain("1. OpenRouter · Model 4");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Save backups",
    )!;
    await act(async () => save.click());
    expect(mocks.rpc).toHaveBeenCalledWith("models/setBackups", [
      { provider: "openrouter", modelId: "vendor/model-4" },
    ]);
  });
});

describe("shared model picker presentation", () => {
  const choices = [
    {
      key: "sonnet",
      label: "Anthropic: Claude Sonnet 4.5",
      modelLabel: "Anthropic: Claude Sonnet 4.5",
      providerLabel: "OpenRouter",
    },
    {
      key: "haiku",
      label: "Anthropic: Claude Haiku",
      modelLabel: "Anthropic: Claude Haiku",
      providerLabel: "OpenRouter",
    },
    {
      key: "gemini",
      label: "Google: Gemini",
      modelLabel: "Google: Gemini",
      providerLabel: "OpenRouter",
    },
    { key: "plain", label: "Plain model", modelLabel: "Plain model", providerLabel: "OpenRouter" },
  ];

  it("groups by vendor, strips titles, leaves ungrouped choices unheaded, filters and announces no matches", async () => {
    await act(async () =>
      root.render(
        <ModelPickerList
          choices={choices}
          selectedKey="sonnet"
          providerLabel="OpenRouter"
          onSelect={() => undefined}
        />,
      ),
    );
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Anthropic",
      "Google",
    ]);
    expect(pickerRows().map((row) => row.textContent)).toEqual([
      "Claude Sonnet 4.5",
      "Claude Haiku",
      "Gemini",
      "Plain model",
    ]);
    expect(pickerRows()[0]?.getAttribute("aria-selected")).toBe("true");
    searchModels("Anthropic");
    expect(pickerRows().map((row) => row.textContent)).toEqual([
      "Claude Sonnet 4.5",
      "Claude Haiku",
    ]);
    searchModels("unknown");
    expect(container.textContent).toBe("No matching models");
    expect(mocks.announce).toHaveBeenCalledWith("No matching models");
  });

  it("renders loading and load errors", async () => {
    await act(async () =>
      root.render(<ModelPickerList choices={null} selectedKey="" onSelect={() => undefined} />),
    );
    expect(container.querySelector("[data-loading]")).not.toBeNull();
    await act(async () =>
      root.render(
        <ModelPickerList
          choices={null}
          selectedKey=""
          onSelect={() => undefined}
          error="Could not load model settings"
        />,
      ),
    );
    expect(container.textContent).toBe("Could not load model settings");
  });

  it("keeps the Android search input mounted while filtering", async () => {
    mocks.platform = "android";
    await act(async () =>
      root.render(
        <ModelPickerList choices={choices} selectedKey="sonnet" onSelect={() => undefined} />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search"]')!;
    expect(input).not.toBeNull();
    expect(mocks.setOptions).not.toHaveBeenCalled();
    // React's controlled input setter plus input event exercises the Android fallback.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "Gemini");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(pickerRows().map((row) => row.textContent)).toEqual(["Gemini"]);
    expect(container.querySelector("input")).toBe(input);
  });
});
