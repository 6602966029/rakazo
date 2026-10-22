import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  close: vi.fn(async () => {}),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock("@sentry/react-native", () => sdk);
const response = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("mobile monitoring", () => {
  it("stays optional, reports caught startup errors, and strips private data", async () => {
    const monitor = await import("./monitoring");
    const error = new Error("startup");
    monitor.reportMobileError(error, "react.render");
    await monitor.configureMobileMonitoring(
      "https://app.example.com",
      {},
      response({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
    );
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "react.render", surface: "mobile" },
    });
    const options = sdk.init.mock.calls[0]![0];
    expect(options).toMatchObject({
      sendDefaultPii: false,
      enableLogs: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
    });
    expect(
      options.beforeSend({ extra: { secret: "private" }, user: { email: "private" } }),
    ).toEqual({ user: { id: "a".repeat(64), ip_address: null } });
    monitor.resetMobileMonitoring();
    expect(options.beforeSend({})).toBeNull();
    expect(sdk.setUser).toHaveBeenLastCalledWith(null);
    await monitor.configureMobileMonitoring(
      "https://other.example.com",
      {},
      response({ dsn: null }),
    );
    monitor.reportMobileError(new Error("off"), "react.render");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });

  it("ignores stale config replies after a server change", async () => {
    const monitor = await import("./monitoring");
    let release!: (response: Response) => void;
    const pending = monitor.configureMobileMonitoring(
      "https://old.example.com",
      {},
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ) as unknown as typeof fetch,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    monitor.resetMobileMonitoring();
    release(new Response(JSON.stringify({ dsn: "https://key@errors.example.com/8" })));
    await pending;
    expect(sdk.init).not.toHaveBeenCalled();
  });

  it("does not reinitialize unchanged native handlers when foregrounding", async () => {
    const monitor = await import("./monitoring");
    const fetchImpl = response({ dsn: "https://key@errors.example.com/8" });
    await monitor.configureMobileMonitoring("https://app.example.com", {}, fetchImpl);
    await monitor.configureMobileMonitoring("https://app.example.com", {}, fetchImpl);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    monitor.reportMobileError(new Error("after foreground"), "voice.turn");
    expect(sdk.captureException).toHaveBeenCalledTimes(1);
  });
});
