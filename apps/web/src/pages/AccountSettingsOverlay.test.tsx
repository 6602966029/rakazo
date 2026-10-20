// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    children,
    onPressedChange,
    pressed: _pressed,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    onPressedChange?: () => void;
    pressed?: boolean;
    variant?: string;
  } & React.ComponentProps<"button">) => (
    <button type="button" onClick={() => onPressedChange?.()} {...props}>
      {children}
    </button>
  ),
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

const accountPolicy = vi.hoisted(() => ({
  passwordChangeEnabled: undefined as boolean | undefined,
}));
vi.mock("../components/AccountAccess", () => ({
  AccountAccess: ({ onSecurity }: { onSecurity: (value: AccountSecurity) => void }) => {
    useEffect(
      () =>
        onSecurity({
          hasPassword: true,
          passwordChangeEnabled: accountPolicy.passwordChangeEnabled,
          freshOidcAuth: false,
          ssoLinked: false,
          emailDeletion: false,
          sso: null,
        }),
      [onSecurity],
    );
    return null;
  },
}));

vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("../components/ai/primitives", () => ({ SuccessPop: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../components/SoftwareUpdateSection", () => ({ SoftwareUpdateSection: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: vi.fn(), updateUser: vi.fn() } }));
vi.mock("../lib/i18n", () => ({
  getActiveUiLocale: () => "en",
  setUiLocale: (locale: string) => Promise.resolve(locale),
}));
vi.mock("../lib/ui-appearance", () => ({
  getUiAppearancePreference: () => "system",
  setUiAppearance: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ Link: ({ children }: { children?: ReactNode }) => children }));

import { authClient } from "../lib/auth";
import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  getComposerEnterToSend,
  setComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { getRemoteImagesEnabled } from "../lib/remote-images-preference";
import { TOOL_ACTIVITY_STORAGE_KEY } from "../lib/tool-activity-preference";
import { GeneralSettingsPanels } from "./AccountSettingsOverlay";

afterEach(() => {
  localStorage.clear();
});

it("flips the stored tool activity preference from the settings toggle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Jamie"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-activity-toggle"]',
    );
    if (!toggle) throw new Error("Missing tool activity toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("on");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("turns loading web images on and off from the settings toggle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Jamie"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-images-toggle"]',
    );
    if (!toggle) throw new Error("Missing remote images toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getRemoteImagesEnabled()).toBe(false);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(getRemoteImagesEnabled()).toBe(true);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getRemoteImagesEnabled()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([undefined, true, false])("respects the password-change policy (%s)", async (enabled) => {
  accountPolicy.passwordChangeEnabled = enabled;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <GeneralSettingsPanels
          name="Test"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      ),
    );
    expect(container.textContent?.includes("Change password")).toBe(enabled !== false);
  } finally {
    await act(async () => root.unmount());
    accountPolicy.passwordChangeEnabled = undefined;
    vi.unstubAllGlobals();
  }
});

it("updates the Enter preference from Settings and reflects external changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setComposerEnterToSend(true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Test"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-enter-to-send-toggle"]',
    );
    if (!toggle) throw new Error("Missing Enter preference");
    expect(container.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe(
      "Send with Enter",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(getComposerEnterToSend()).toBe(false);
    expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("0");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => setComposerEnterToSend(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

async function renderNameEditor(name = "Alex Rivera") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNameSaved = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <GeneralSettingsPanels
        name={name}
        email="demo@example.com"
        avatarStyle="robot"
        onAvatarStyleChange={async () => undefined}
        onNameSaved={onNameSaved}
      />,
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-testid="account-card"]')!;
  const button = (label: string) =>
    [...card.querySelectorAll("button")].find((b) => b.textContent === label)!;
  await act(async () => button("Edit").click());
  const input = card.querySelector("input")!;
  return {
    card,
    input,
    button,
    onNameSaved,
    change: async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    submit: async () =>
      act(async () => {
        card
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("saves a trimmed name and refreshes the account data", async () => {
  vi.mocked(authClient.updateUser).mockResolvedValue({ data: { status: true }, error: null });
  const editor = await renderNameEditor();
  try {
    expect(editor.input.value).toBe("Alex Rivera");
    expect(editor.input.maxLength).toBe(80);
    await editor.change("  Sam Rivera  ");
    await editor.submit();
    expect(authClient.updateUser).toHaveBeenCalledWith({ name: "Sam Rivera" });
    expect(editor.onNameSaved).toHaveBeenCalledOnce();
    expect(editor.card.querySelector("input")).toBeNull();
  } finally {
    await editor.cleanup();
  }
});

it.each(["button", "Escape"])("cancels a name edit with %s without saving", async (method) => {
  vi.mocked(authClient.updateUser).mockClear();
  const editor = await renderNameEditor();
  try {
    await editor.change("Discard me");
    await act(async () => {
      if (method === "button") editor.button("Cancel").click();
      else
        editor.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(editor.card.querySelector("input")).toBeNull();
    expect(editor.card.textContent).toContain("Alex Rivera");
    expect(authClient.updateUser).not.toHaveBeenCalled();
    await act(async () => editor.button("Edit").click());
    expect(editor.card.querySelector("input")!.value).toBe("Alex Rivera");
  } finally {
    await editor.cleanup();
  }
});

it.each(["__AbCdEfGh__", "demo", "demo@example.com"])(
  "starts hidden name %s empty and rejects invalid submissions",
  async (name) => {
    vi.mocked(authClient.updateUser).mockClear();
    const editor = await renderNameEditor(name);
    try {
      expect(editor.input.value).toBe("");
      expect(editor.button("Save").disabled).toBe(true);
      for (const value of ["", "   ", "x".repeat(81)]) {
        await editor.change(value);
        await editor.submit();
      }
      expect(authClient.updateUser).not.toHaveBeenCalled();
      expect(editor.onNameSaved).not.toHaveBeenCalled();
    } finally {
      await editor.cleanup();
    }
  },
);

it.each(["response", "network"])(
  "keeps the draft and shows an inline %s error",
  async (failure) => {
    if (failure === "network")
      vi.mocked(authClient.updateUser).mockRejectedValue(new Error("offline"));
    else
      vi.mocked(authClient.updateUser).mockResolvedValue({
        data: null,
        error: { status: 500, statusText: "Server error" },
      });
    const editor = await renderNameEditor();
    try {
      await editor.change("Sam Rivera");
      await editor.submit();
      expect(editor.card.querySelector('[role="alert"]')?.textContent).toBe(
        "Could not update name",
      );
      expect(editor.input.value).toBe("Sam Rivera");
      expect(editor.button("Save").disabled).toBe(false);
      expect(editor.onNameSaved).not.toHaveBeenCalled();
    } finally {
      await editor.cleanup();
    }
  },
);
