// Import just the classifier: monitoring loads before the app, ahead of the full core barrel.
import { isAbandonedRequest, isConnectionFailure } from "@rakazo/core/user-error";
import type { ClientOperation, MonitoringConfig } from "@rakazo/logging/monitoring";
import {
  createClientErrorReporter,
  isMonitoringUserId,
  nativeMonitoringDsn,
  sanitizeMonitoringEvent,
} from "@rakazo/logging/monitoring";
import type * as NativeSentry from "@sentry/react-native";
import type { StartupErrorStorage } from "./startup-error";
import { clearStartupError, readStartupError, saveStartupError } from "./startup-error";

const errors = createClientErrorReporter();
let sdk: typeof NativeSentry | undefined;
let generation = 0;
let connectionKey: string | undefined;
let configured = false;
let closing: Promise<unknown> = Promise.resolve();
let configuring: Promise<void> | undefined;
let configRequest: AbortController | undefined;
let reportingReady: (() => void) | undefined;
let earlyHandlerInstalled = false;
let pendingStartupError: Error | undefined;
let startupStorage: StartupErrorStorage | undefined;
let startupFromPreviousLaunch = false;

/** Bound the time given to configuration and the native SDK before preserving RN's fatal path. */
async function flushStartupError(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!sdk)
          await new Promise<void>((resolve) => {
            reportingReady = resolve;
          });
        const reporter = sdk;
        const current = generation;
        if (reporter && (await reporter.flush()) && reporter === sdk && current === generation) {
          pendingStartupError = undefined;
          clearStartupError(startupStorage);
        }
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      }),
    ]);
  } catch {
    // The next launch can retry the persisted report.
  } finally {
    clearTimeout(timer);
    reportingReady = undefined;
  }
}

export function reportMobileError(
  error: unknown,
  operation: ClientOperation,
  tags?: Record<string, string>,
): void {
  // A request that lost its connection, timed out or was cancelled is the network, not a bug.
  if (operation === "rpc.transport" && isConnectionFailure(error)) return;
  errors.capture(error, operation, tags);
}

/** Clear account context synchronously, before a server/session change starts any I/O. */
export function resetMobileMonitoring(): void {
  generation += 1;
  configRequest?.abort();
  pendingStartupError = undefined;
  clearStartupError(startupStorage);
  connectionKey = undefined;
  configured = false;
  errors.reset();
  sdk?.setUser(null);
  if (sdk) closing = sdk.close().catch(() => undefined);
  sdk = undefined;
}

/** Runtime configuration belongs to the selected server; no vendor-specific mobile env vars. */
export function configureMobileMonitoring(
  base: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = JSON.stringify([base, headers]);
  if (key === connectionKey && (configured || configuring)) return configuring ?? Promise.resolve();
  // The first anonymous request can be upgraded to this server's saved session. Session
  // changes still call resetMobileMonitoring; do not discard the fatal startup error here.
  if (
    connectionKey !== undefined &&
    key !== connectionKey &&
    connectionKey !== JSON.stringify([base, {}])
  ) {
    errors.reset();
    pendingStartupError = undefined;
    clearStartupError(startupStorage);
  }
  configRequest?.abort();
  connectionKey = key;
  configured = false;
  const current = ++generation;
  sdk?.setUser(null);
  const next = (configuring ?? Promise.resolve()).then(async () => {
    if (current !== generation) return;
    await closing;
    if (sdk) await sdk.close();
    sdk = undefined;
    let config: MonitoringConfig;
    const request = new AbortController();
    configRequest = request;
    const timeout = setTimeout(() => request.abort(), 8_000);
    try {
      const response = await fetchImpl(`${base}/api/monitoring/config`, {
        headers,
        signal: request.signal,
      });
      if (!response.ok) return;
      config = (await response.json()) as MonitoringConfig;
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
      if (configRequest === request) configRequest = undefined;
    }
    if (current !== generation) return;
    if (!config.dsn) {
      configured = true;
      errors.install(undefined);
      pendingStartupError = undefined;
      clearStartupError(startupStorage);
      reportingReady?.();
      return;
    }
    try {
      const Sentry = await import("@sentry/react-native");
      const { Platform } = await import("react-native");
      if (current !== generation) return;
      const userId = isMonitoringUserId(config.userId) ? config.userId : undefined;
      Sentry.init({
        dsn: nativeMonitoringDsn(base, config.dsn, "mobile"),
        environment: config.environment ?? undefined,
        // Keep the native binary release for symbolication, distinct from the server release.
        sendDefaultPii: false,
        enableLogs: false,
        enableAutoSessionTracking: false,
        enableAutoPerformanceTracing: false,
        maxBreadcrumbs: 0,
        attachScreenshot: false,
        attachViewHierarchy: false,
        enableNativeNagger: false,
        integrations: (defaults) =>
          defaults.filter((integration) =>
            [
              "ReactNativeErrorHandlers",
              "LinkedErrors",
              "Dedupe",
              "NativeLinkedErrors",
              "EventFilters",
              "NativeRelease",
              "ReactNativeInfo",
              "RewriteFrames",
              "DebugMeta",
              "SdkInfo",
              "EventOrigin",
            ].includes(integration.name),
          ),
        beforeBreadcrumb: () => null,
        beforeSend: (event, hint) => {
          if (current !== generation || isAbandonedRequest(hint?.originalException)) return null;
          if (Platform.OS === "ios" || Platform.OS === "android")
            event.tags = { ...event.tags, "mobile.platform": Platform.OS };
          return sanitizeMonitoringEvent(
            event,
            event.tags?.["startup.previous_launch"] === "true" ? undefined : userId,
          );
        },
      });
      sdk = Sentry;
      configured = true;
      Sentry.setTag("surface", "mobile");
      if (Platform.OS === "ios" || Platform.OS === "android")
        Sentry.setTag("mobile.platform", Platform.OS);
      Sentry.setUser(userId ? { id: userId, ip_address: null } : null);
      errors.install({
        capture: (error, operation, tags) => {
          if (current === generation)
            Sentry.captureException(error, { tags: { ...tags, operation, surface: "mobile" } });
        },
      });
      if (pendingStartupError) {
        Sentry.captureException(pendingStartupError, {
          mechanism: { handled: false, type: "onerror" },
          captureContext: {
            level: "fatal",
            tags: {
              operation: "mobile.startup",
              surface: "mobile",
              ...(startupFromPreviousLaunch ? { "startup.previous_launch": "true" } : {}),
            },
          },
        });
      }
      if (reportingReady) reportingReady();
      else if (pendingStartupError) void flushStartupError();
    } catch {
      // Retain the bounded startup queue; foreground/reconnect retries configuration.
    }
  });
  const pending = next.catch(() => undefined);
  configuring = pending;
  void pending.finally(() => {
    if (configuring === pending) configuring = undefined;
  });
  return pending;
}

/** Install before Expo Router imports so early JS failures retain their original handler. */
export function installMobileEarlyErrorReporting(storage: StartupErrorStorage): void {
  if (earlyHandlerInstalled) return;
  earlyHandlerInstalled = true;
  startupStorage = storage;
  pendingStartupError = readStartupError(storage);
  startupFromPreviousLaunch = pendingStartupError !== undefined;
  const target = globalThis as typeof globalThis & {
    ErrorUtils?: {
      getGlobalHandler(): (error: Error, fatal?: boolean) => void;
      setGlobalHandler(handler: (error: Error, fatal?: boolean) => void): void;
    };
  };
  const previous = target.ErrorUtils?.getGlobalHandler();
  if (previous)
    target.ErrorUtils?.setGlobalHandler((error, fatal) => {
      if (!sdk) {
        if (fatal) {
          pendingStartupError = error;
          startupFromPreviousLaunch = false;
          saveStartupError(error, startupStorage);
          void flushStartupError().finally(() => previous(error, fatal));
          return;
        }
        reportMobileError(error, "react.render");
      }
      previous(error, fatal);
    });
}
