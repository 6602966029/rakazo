import type {
  CapabilityInstall,
  ConnectionCatalogItem,
  McpServer,
  PluginMarketplaceEntry,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import type { PluginCategory } from "@rakazo/core";
import { matchesPluginQuery, PLUGIN_CATEGORIES } from "@rakazo/core";

/** What the plugin screen needs, from a catalog entry or a pasted GitHub URL. */
export type PluginParams = {
  source: string;
  installedSource: string;
  name: string;
  description?: string;
  logo?: string;
  site?: string;
};

export function pluginParams(entry: PluginMarketplaceEntry): PluginParams {
  const site = pluginSite(entry);
  return {
    source: entry.source,
    installedSource: entry.installedSource,
    name: entry.displayName,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.logo ? { logo: entry.logo } : {}),
    ...(site ? { site } : {}),
  };
}

export function gitImportParams(url: string): PluginParams {
  const source = url.trim().replace(/\/$/, "");
  return { source, installedSource: source, name: source.split("/").pop() || source };
}

/** GitHub homepages would give every plugin the same mark, so they never stand in for a site. */
export function pluginSite(
  entry: Pick<PluginMarketplaceEntry, "homepage" | "domains">,
): string | null {
  const domain = entry.domains[0]?.replace(/^https?:\/\//, "").split("/")[0];
  if (domain) return `https://${domain}`;
  try {
    return entry.homepage && !new URL(entry.homepage).hostname.endsWith("github.com")
      ? new URL(entry.homepage).origin
      : null;
  } catch {
    return null;
  }
}

/** A managed app and a plugin with the same name would read as one app listed twice. */
export function browsablePlugins(
  entries: PluginMarketplaceEntry[],
  managed: ConnectionCatalogItem[],
): PluginMarketplaceEntry[] {
  const names = new Set(managed.map((item) => item.name.toLowerCase()));
  return entries.filter((entry) => !names.has(entry.displayName.toLowerCase()));
}

export function pluginCategories(entries: PluginMarketplaceEntry[]): PluginCategory[] {
  return PLUGIN_CATEGORIES.filter((name) => entries.some((entry) => entry.category === name));
}

export function filterPlugins(
  entries: PluginMarketplaceEntry[],
  query: string,
  category: string | null,
  categoryLabel: (name: string) => string,
): PluginMarketplaceEntry[] {
  return entries.filter(
    (entry) =>
      (!category || entry.category === category) &&
      matchesPluginQuery(entry, query, entry.category ? categoryLabel(entry.category) : ""),
  );
}

/** Signed in, or answering without a sign-in. */
export function mcpServerReady(server: McpServer): boolean {
  return server.oauthStatus === "connected" || server.health.status === "ok";
}

export function pluginSkillCount(install: CapabilityInstall): number {
  const parsed = PluginPreviewSchema.safeParse(install.config);
  return parsed.success ? parsed.data.skills.length : 0;
}

export function sourceHref(source: string, sha: string | undefined): string {
  const [repo, subdir] = source.split("#");
  return subdir ? `${repo}/tree/${sha ?? "HEAD"}/${subdir}` : (repo ?? source);
}
