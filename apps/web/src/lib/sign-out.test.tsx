// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOut, useSignOut } from "./sign-out";

const { requestSignOut, refetch, session } = vi.hoisted(() => ({
  requestSignOut: vi.fn(),
  refetch: vi.fn(),
  session: {
    data: null as { user: { id: string } } | null,
    error: null as { status: number } | null,
    isPending: false,
    isRefetching: false,
  },
}));

vi.mock("./auth", () => ({
  authClient: {
    signOut: requestSignOut,
    $store: { atoms: { session: { get: () => ({ ...session, refetch }) } } },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(session, { data: null, error: null, isPending: false, isRefetching: false });
  requestSignOut.mockResolvedValue({ data: { success: true }, error: null });
  refetch.mockResolvedValue(undefined);
});

describe("signOut", () => {
  it("handles an error result without refreshing the session", async () => {
    requestSignOut.mockResolvedValue({ data: null, error: { status: 500 } });
    expect(await signOut()).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("handles a rejected sign-out request", async () => {
    requestSignOut.mockRejectedValue(new Error("Network unavailable"));
    expect(await signOut()).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("fails if the refreshed session still exists", async () => {
    session.data = { user: { id: "user-1" } };
    expect(await signOut()).toBe(false);
    expect(refetch).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
  });

  it("fails if the session refresh returns an error", async () => {
    refetch.mockImplementation(async () => {
      session.error = { status: 500 };
    });
    expect(await signOut()).toBe(false);
  });

  it("handles a rejected session refresh", async () => {
    refetch.mockRejectedValue(new Error("Network unavailable"));
    expect(await signOut()).toBe(false);
  });

  it("does not accept an unfinished session refresh", async () => {
    session.isRefetching = true;
    expect(await signOut()).toBe(false);
  });

  it("waits for the shared session to be cleared before succeeding", async () => {
    session.data = { user: { id: "user-1" } };
    let finishRefresh = () => {};
    refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = () => {
            session.data = null;
            resolve();
          };
        }),
    );
    const result = signOut();
    await vi.waitFor(() => expect(refetch).toHaveBeenCalledOnce());
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRefresh();
    expect(await result).toBe(true);
    expect(requestSignOut).toHaveBeenCalledOnce();
  });
});

it("blocks re-entry, reports failure, and allows a successful retry", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onSuccess = vi.fn();
  const onError = vi.fn();
  let controls: ReturnType<typeof useSignOut>;
  function Harness() {
    controls = useSignOut(onSuccess, onError);
    return (
      <button type="button" disabled={controls.signingOut} onClick={() => void controls.logOut()} />
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  let finishRequest = () => {};
  requestSignOut.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRequest = () => resolve({ error: { status: 500 } });
      }),
  );
  try {
    act(() => root.render(<Harness />));
    let pending: Promise<void>;
    act(() => {
      pending = controls.logOut();
      void controls.logOut();
    });
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(requestSignOut).toHaveBeenCalledOnce();
    await act(async () => {
      finishRequest();
      await pending;
    });
    expect(onError).toHaveBeenCalledWith("Could not log out. Try again.");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => {
      await controls.logOut();
    });
    expect(onSuccess).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
