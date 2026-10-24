// @vitest-environment jsdom
import type { ModelCatalogEntry, ModelRoleSettings as Settings } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ role: vi.fn(), forRole: vi.fn(), setRole: vi.fn() }));
vi.mock("../lib/localized-provider-hint", () => ({
  providerDisplayName: (provider: string, name: string, auth?: string) =>
    provider === "anthropic" && auth === "oauth" ? "Claude subscription" : name,
}));
vi.mock("../lib/space-rpc", () => {
  const client = { models: api };
  return { useSpaceRpc: () => client };
});
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((text, part, i) => text + part + (values[i] ?? ""), ""),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Spinner: () => null,
}));
vi.mock("./model-settings/model-picker", () => ({
  ModelPicker: ({
    options,
    value,
    provider,
    label,
    disabled,
    placeholder,
    onChange,
  }: {
    options: ModelCatalogEntry[];
    value: string;
    provider?: string;
    label?: string;
    disabled?: boolean;
    placeholder?: string;
    onChange: (value: string, option: ModelCatalogEntry) => void;
  }) => (
    <select
      aria-label={label}
      disabled={disabled}
      value={JSON.stringify([provider ?? "", value])}
      onChange={(event) => {
        const [provider, id] = JSON.parse(event.target.value);
        const option = options.find((entry) => entry.provider === provider && entry.id === id)!;
        onChange(id, option);
      }}
    >
      {placeholder ? <option value={JSON.stringify(["", ""])}>{placeholder}</option> : null}
      {options.map((option) => (
        <option
          key={JSON.stringify([option.provider, option.id])}
          value={JSON.stringify([option.provider, option.id])}
        >
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { ModelRoleSettings } from "./ModelRoleSettings";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "openrouter",
    id: "typesafe/jev-1.14",
    label: "Jev 1.14",
    providerName: "OpenRouter",
    billing: "",
    protocol: "decisions",
  },
  { provider: "openrouter", id: "chat", label: "Chat", providerName: "OpenRouter", billing: "" },
];
const credentials = [
  {
    id: "key",
    provider: "openrouter",
    label: "OpenRouter",
    isDefault: true,
    hasKey: true,
    modelId: "chat",
  },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let saved: Settings;
const props = { userId: "user", spaceId: "space", credentials };
async function render(extra: Partial<ComponentProps<typeof ModelRoleSettings>> = {}) {
  await act(async () => root.render(<ModelRoleSettings {...props} {...extra} />));
}
async function choose(label: string, provider: string, id: string) {
  const field = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => {
    field.value = JSON.stringify([provider, id]);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  await act(async () => button.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = { primary: null, backups: [] };
  api.role.mockReset().mockImplementation(async () => saved);
  api.forRole.mockReset().mockResolvedValue(catalog);
  api.setRole.mockReset().mockImplementation(async ({ role: _r, expectedUserId: _u, ...patch }) => {
    saved = { ...saved, ...patch };
    return saved;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("shared role editor", () => {
  it("selects an approval model through an existing connection and resets to the default", async () => {
    await render({ modelRole: "approval" });
    await choose("Approval model", "openrouter", "typesafe/jev-1.14");
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({
        role: "approval",
        expectedUserId: "user",
        primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
      }),
      { context: { spaceId: "space" } },
    );
    await choose("Approval model", "", "");
    expect(saved.primary).toBeNull();
  });
  it("uses the same add, order and remove controls for main and approval backups", async () => {
    await render();
    await choose("Add backup model", "openrouter", "chat");
    await choose("Add backup model", "openrouter", "typesafe/jev-1.14");
    await click("Move OpenRouter · Jev 1.14 up");
    expect(saved.backups.map((choice) => choice.modelId)).toEqual(["typesafe/jev-1.14", "chat"]);
    await click("Remove OpenRouter · Chat");
    expect(saved.backups).toHaveLength(1);
    expect(api.setRole).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "main" }),
      expect.anything(),
    );
  });
  it("does not replace unseen settings after a failed load and retries", async () => {
    api.role.mockRejectedValueOnce(new Error("offline"));
    await render({ modelRole: "approval" });
    expect(
      (container.querySelector('select[aria-label="Approval model"]') as HTMLSelectElement)
        .disabled,
    ).toBe(true);
    expect(api.setRole).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it("retains confirmed settings when a save fails", async () => {
    saved = { primary: null, backups: [{ provider: "openrouter", modelId: "chat" }] };
    api.setRole.mockRejectedValueOnce(new Error("save failed"));
    await render();
    await click("Remove OpenRouter · Chat");
    expect(container.textContent).toContain("OpenRouter · Chat");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("save failed");
  });
});

it("keeps subscription connection names in saved rows and picker options", async () => {
  api.forRole.mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude",
      label: "Claude",
      providerName: "Anthropic",
      billing: "",
    },
  ]);
  saved = { primary: null, backups: [{ provider: "anthropic", modelId: "claude" }] };
  await render({
    modelRole: "approval",
    credentials: [
      {
        id: "subscription",
        provider: "anthropic",
        label: "Anthropic",
        isDefault: true,
        hasKey: true,
        authKind: "oauth",
        modelId: "claude",
      },
    ],
  });
  expect(container.textContent).toContain("Claude subscription · Claude");
  expect(
    container.querySelector('button[aria-label="Remove Claude subscription · Claude"]'),
  ).not.toBeNull();
});
