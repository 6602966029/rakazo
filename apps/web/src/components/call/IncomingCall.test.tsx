// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { IncomingCall } from "./IncomingCall";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (value: TemplateStringsArray | { message: string }, ...args: unknown[]) =>
      "message" in value ? value.message : String.raw(value, ...args),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  BotAvatar: () => null,
  defaultBotAvatarValue: () => "currentColor",
}));
vi.mock("../../lib/call-session", () => ({ startCall: vi.fn(), useCallSession: () => null }));
vi.mock("./CallCard", () => ({ callClock: () => "00:00" }));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { answerCall: vi.fn(), declineCall: vi.fn() } },
}));
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const bot = {
  id: "bot-1",
  name: "Bot",
  color: "",
  incomingCall: {
    callId: "call-1",
    reason: "Private reason",
    opening: "Private opening",
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  },
} as Bot;

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
  await act(async () => root.render(<IncomingCall bots={[bot]} onAnswered={vi.fn()} />));
}
afterEach(() => {
  act(() => root?.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  container.replaceChildren();
});

it.each(["Answer", "Decline"])(
  "keeps the call visible and retryable after a failed %s",
  async (action) => {
    vi.mocked(rpc.threads.answerCall).mockRejectedValue(new Error("Connection failed"));
    vi.mocked(rpc.threads.declineCall).mockRejectedValue(new Error("Connection failed"));
    await render();
    const button = () =>
      [...container.querySelectorAll("button")].find((element) => element.textContent === action)!;
    await act(async () => button().click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection failed");
    expect(button().disabled).toBe(false);
  },
);

it("keeps private call content out of notifications", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const notice = vi.fn(
    class {
      close() {}
    },
  );
  Object.assign(notice, { permission: "granted" });
  vi.stubGlobal("Notification", notice);
  await render();
  expect(notice).toHaveBeenCalledOnce();
  expect(JSON.stringify(notice.mock.calls)).not.toContain("Private");
});
