import type { PluginMarketplaceEntry } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  filterPlugins,
  gitImportParams,
  pluginCategories,
  pluginSite,
  sourceHref,
} from "./plugin-marketplace";

const entry = (overrides: Partial<PluginMarketplaceEntry>): PluginMarketplaceEntry => ({
  id: "id",
  name: "name",
  displayName: "Name",
  description: "",
  keywords: [],
  category: null,
  logo: null,
  homepage: null,
  domains: [],
  registry: "Cursor",
  source: "https://github.com/acme/plugins",
  installedSource: "https://github.com/acme/plugins",
  hasConnector: true,
  skillCount: 0,
  ...overrides,
});

it("uses the product's own site for an icon, never GitHub's", () => {
  expect(pluginSite(entry({ domains: ["cal.com"] }))).toBe("https://cal.com");
  expect(pluginSite(entry({ homepage: "https://sentry.io/for/ai" }))).toBe("https://sentry.io");
  expect(pluginSite(entry({ homepage: "https://github.com/acme/plugin" }))).toBeNull();
});

it("filters by category and matches word prefixes, including the category label", () => {
  const plugins = [
    entry({ id: "a", displayName: "Calcom", keywords: ["scheduling"], category: "productivity" }),
    entry({ id: "b", displayName: "Sentry", description: "Error monitoring", category: "ops" }),
  ];
  const label = (name: string) => (name === "ops" ? "Security & Ops" : name);
  expect(filterPlugins(plugins, "cal sched", null, label).map((row) => row.id)).toEqual(["a"]);
  expect(filterPlugins(plugins, "", "productivity", label).map((row) => row.id)).toEqual(["a"]);
  expect(filterPlugins(plugins, "secu", null, label).map((row) => row.id)).toEqual(["b"]);
  expect(filterPlugins(plugins, "error", "productivity", label)).toEqual([]);
});

it("lists only present categories in product order", () => {
  const plugins = [entry({ category: "ops" }), entry({ category: "productivity" })];
  expect(pluginCategories(plugins)).toEqual(["productivity", "ops"]);
});

it("links a pinned subfolder to its tree and names a pasted URL after its last segment", () => {
  expect(sourceHref("https://github.com/acme/plugins#calcom", "abc")).toBe(
    "https://github.com/acme/plugins/tree/abc/calcom",
  );
  expect(gitImportParams(" https://github.com/acme/neon/ ")).toEqual({
    source: "https://github.com/acme/neon",
    installedSource: "https://github.com/acme/neon",
    name: "neon",
  });
});
