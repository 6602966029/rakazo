import { t } from "@lingui/core/macro";
import { useRef, useState } from "react";
import { authClient } from "./auth";

export async function signOut(): Promise<boolean> {
  try {
    const result = await authClient.signOut();
    if (result.error) return false;

    // Refresh the shared session state before navigation can redirect using stale data.
    const session = authClient.$store.atoms.session;
    if (!session) return false;
    await session.get().refetch({ query: { disableCookieCache: true } });
    const refreshed = session.get();
    return (
      !refreshed.error && !refreshed.isPending && !refreshed.isRefetching && refreshed.data === null
    );
  } catch {
    return false;
  }
}

export function useSignOut(onSuccess: () => void, onError: (message: string) => void) {
  const busy = useRef(false);
  const [signingOut, setSigningOut] = useState(false);

  async function logOut() {
    if (busy.current) return;
    busy.current = true;
    setSigningOut(true);
    try {
      if (await signOut()) onSuccess();
      else onError(t`Could not log out. Try again.`);
    } finally {
      busy.current = false;
      setSigningOut(false);
    }
  }

  return { signingOut, logOut };
}
