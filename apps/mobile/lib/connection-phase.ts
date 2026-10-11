import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isServerReachable, subscribeServerReachable } from "./api";

/** How long the server may be unreachable before the home bar stops saying it is reconnecting. */
export const DISCONNECTED_GRACE_MS = 10_000;

export type ConnectionPhase = "connected" | "reconnecting" | "disconnected";

/**
 * Connected, reconnecting (just lost), or disconnected once that has lasted the grace period.
 * `onDisconnected` runs once per outage, when the grace period runs out.
 */
export function useConnectionPhase(onDisconnected?: () => void): ConnectionPhase {
  const reachable = useSyncExternalStore(subscribeServerReachable, isServerReachable, () => true);
  const [graceOver, setGraceOver] = useState(false);
  const disconnected = useRef(onDisconnected);
  disconnected.current = onDisconnected;
  useEffect(() => {
    setGraceOver(false);
    if (reachable) return;
    const timer = setTimeout(() => {
      setGraceOver(true);
      disconnected.current?.();
    }, DISCONNECTED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [reachable]);
  if (reachable) return "connected";
  return graceOver ? "disconnected" : "reconnecting";
}
