import { Alert, AppState } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  isServerReachable,
  rpc,
  selectedSpaceId,
  subscribeServerReachable,
} from "./api";
import { artifactCacheSession } from "./artifact-cache-session";
import { t } from "./i18n";
import { integrationsCacheScope } from "./integrations-cache";
import { outboxDisk } from "./outbox-disk";
import {
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedIntegrationsScope,
} from "./session";
import type { OutboxScope } from "./thread-feedback";
import { configureUnsentSends, restoreUnsentSends, sendWaitingMessages } from "./thread-feedback";
import { errorText } from "./user-error";

let activeScope: (OutboxScope & { generation: number }) | null = null;
function scope() {
  return activeScope &&
    activeScope.generation === currentSessionGeneration() &&
    activeScope.apiBase === currentApiBase() &&
    activeScope.spaceId === selectedSpaceId()
    ? activeScope
    : null;
}
export async function prepareUnsentSends(): Promise<void> {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  if (!scope()) {
    const saved = await loadVerifiedIntegrationsScope();
    const verified = saved?.apiBase === apiBase ? saved : await integrationsCacheScope();
    const cacheSession = await artifactCacheSession(await loadSessionToken());
    if (
      generation !== currentSessionGeneration() ||
      apiBase !== currentApiBase() ||
      spaceId !== selectedSpaceId()
    )
      throw new Error(t("Failed to send message"));
    activeScope = { apiBase, spaceId, userId: verified.userId, cacheSession, generation };
  }
  restoreUnsentSends();
}
export function startUnsentSends(): () => void {
  configureUnsentSends({
    request: async (proc, body, options) => {
      const generation = currentSessionGeneration();
      const spaceId = selectedSpaceId();
      const context = await captureApiRequestContext();
      if (generation !== currentSessionGeneration() || spaceId !== selectedSpaceId())
        throw new Error("Session changed");
      return rpc(proc, body, { ...options, requestContext: context });
    },
    serverReachable: isServerReachable,
    scope,
    disk: outboxDisk,
    errorText: (error) => errorText(error, t("Failed to send message")),
    notDelivered: (attempt) => Alert.alert(t("Failed to send message"), attempt.error),
  });
  let stopped = false;
  const retry = () =>
    void prepareUnsentSends()
      .then(() => {
        if (!stopped) return sendWaitingMessages();
      })
      .catch(() => undefined);
  retry();
  const reachable = subscribeServerReachable(() => {
    if (isServerReachable()) retry();
  });
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") retry();
  });
  return () => {
    stopped = true;
    reachable();
    appState.remove();
  };
}
