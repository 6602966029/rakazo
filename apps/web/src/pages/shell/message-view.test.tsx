// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageView } from "./message-view";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type PeerBot = ComponentProps<typeof MessageView>["peerBot"];
const missingBot: PeerBot = () => undefined;
const existingBot: PeerBot = () => ({ color: "orange" });

function renderChildBot(status: "created" | "archived" | "deleted", peerBot: PeerBot) {
  const onOpenBot = vi.fn();
  const message: ThreadMessage = {
    id: "message",
    threadId: "thread",
    seq: 1,
    role: "bot",
    createdAt: new Date().toISOString(),
    blocks: [{ kind: "child_bot", botId: "child", name: "Planner", status }],
  };
  act(() =>
    root.render(
      <MessageView
        artifactTarget={{ botId: "parent" }}
        canAnswer={false}
        canDismiss={false}
        message={message}
        onAnswer={vi.fn()}
        onOpenBot={onOpenBot}
        onOpenPeerMessages={vi.fn()}
        onTogglePeerReplies={vi.fn()}
        peerBot={peerBot}
        onRefresh={vi.fn()}
        onBotChanged={vi.fn()}
        onAddRoutine={vi.fn()}
        voiceReady={false}
        speaking={false}
        onSpeak={vi.fn()}
        onOpenComputer={vi.fn()}
        showToolActivity={false}
        onReply={vi.fn()}
        onMarkUnread={vi.fn()}
        onReact={vi.fn()}
      />,
    ),
  );
  const link = container.querySelector<HTMLButtonElement>('[data-testid="bot-link"]')!;
  act(() => link.click());
  return { link, onOpenBot };
}

it("links a new bot inline in its color", () => {
  const { link, onOpenBot } = renderChildBot("created", existingBot);
  expect(link.textContent).toBe("Planner");
  expect(link.querySelector("span")?.getAttribute("style")).toContain("color");
  expect(onOpenBot).toHaveBeenCalledWith("child");
});

it.each([
  ["no longer exists", "created", missingBot],
  ["was deleted", "deleted", existingBot],
] as const)("keeps the name without color or link when the bot %s", (_, status, peerBot) => {
  const { link, onOpenBot } = renderChildBot(status, peerBot);
  expect(link.textContent).toContain("Planner");
  expect(link.disabled).toBe(true);
  expect(link.querySelector("span")?.getAttribute("style")).toBeNull();
  expect(onOpenBot).not.toHaveBeenCalled();
});
