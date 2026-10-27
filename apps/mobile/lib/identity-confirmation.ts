import type { AccountSecurity } from "@rakazo/contracts";
import { t } from "./i18n";

export type IdentityMethod = "sso" | "email";

export type IdentityConfirmationDeps = {
  fetchAccountSecurity: () => Promise<AccountSecurity>;
  confirmIdentity: (proof: { password: string } | { code: string }) => Promise<void>;
  requestIdentityCode: () => Promise<void>;
  /** A fresh SSO sign-in that replaces this device's session; false when dismissed. */
  reauthenticate: () => Promise<boolean>;
  /** How an account without a password confirms; null when dismissed. */
  choose: (methods: IdentityMethod[]) => Promise<IdentityMethod | null>;
  /** Asks for the password or emailed code, showing the last failure; null when dismissed. */
  ask: (kind: "password" | "code", error: string | null) => Promise<string | null>;
  errorText: (error: unknown) => string;
};

/**
 * Confirms it's the signed-in person: their password, or for accounts without one, a fresh
 * SSO sign-in or an emailed code. A wrong entry asks again until it succeeds or is dismissed.
 */
export async function confirmIdentityOnDevice(deps: IdentityConfirmationDeps): Promise<boolean> {
  const security = await deps.fetchAccountSecurity();
  let kind: "password" | "code" = "password";
  if (!security.hasPassword) {
    const methods: IdentityMethod[] = [
      ...(security.sso && security.ssoLinked ? (["sso"] as const) : []),
      ...(security.emailDeletion ? (["email"] as const) : []),
    ];
    if (!methods.length) throw new Error(t("Could not continue"));
    const method = await deps.choose(methods);
    if (method === "sso") return deps.reauthenticate();
    if (method !== "email") return false;
    await deps.requestIdentityCode();
    kind = "code";
  }
  let error: string | null = null;
  for (;;) {
    const entered = await deps.ask(kind, error);
    const secret = kind === "code" ? entered?.trim() : entered;
    if (!secret) return false;
    try {
      await deps.confirmIdentity(kind === "password" ? { password: secret } : { code: secret });
      return true;
    } catch (cause) {
      error = deps.errorText(cause);
    }
  }
}
