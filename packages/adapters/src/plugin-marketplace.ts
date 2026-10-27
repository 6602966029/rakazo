import type { PluginMarketplaceCatalog, PluginMarketplaceEntry } from "@rakazo/contracts";
import { comparePlugins, matchesPluginQuery, pluginCategory } from "@rakazo/core";
import { z } from "zod";
import type { PluginTextReader } from "./plugin-connectors.js";
import { parsePluginSource } from "./plugin-connectors.js";
import { fetchSafeWebText } from "./web-ssrf.js";

const REGISTRIES = [
  {
    name: "Cursor",
    repository: "https://github.com/cursor/plugins",
    path: ".cursor-plugin/marketplace.json",
    manifest: ".cursor-plugin/plugin.json",
  },
  {
    name: "xAI",
    repository: "https://github.com/xai-org/plugin-marketplace",
    path: ".grok-plugin/marketplace.json",
    manifest: ".grok-plugin/plugin.json",
  },
];
const MANIFEST_TTL_MS = 60 * 60_000;
const MANIFEST_CONCURRENCY = 16;
const entrySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).optional(),
  keywords: z.array(z.string().max(120)).max(50).optional(),
  category: z.string().trim().min(1).max(60).optional().catch(undefined),
  homepage: z.string().url().max(2048).optional().catch(undefined),
  domains: z.array(z.string().max(253)).max(20).optional().catch(undefined),
  source: z.union([
    z.string().max(2048),
    z.object({
      source: z.literal("url"),
      url: z.string().max(2048),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
      path: z.string().max(2048).optional(),
    }),
    z.object({ type: z.literal("local"), path: z.string().startsWith("./").max(2048) }),
  ]),
});

/** Public indexes are discovery hints, never installation authority. The
 * separate preview/digest gate validates and pins the selected package. */
export function parsePluginMarketplace(
  raw: string,
  registry: { name: string; repository: string },
): { entries: PluginMarketplaceEntry[]; skipped: number } {
  const index: unknown = JSON.parse(raw);
  if (
    !index ||
    typeof index !== "object" ||
    !("plugins" in index) ||
    !Array.isArray(index.plugins) ||
    index.plugins.length > 1000
  ) {
    throw new Error("Invalid marketplace index");
  }
  const entries: PluginMarketplaceEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const candidate of index.plugins) {
    const parsed = entrySchema.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const entry = parsed.data;
    try {
      const source = entry.source;
      const from =
        typeof source === "string"
          ? source.startsWith("https://")
            ? source
            : `${registry.repository}#${source.replace(/^\.\//, "")}`
          : !("url" in source)
            ? `${registry.repository}#${source.path.slice(2)}`
            : source.path
              ? `${source.url}#${source.path.replace(/^\.?\//, "")}`
              : source.url;
      const ref = parsePluginSource(from);
      if (new URL(ref.gitUrl).hostname !== "github.com") throw new Error("Unsupported plugin host");
      if (typeof source !== "string" && "sha" in source && ref.ref && ref.ref !== source.sha)
        throw new Error("Conflicting plugin pin");
      const pin = typeof source !== "string" && "sha" in source ? source.sha : ref.ref;
      const suffix = ref.subdir ? `#${ref.subdir}` : "";
      const installedSource = ref.gitUrl + suffix;
      const installSource = ref.gitUrl + (pin ? `@${pin}` : "") + suffix;
      if (seen.has(installSource)) {
        skipped++;
        continue;
      }
      seen.add(installSource);
      entries.push({
        id: `${registry.name}:${installSource}`,
        name: entry.name,
        displayName: displayName(entry.name),
        description: entry.description ?? "",
        keywords: entry.keywords ?? [],
        category: entry.category?.toLowerCase() ?? null,
        logo: null,
        homepage: entry.homepage ?? null,
        domains: entry.domains ?? [],
        registry: registry.name,
        source: installSource,
        installedSource,
      });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

const manifestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional().catch(undefined),
  category: z.string().trim().min(1).max(60).optional().catch(undefined),
  logo: z
    .string()
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.(svg|png|jpe?g|webp)$/i)
    .max(512)
    .optional()
    .catch(undefined),
});

function displayName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

const publicRead: PluginTextReader = async (url, maxBytes, signal) =>
  (await fetchSafeWebText(url, { maxBytes, signal })).body;

/** Cache is per API router instance; failures are never cached. Concurrent
 * requests share one bounded fetch, without sharing an actor's abort signal. */
export function createPluginMarketplace(read: PluginTextReader = publicRead) {
  const cache = new Map<
    string,
    { expires: number; data: ReturnType<typeof parsePluginMarketplace> }
  >();
  const pending = new Map<string, Promise<ReturnType<typeof parsePluginMarketplace>>>();
  const manifests = new Map<string, { expires: number; data: z.infer<typeof manifestSchema> }>();
  /** Plugins vendored in a registry repo describe their title, category and logo in a
   * manifest beside them. Missing or invalid manifests leave the index metadata alone. */
  async function withManifests(
    registry: (typeof REGISTRIES)[number],
    entries: PluginMarketplaceEntry[],
  ): Promise<PluginMarketplaceEntry[]> {
    const raw = `https://raw.githubusercontent.com${new URL(registry.repository).pathname}/HEAD/`;
    const prefix = `${registry.repository}#`;
    const signal = AbortSignal.timeout(8_000);
    const queue = entries.filter((entry) => entry.installedSource.startsWith(prefix));
    const workers = Array.from({ length: MANIFEST_CONCURRENCY }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const url = `${raw}${entry.installedSource.slice(prefix.length)}/${registry.manifest}`;
        const cached = manifests.get(url);
        if (cached && cached.expires > Date.now()) continue;
        try {
          const data = manifestSchema.parse(JSON.parse(await read(url, 64_000, signal)));
          manifests.set(url, { data, expires: Date.now() + MANIFEST_TTL_MS });
        } catch {
          if (signal.aborted) return;
        }
      }
    });
    await Promise.all(workers);
    return entries.map((entry) => {
      if (!entry.installedSource.startsWith(prefix)) return entry;
      const dir = entry.installedSource.slice(prefix.length);
      const manifest = manifests.get(`${raw}${dir}/${registry.manifest}`)?.data;
      if (!manifest) return entry;
      return {
        ...entry,
        displayName: manifest.displayName ?? entry.displayName,
        category: entry.category ?? manifest.category?.toLowerCase() ?? null,
        logo: manifest.logo ? `${raw}${dir}/${manifest.logo.replace(/^\.\//, "")}` : null,
      };
    });
  }
  async function registryData(registry: (typeof REGISTRIES)[number]) {
    const cached = cache.get(registry.name);
    if (cached && cached.expires > Date.now()) return cached.data;
    const active = pending.get(registry.name);
    if (active) return active;
    const request = (async () => {
      const repo = new URL(registry.repository).pathname;
      const text = await read(
        `https://raw.githubusercontent.com${repo}/HEAD/${registry.path}`,
        2_000_000,
        AbortSignal.timeout(15_000),
      );
      if (Buffer.byteLength(text) > 2_000_000) throw new Error("Marketplace index is too large");
      const parsed = parsePluginMarketplace(text, registry);
      const data = { ...parsed, entries: await withManifests(registry, parsed.entries) };
      cache.set(registry.name, { data, expires: Date.now() + 60_000 });
      return data;
    })();
    pending.set(registry.name, request);
    try {
      return await request;
    } finally {
      pending.delete(registry.name);
    }
  }
  return {
    async catalog(query: string): Promise<PluginMarketplaceCatalog> {
      const results = await Promise.allSettled(REGISTRIES.map(registryData));
      const entries: PluginMarketplaceEntry[] = [];
      const unavailableRegistries: string[] = [];
      let skippedEntries = 0;
      for (const [i, result] of results.entries()) {
        if (result.status === "fulfilled") {
          entries.push(...result.value.entries);
          skippedEntries += result.value.skipped;
        } else unavailableRegistries.push(REGISTRIES[i]!.name);
      }
      return {
        entries: entries
          .map((entry) => ({ ...entry, category: pluginCategory(entry) }))
          .filter((entry) => matchesPluginQuery(entry, query))
          .sort(comparePlugins),
        unavailableRegistries,
        skippedEntries,
      };
    },
  };
}
