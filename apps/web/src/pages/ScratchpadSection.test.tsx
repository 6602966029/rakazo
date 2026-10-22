// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({
  rpc: { scratchpad: { list: vi.fn().mockResolvedValue([]), remove: vi.fn() } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { rpc } from "../lib/rpc";
import { ScratchpadSection } from "./ScratchpadSection";

it("renders an empty section with a heading and add field without empty-state copy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
    const section = container.querySelector('[data-testid="bot-scratchpad"]')!;
    expect(section.textContent).not.toContain("None yet");
    const heading = section.querySelector("h3");
    expect(heading?.textContent).toBe("Open work");
    expect(heading?.nextElementSibling?.querySelector("form")?.tagName).toBe("FORM");
    expect(section.querySelector('input[placeholder="Add item"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("renders open and parked work without status chrome and removes a wrapped item", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const title =
    "Review the proposed settings and document the remaining decisions before the next design review";
  const item = {
    id: "work-fixture",
    botId: "bot-fixture",
    title,
    notes: "Compare both themes",
    status: "parked" as const,
    createdAt: "",
    updatedAt: "",
  };
  vi.mocked(rpc.scratchpad.list).mockResolvedValueOnce([item]).mockResolvedValueOnce([]);
  vi.mocked(rpc.scratchpad.remove).mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain("Compare both themes");
    expect(container.textContent).not.toContain("parked");
    expect(container.querySelector('[aria-label="Park"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reopen"]')).toBeNull();
    expect(container.querySelector('[aria-label="Complete"]')).not.toBeNull();
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!;
    expect(remove).not.toBeNull();
    await act(async () => remove.click());
    expect(rpc.scratchpad.remove).toHaveBeenCalledWith({ itemId: item.id });
    expect(container.textContent).not.toContain(title);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
