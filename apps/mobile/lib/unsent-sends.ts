import { AppState } from "react-native";
import {
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
import { loadSessionToken } from "./session";
import { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { toast } from "./toast";
import { errorText } from "./user-error";

/**
 * Sends held messages when the server answers again and when the app returns to the foreground,
 * restores the ones a signed-in account left unsent, and reports sends that were not delivered.
 */
export function startUnsentSends(): () => void {
  configureUnsentSends({
    request: rpc,
    serverReachable: isServerReachable,
    scope: () => ({ apiBase: currentApiBase(), spaceId: selectedSpaceId() }),
    disk: outboxDisk,
    errorText: (error) => errorText(error, t("Failed to send message")),
    notDelivered(attempt) {
      toast.show(t("Message not delivered"), {
        variant: "error",
        detail: attempt.error,
        dedupeKey: "chat.sendFailed",
      });
    },
    delivered(attempt) {
      if (attempt.payload.initialBotTarget) cancelFocusPrompt(attempt.payload.initialBotTarget);
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
    },
  });
  void loadSessionToken()
    .then((token) => (token ? restoreUnsentSends() : outboxDisk.clear()))
    .catch(() => undefined);
  // Sending's own requests flip this too, so it never asks a running send to go round again.
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) void sendWaitingMessages({ ifIdle: true });
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") void sendWaitingMessages();
  });
  return () => {
    reachable();
    appState.remove();
  };
}
