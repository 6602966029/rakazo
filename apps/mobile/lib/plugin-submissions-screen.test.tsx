// @vitest-environment jsdom

import type { PluginSubmission } from "@rakazo/contracts";
import { notifyManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginSubmissions from "../app/(settings)/plugin-submissions";
import { queryClient } from "./query";

const { calls, platform, prompt, alert, review } = vi.hoisted(() => ({
  calls: [] as [string, unknown][],
  platform: { OS: "ios" },
  prompt: vi.fn(),
  alert: vi.fn(),
  review: { failure: null as Error | null },
}));

const submission: PluginSubmission = {
  id: "submission-1",
  email: "maker@example.test",
  name: "Fixture Plugin",
  website: null,
  logo: "https://example.test/logo.png",
  source: "https://github.com/example/fixture-plugin",
  description: "Does fixture things.",
  testing: "Install it and ask for a fixture.",
  status: "pending",
  reason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  reviewedAt: null,
};

vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  captureApiRequestContext: async () => ({ headers: {} }),
  selectedSpaceId: () => "space-fixture",
  rpc: async (procedure: string, input?: unknown) => {
    calls.push([procedure, input]);
    if (procedure === "marketplace/submissions") return [submission];
    if (procedure === "marketplace/review") {
      if (review.failure) throw review.failure;
      return submission;
    }
    throw new Error(`Unexpected ${procedure}`);
  },
}));
vi.mock("./native", () => ({
  native: new Proxy({}, { get: (_target, name) => String(name) }),
  useThemedStyles: (createStyles: () => unknown) => createStyles(),
}));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback = "Something went wrong. Try again.") =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});
vi.mock("../components/connector-icon", () => ({ ConnectorIcon: () => null }));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message }: { message: string }) => createElement("p", {}, message),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => createElement("button", { type: "button", disabled, onClick: onPress }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "div",
      {},
      options.map((option) =>
        createElement(
          "button",
          { key: option.value, type: "button", onClick: () => onChange(option.value) },
          option.label,
        ),
      ),
    ),
}));
vi.mock("../components/name-dialog", () => ({
  TextFieldDialog: ({
    label,
    submitLabel,
    value,
    onChange,
    onSubmit,
  }: {
    label: string;
    submitLabel: string;
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
  }) =>
    createElement(
      "section",
      {},
      createElement("input", {
        "aria-label": label,
        value,
        onInput: (event: { currentTarget: HTMLInputElement }) =>
          onChange(event.currentTarget.value),
      }),
      createElement("button", { type: "button", onClick: () => onSubmit(value) }, submitLabel),
    ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  SettingsLabel: ({ children }: { children?: ReactNode }) => createElement("h3", {}, children),
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, title),
}));
vi.mock("react-native", () => {
  const view = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return {
    ActivityIndicator: () => null,
    Alert: { alert, prompt },
    Linking: { openURL: vi.fn() },
    Platform: platform,
    ScrollView: view,
    StyleSheet: { create: (styles: unknown) => styles },
    Text: view,
    View: view,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
}));

notifyManager.setScheduler((callback) => callback());

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  calls.length = 0;
  platform.OS = "ios";
  review.failure = null;
  prompt.mockReset();
  alert.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(PluginSubmissions)));
  await press("Fixture Plugin");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string) {
  return Array.from(container.querySelectorAll("button")).find((node) => node.textContent === name);
}

async function press(name: string) {
  const target = button(name);
  if (!target) throw new Error(`No ${name} button`);
  await act(async () => target.click());
}

const reviews = () => calls.filter(([procedure]) => procedure === "marketplace/review");
const lists = () => calls.filter(([procedure]) => procedure === "marketplace/submissions");

it("lists pending submissions and shows the details when opened", () => {
  expect(lists()).toEqual([["marketplace/submissions", { status: "pending" }]]);
  expect(container.textContent).toContain("github.com/example/fixture-plugin");
  expect(container.textContent).toContain("Install it and ask for a fixture.");
});

it("approves a submission and reloads the list", async () => {
  await press("Approve");
  expect(reviews()).toEqual([["marketplace/review", { id: "submission-1", decision: "approve" }]]);
  expect(lists()).toHaveLength(2);
});

it("shows why an approval failed", async () => {
  review.failure = new Error("Could not preview a supported plugin from this repository");
  await press("Approve");
  expect(alert).toHaveBeenCalledWith("Could not preview a supported plugin from this repository");
});

it("asks again on iOS until a rejection has a reason, then sends it", async () => {
  await press("Reject");
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(prompt.mock.calls[0]?.[0]).toBe("Why reject Fixture Plugin?");
  const submit = (value: string) =>
    act(async () => {
      prompt.mock.lastCall?.[2][1].onPress(value);
    });

  await submit("   ");
  expect(prompt).toHaveBeenCalledTimes(2);
  expect(reviews()).toEqual([]);

  await submit("  No connector in the repository  ");
  expect(reviews()).toEqual([
    [
      "marketplace/review",
      { id: "submission-1", decision: "reject", reason: "No connector in the repository" },
    ],
  ]);
});

it("asks for the rejection reason in a dialog on Android", async () => {
  platform.OS = "android";
  await press("Reject");
  const dialog = container.querySelector("section")!;
  const submit = Array.from(dialog.querySelectorAll("button")).find(
    (node) => node.textContent === "Reject",
  )!;
  await act(async () => submit.click());
  expect(reviews()).toEqual([]);

  const input = dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "Broken install");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => submit.click());
  expect(reviews()).toEqual([
    ["marketplace/review", { id: "submission-1", decision: "reject", reason: "Broken install" }],
  ]);
  expect(container.querySelector("section")).toBeNull();
});
