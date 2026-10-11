import { Alert, AppState } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  rpc,
  selectedSpaceId,
  subscribeServerReachable,
} from "./api";
import { cancelFocusPrompt } from "./focus-prompt";
import { t } from "./i18n";
import { resumeLiveNotifications } from "./live-notifications";
import { outboxDisk } from "./outbox-disk";
import {
  currentSessionGeneration,
  currentSessionIdentity,
  loadSessionIdentity,
  loadSessionToken,
} from "./session";
import { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { errorText } from "./user-error";

/**
 * Sends held messages when the server answers again and when the app returns to the foreground,
 * restores the ones a signed-in account left unsent, and reports sends that were not delivered.
 */
export function startUnsentSends(): () => void {
  configureUnsentSends({
    request: async (proc, body, options) => {
      const generation = currentSessionGeneration();
      const context = await captureApiRequestContext();
      if (generation !== currentSessionGeneration()) throw new Error("Session changed");
      return rpc(proc, body, { ...options, requestContext: context });
    },
    serverReachable: isServerReachable,
    scope: () => ({
      apiBase: currentApiBase(),
      spaceId: selectedSpaceId(),
      userId: currentSessionIdentity()?.userId ?? null,
      cacheSession: currentSessionIdentity()?.cacheSession ?? null,
    }),
    disk: outboxDisk,
    errorText: (error) => errorText(error, t("Failed to send message")),
    notDelivered(attempt) {
      Alert.alert(t("Failed to send message"), attempt.error);
    },
    delivered(attempt) {
      if (attempt.payload.initialBotTarget) cancelFocusPrompt(attempt.payload.initialBotTarget);
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
    },
  });
  const generation = currentSessionGeneration();
  let stopped = false;
  void loadSessionIdentity(currentApiBase())
    .then((identity) => {
      if (stopped || generation !== currentSessionGeneration()) return;
      if (identity) restoreUnsentSends();
      else outboxDisk.clear();
    })
    .catch(() => undefined);
  // Sending's own requests flip this too, so it never asks a running send to go round again.
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) void sendWaitingMessages({ ifIdle: true });
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") void sendWaitingMessages();
  });
  return () => {
    stopped = true;
    reachable();
    appState.remove();
  };
}

/** Verify the owner before the composer gives a draft to the outbox. */
export async function prepareUnsentSends(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  let identity = currentSessionIdentity();
  if (!identity || identity.apiBase !== apiBase) identity = await loadSessionIdentity(apiBase);
  if (
    generation !== currentSessionGeneration() ||
    apiBase !== currentApiBase() ||
    spaceId !== selectedSpaceId()
  )
    throw new Error(t("Failed to send message"));
  if (!identity) await rpc("me");
  identity = currentSessionIdentity();
  if (
    !identity ||
    identity.apiBase !== apiBase ||
    generation !== currentSessionGeneration() ||
    apiBase !== currentApiBase() ||
    spaceId !== selectedSpaceId()
  )
    throw new Error(t("Failed to send message"));
  restoreUnsentSends();
}
