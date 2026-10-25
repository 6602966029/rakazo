import type { RouterUtils } from "@orpc/tanstack-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { isRetryableError } from "@rakazo/core";
import { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import type { RpcClient } from "./rpc";
import { createSpaceRpc, rpcForSpace, selectedSpaceId } from "./rpc";
import { useBoundSpaceId } from "./space-rpc";

/**
 * Screens paint what they last saw and refresh it in the background, so moving between
 * spaces, chats, and settings sections does not wait on the network again.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      // Screens refresh when they open; live updates and polling keep open ones current.
      refetchOnWindowFocus: false,
      retry: (failures, error) => failures < 1 && isRetryableError(error),
    },
  },
});

export type SpaceQueries = RouterUtils<RpcClient>;

const scopes = new Map<string, SpaceQueries>();

/**
 * Query helpers for one signed-in user in one space. Both are in every key, so cached data never
 * crosses an auth boundary, and each scope's client pins its own space header.
 */
export function spaceQueries(userId: string | null, spaceId: string | null): SpaceQueries {
  const path = [`user:${userId ?? ""}`, `space:${spaceId ?? ""}`];
  const id = path.join("\n");
  let scope = scopes.get(id);
  if (!scope) {
    scope = createTanstackQueryUtils(spaceId ? rpcForSpace(spaceId) : createSpaceRpc(null), {
      path,
    });
    scopes.set(id, scope);
  }
  return scope;
}

const QueryUserContext = createContext<string | null>(null);

/** The signed-in user whose data the screens below may read from the cache. */
export const QueryUserProvider = QueryUserContext.Provider;

export function useQueryUserId(): string | null {
  return useContext(QueryUserContext);
}

/** Query helpers for the space these components act on: a bound settings space or the selected one. */
export function useSpaceQueries(): SpaceQueries {
  const userId = useQueryUserId();
  const spaceId = useBoundSpaceId() ?? selectedSpaceId();
  return spaceQueries(userId, spaceId);
}

let cachedUserId: string | null | undefined;

/** Forgets everything cached for another user, so sign-out or a switch never shows their data. */
export function setQueryUser(userId: string | null): void {
  if (cachedUserId !== undefined && cachedUserId !== userId) queryClient.clear();
  cachedUserId = userId;
}
