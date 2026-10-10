import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ToastModule from "./toast";

// Outside a renderer the hook just reads the store's current snapshot.
vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

let service: typeof ToastModule;

function shown() {
  const snapshot = service.useToastState;
  return snapshot();
}

describe("toast service", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    service = await import("./toast");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one toast at a time in order, each for its duration plus the exit", () => {
    service.toast.show("First", { variant: "error" });
    service.toast.show("Second", { variant: "success" });
    expect(shown()).toMatchObject({ toast: { message: "First" }, leaving: false });

    vi.advanceTimersByTime(service.TOAST_DURATION_MS - 1);
    expect(shown()).toMatchObject({ toast: { message: "First" }, leaving: false });
    vi.advanceTimersByTime(1);
    expect(shown()).toMatchObject({ toast: { message: "First" }, leaving: true });

    vi.advanceTimersByTime(service.TOAST_EXIT_MS);
    expect(shown()).toMatchObject({ toast: { message: "Second", variant: "success" } });
    vi.advanceTimersByTime(service.TOAST_DURATION_MS + service.TOAST_EXIT_MS);
    expect(shown()).toBeNull();
  });

  it("keeps a toast with an action up twice as long", () => {
    service.toast.show("Failed", { variant: "error", action: { label: "Retry", run: vi.fn() } });
    vi.advanceTimersByTime(service.TOAST_DURATION_MS);
    expect(shown()).toMatchObject({ leaving: false });
    vi.advanceTimersByTime(service.TOAST_ACTION_DURATION_MS - service.TOAST_DURATION_MS);
    expect(shown()).toMatchObject({ leaving: true });
  });

  it("refreshes the shown toast with the same key instead of stacking", () => {
    service.toast.show("Offline", { variant: "error", dedupeKey: "send:bot" });
    const first = shown()?.toast.id;
    vi.advanceTimersByTime(service.TOAST_DURATION_MS - 100);
    service.toast.show("Still offline", { variant: "error", dedupeKey: "send:bot" });

    expect(shown()).toMatchObject({ toast: { id: first, message: "Still offline" } });
    // The timer restarts, and nothing was queued behind it.
    vi.advanceTimersByTime(service.TOAST_DURATION_MS - 1);
    expect(shown()).toMatchObject({ leaving: false });
    vi.advanceTimersByTime(1 + service.TOAST_EXIT_MS);
    expect(shown()).toBeNull();
  });

  it("replaces a queued toast with the same key in place", () => {
    service.toast.show("Shown", { variant: "info" });
    service.toast.show("Old", { variant: "error", dedupeKey: "k" });
    service.toast.show("Other", { variant: "error" });
    service.toast.show("New", { variant: "error", dedupeKey: "k" });

    const order: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      order.push(shown()?.toast.message ?? "");
      vi.advanceTimersByTime(service.TOAST_DURATION_MS + service.TOAST_EXIT_MS);
    }
    expect(order).toEqual(["Shown", "New", "Other"]);
    expect(shown()).toBeNull();
  });

  it("dismisses the shown toast through its exit, then shows the next", () => {
    service.toast.show("First", { variant: "error" });
    service.toast.show("Second", { variant: "error" });
    service.toast.dismiss();
    expect(shown()).toMatchObject({ toast: { message: "First" }, leaving: true });
    vi.advanceTimersByTime(service.TOAST_EXIT_MS);
    expect(shown()).toMatchObject({ toast: { message: "Second" }, leaving: false });
  });

  it("dismisses only the toasts carrying a key", () => {
    service.toast.show("Shown", { variant: "error" });
    service.toast.show("Retry me", { variant: "error", dedupeKey: "send:bot" });
    service.toast.dismiss("send:bot");
    expect(shown()).toMatchObject({ toast: { message: "Shown" }, leaving: false });
    vi.advanceTimersByTime(service.TOAST_DURATION_MS + service.TOAST_EXIT_MS);
    expect(shown()).toBeNull();

    service.toast.show("Retry me", { variant: "error", dedupeKey: "send:bot" });
    service.toast.dismiss("send:other");
    expect(shown()).toMatchObject({ leaving: false });
    service.toast.dismiss("send:bot");
    expect(shown()).toMatchObject({ leaving: true });
  });

  it("clears the shown and queued toasts at once", () => {
    service.toast.show("First", { variant: "error" });
    service.toast.show("Second", { variant: "error" });
    service.toast.clear();
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBeNull();
  });

  it("stays silent while suspended, even for a late failure, until resumed", () => {
    service.toast.show("Shown", { variant: "error" });
    service.toast.show("Queued", { variant: "error" });
    service.toast.suspend();
    expect(shown()).toBeNull();

    service.toast.show("Late failure of the old account", { variant: "error" });
    expect(shown()).toBeNull();

    service.toast.resume();
    service.toast.show("Next account", { variant: "info" });
    expect(shown()).toMatchObject({ toast: { message: "Next account" } });
  });

  it("reads as one sentence per part for screen readers", () => {
    expect(
      service.toastAccessibilityLabel({
        id: 1,
        message: "Could not speak",
        detail: "Add a voice provider in Voice settings.",
        variant: "error",
        action: { label: "Open Voice", run: vi.fn() },
      }),
    ).toBe("Could not speak. Add a voice provider in Voice settings. Open Voice");
    expect(
      service.toastAccessibilityLabel({ id: 2, message: "Password updated", variant: "success" }),
    ).toBe("Password updated");
  });
});
