import { parse } from "tldts";

/**
 * Where outbound requests go, by site: the registrable domain (eTLD+1 on ICANN suffixes), or the
 * address itself for an IP literal. Every subdomain of a site belongs to it, so a name like
 * `<data>.example.com` is the same destination as `example.com`, and nothing in the subdomain
 * needs to leave to decide or to fetch it.
 *
 * This lives behind its own entry point so clients that never decide policy skip the suffix list.
 */
export function hostSite(hostname: string): string | undefined {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return undefined;
  const parsed = parse(host);
  if (parsed.isIp || host.startsWith("[")) return host;
  return parsed.domain ?? host;
}

/** The site an http(s) URL is sent to, or undefined for anything else. */
export function urlSite(input: string): string | undefined {
  const url = httpUrl(input);
  return url ? hostSite(url.hostname) : undefined;
}

/** The URL normalized the way it is compared and sent, or undefined when it is not http(s). */
export function normalizedHttpUrl(input: string): string | undefined {
  return httpUrl(input)?.href;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOMAIN_IN_TEXT =
  /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}[a-z0-9](?![\w-])/gi;

/**
 * The sites a person named in their own words: http(s) links and bare domain names on a known
 * public suffix. An address after `@` is an email, not a site to fetch.
 */
export function sitesInText(text: string): Set<string> {
  const sites = new Set<string>();
  for (const [match] of text.matchAll(URL_IN_TEXT)) {
    const site = urlSite(match.replace(/[.,;:!?)\]}]+$/, ""));
    if (site) sites.add(site);
  }
  for (const [match] of text.matchAll(DOMAIN_IN_TEXT)) {
    const parsed = parse(match.toLowerCase());
    if (parsed.isIcann && parsed.domain) sites.add(parsed.domain);
  }
  return sites;
}

function httpUrl(input: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}
