import type { RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type OAuthCallbackFromOptions = {
  /** SSO callbacks must reach the API, including a loopback API on a separate port. */
  frameName?: string;
  /** App renderer origins — their `/callback` routes must not be treated as paste-flow codes. */
  excludeOrigins?: readonly string[];
};

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Hosted pages that show a paste-back code, keyed by origin. */
const HOSTED_CODE_CALLBACKS = new Map([["https://platform.claude.com", "/oauth/code/callback"]]);

/**
 * Paste-back sign-ins — Anthropic redirects to its hosted code page, older
 * releases to `http://localhost:53692/callback` — carry the authorization code
 * in the redirect URL. The web app asks for the code to be pasted; the desktop
 * main process sees the popup's navigation, so it reads the code from there
 * and the user has nothing to copy.
 */
export function oauthCallbackFrom(
  url: string,
  options: OAuthCallbackFromOptions = {},
): RakazoDesktopOAuthCallback | undefined {
  if (options.frameName === "rakazo-sso-oauth") return undefined;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  const hosted = HOSTED_CODE_CALLBACKS.get(target.origin) === target.pathname;
  if (!hosted && !LOOPBACK_HOSTS.has(target.hostname)) return undefined;
  if (options.excludeOrigins?.includes(target.origin)) return undefined;
  const code = target.searchParams.get("code")?.trim();
  if (!code) return undefined;
  const state = target.searchParams.get("state")?.trim();
  return state ? { code, state } : { code };
}
