import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@rakazo/core";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { isPasswordCompromised } from "better-auth/plugins/haveibeenpwned";

/** Routes that set a new password, and the body field that carries it. Sign-in is never checked. */
const NEW_PASSWORD_FIELDS = new Map([
  ["/sign-up/email", "password"],
  ["/change-password", "newPassword"],
  ["/reset-password", "newPassword"],
  ["/set-password", "newPassword"],
]);

const CHECK_TIMEOUT_MS = 3_000;

/**
 * Rejects new passwords found in the Have I Been Pwned corpus. Only a five-character SHA-1
 * prefix leaves the server. The check fails open: when the service is slow or unreachable the
 * password is accepted and the failure logged, so an outside service never blocks sign-up.
 */
export function breachedPasswordCheck(
  isCompromised: (password: string) => Promise<boolean> = isPasswordCompromised,
) {
  return {
    id: "breached-password-check",
    hooks: {
      before: [
        {
          matcher: (ctx) => NEW_PASSWORD_FIELDS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const field = NEW_PASSWORD_FIELDS.get(ctx.path)!;
            const password: unknown = ctx.body?.[field];
            // Better Auth rejects out-of-range lengths itself; don't send those anywhere.
            if (
              typeof password !== "string" ||
              password.length < MIN_PASSWORD_LENGTH ||
              password.length > MAX_PASSWORD_LENGTH
            )
              return;
            let compromised: boolean;
            try {
              compromised = await withTimeout(isCompromised(password), CHECK_TIMEOUT_MS);
            } catch (error) {
              ctx.context.logger.error("Breached password check unavailable", error);
              return;
            }
            if (compromised) {
              throw new APIError("BAD_REQUEST", {
                code: "PASSWORD_COMPROMISED",
                message: "This password appeared in a data breach. Choose another.",
              });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Breached password check timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
