// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { IncomingCall } from "./IncomingCall";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
    "message" in parts ? parts.message : String.raw(parts, ...values);
  return { useLingui: () => ({ t }) };
});
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../lib/call-session", () => ({ startCall: vi.fn(), useCallSession: () => null }));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { answerCall: vi.fn(), declineCall: vi.fn() } },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const close = vi.fn();
const notify = vi.fn();
const start = Date.parse("2026-10-15T00:00:00Z");
function bot(callId: string, expiresAt: number): Bot {
  return {
    id: "bot-1",
    name: "Test bot",
    incomingCall: {
      callId,
      reason: "Review",
      opening: "Ready?",
      expiresAt: new Date(expiresAt).toISOString(),
    },
  } as Bot;
}
function render(bots: Bot[]) {
  act(() => root.render(<IncomingCall bots={bots} onAnswered={vi.fn()} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      close = close;
      constructor(...args: unknown[]) {
        notify(...args);
      }
    },
  );
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.clearAllMocks();
  vi.mocked(rpc.threads.answerCall).mockReset();
  vi.mocked(rpc.threads.declineCall).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uses current time after idle and rejects already expired calls", () => {
  render([]);
  vi.setSystemTime(start + 300_000);
  render([bot("old", start + 45_000)]);
  expect(container.querySelector('[data-testid="incoming-call"]')).toBeNull();
  render([bot("new", start + 315_000)]);
  expect(container.textContent).toContain("00:30");
  act(() => vi.advanceTimersByTime(1000));
  expect(container.textContent).toContain("00:31");
});

it("keeps the notification across roster refreshes and closes it on remote answer", () => {
  render([bot("call-1", start + 45_000)]);
  render([bot("call-1", start + 45_000)]);
  expect(notify).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  render([]);
  expect(close).toHaveBeenCalledOnce();
});

it("closes the notification on expiry", () => {
  render([bot("call-1", start + 1000)]);
  act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector('[data-testid="incoming-call"]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["CONFLICT", "SERVICE_UNAVAILABLE"])(
  "handles %s without losing transient retries",
  async (code) => {
    vi.mocked(rpc.threads.answerCall).mockRejectedValueOnce({ code });
    render([bot("call-1", start + 45_000)]);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Answer")!
        .click();
    });
    expect(Boolean(container.querySelector('[data-testid="incoming-call"]'))).toBe(
      code !== "CONFLICT",
    );
    expect(close).toHaveBeenCalledTimes(code === "CONFLICT" ? 1 : 0);
  },
);

it.each(["Answer", "Decline"])("keeps a failed %s retryable", async (action) => {
  vi.mocked(rpc.threads.answerCall).mockRejectedValue(new Error("Connection failed"));
  vi.mocked(rpc.threads.declineCall).mockRejectedValue(new Error("Connection failed"));
  render([bot("call-1", start + 45_000)]);
  const button = () =>
    [...container.querySelectorAll("button")].find((element) => element.textContent === action)!;
  await act(async () => button().click());
  expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection failed");
  expect(button().disabled).toBe(false);
});

it("keeps private call content out of notifications", () => {
  const caller = bot("call-1", start + 45_000);
  caller.incomingCall!.reason = "Private reason";
  caller.incomingCall!.opening = "Private opening";
  render([caller]);
  expect(notify).toHaveBeenCalledOnce();
  expect(JSON.stringify(notify.mock.calls)).not.toContain("Private");
});
