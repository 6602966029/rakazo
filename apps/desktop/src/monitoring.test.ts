import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  send: vi.fn(async () => ({ statusCode: 200 })),
  flush: vi.fn(async () => true),
}));
const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  setUser: vi.fn(),
  IPCMode: { Classic: 1 },
  eventFiltersIntegration: vi.fn(),
  linkedErrorsIntegration: vi.fn(),
  dedupeIntegration: vi.fn(),
  onUncaughtExceptionIntegration: vi.fn(),
  sentryMinidumpIntegration: vi.fn(),
  makeElectronTransport: vi.fn(),
}));
vi.mock("@sentry/electron/main", () => sdk);
vi.mock("./native-crashes.js", () => ({
  configureNativeCrashReporting: vi.fn(),
  disableNativeCrashReporting: vi.fn(),
}));
const options = { version: "1.0.0", base: "https://app.example.com" };
const config = (body: unknown) => async () => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sdk.init.mockImplementation((options) => options.transport({ url: "initial" }));
  sdk.makeElectronTransport.mockReturnValue(transport);
});

describe("desktop monitoring", () => {
  it("initializes observers once, switches transports, and disables reporting with the server", async () => {
    const monitor = await import("./monitoring.js");
    const error = new Error("startup");
    monitor.reportDesktopError(error, "desktop.startup");
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      options,
    );
    expect(sdk.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: "desktop.startup", surface: "desktop", "monitoring.connection": 1 },
    });
    const initialized = sdk.init.mock.calls[0]![0];
    expect(initialized.getSessions()).toEqual([]);
    const hint = { attachments: [{ data: "private memory" }] };
    const event = initialized.beforeSend(
      { platform: "node", tags: { "monitoring.connection": 1, "native.crash": "true" } },
      hint,
    );
    expect(event.user).toEqual({ ip_address: null });
    expect(hint.attachments).toEqual([]);
    initialized.beforeSend(
      { event_id: "old-event", platform: "node", tags: { "monitoring.connection": 1 } },
      {},
    );
    const delegate = sdk.init.mock.results[0]!.value;
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://other@collector.example.com/9" }),
      { ...options, base: "https://other.example.com" },
    );
    expect(sdk.init).toHaveBeenCalledTimes(1);
    await delegate.send([{ event_id: "old-event" }, []]);
    expect(transport.send).not.toHaveBeenCalled();
    expect(sdk.makeElectronTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://other.example.com/api/monitoring/native/desktop/api/0/envelope/?sentry_key=other",
      }),
    );
    expect(initialized.beforeSend({ tags: { "monitoring.connection": 1 } }, {})).toBeNull();
    await monitor.configureDesktopMonitoring(config({ dsn: null }), options);
    expect(initialized.beforeSend({}, {})).toBeNull();
  });

  it("accepts only the latest identity response when cookies change", async () => {
    const monitor = await import("./monitoring.js");
    await monitor.configureDesktopMonitoring(
      config({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      options,
    );
    let release!: (response: Response) => void;
    const pending = monitor.refreshDesktopMonitoringUser(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await monitor.refreshDesktopMonitoringUser(
      config({ dsn: "https://key@errors.example.com/8", userId: "b".repeat(64) }),
    );
    release(
      new Response(
        JSON.stringify({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      ),
    );
    await pending;
    const initialized = sdk.init.mock.calls[0]![0];
    expect(
      initialized.beforeSend({ platform: "node", tags: { "monitoring.connection": 1 } }, {}).user
        .id,
    ).toBe("b".repeat(64));
  });
  it("does not restore an initial identity after cookies changed during startup", async () => {
    const monitor = await import("./monitoring.js");
    let release!: (response: Response) => void;
    const initial = monitor.configureDesktopMonitoring(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      options,
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await monitor.refreshDesktopMonitoringUser(
      config({ dsn: "https://key@errors.example.com/8", userId: null }),
    );
    release(
      new Response(
        JSON.stringify({ dsn: "https://key@errors.example.com/8", userId: "a".repeat(64) }),
      ),
    );
    await initial;
    const initialized = sdk.init.mock.calls[0]![0];
    expect(
      initialized.beforeSend({ platform: "node", tags: { "monitoring.connection": 1 } }, {}).user,
    ).toEqual({ ip_address: null });
  });
});
