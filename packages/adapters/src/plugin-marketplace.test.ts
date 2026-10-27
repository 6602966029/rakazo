import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMarketplace, parsePluginMarketplace } from "./plugin-marketplace.js";

const registry = { name: "Cursor", repository: "https://github.com/example/plugins" };
const index = (plugins: unknown[]) => JSON.stringify({ name: "example", plugins });
const sha = "a".repeat(40);
const indexReads = (read: { mock: { calls: unknown[][] } }) =>
  read.mock.calls.filter(([url]) => String(url).endsWith("marketplace.json")).length;
afterEach(() => vi.restoreAllMocks());

describe("public marketplace indexes", () => {
  it("maps Cursor relative directories to importable sources", () => {
    const result = parsePluginMarketplace(
      index([{ name: "notes", source: "./notes", description: "Daily notes" }]),
      registry,
    );
    expect(result.entries).toEqual([
      {
        id: "Cursor:https://github.com/example/plugins#notes",
        name: "notes",
        displayName: "Notes",
        description: "Daily notes",
        keywords: [],
        category: null,
        logo: null,
        homepage: null,
        domains: [],
        registry: "Cursor",
        source: "https://github.com/example/plugins#notes",
        installedSource: "https://github.com/example/plugins#notes",
      },
    ]);
  });
  it("loads xAI local-directory source objects without allowing traversal", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "neon", source: { type: "local", path: "./external_plugins/neon" } },
        { name: "escape", source: { type: "local", path: "./../escape" } },
      ]),
      { name: "xAI", repository: "https://github.com/example/index" },
    );
    expect(result.entries[0]?.source).toBe(
      "https://github.com/example/index#external_plugins/neon",
    );
    expect(result.skipped).toBe(1);
  });
  it("preserves xAI URL-object pins and canonical installed identity", () => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "tasks",
          source: { source: "url", url: "https://github.com/Example/Tasks.git", sha },
          keywords: ["planning"],
        },
      ]),
      { name: "xAI", repository: "https://github.com/example/index" },
    );
    expect(result.entries[0]).toMatchObject({
      source: `https://github.com/example/tasks@${sha}`,
      installedSource: "https://github.com/example/tasks",
      registry: "xAI",
      keywords: ["planning"],
    });
  });
  it("loads direct GitHub sources, reports invalid entries and removes duplicates", () => {
    const result = parsePluginMarketplace(
      index([
        { name: "valid", source: "https://github.com/example/valid/tree/main/subdir" },
        { name: "duplicate", source: "https://github.com/example/valid@main#subdir" },
        { name: "traversal", source: "../escape" },
        { name: "absolute", source: "/root" },
        { name: "private", source: "https://127.0.0.1/a/b" },
        { name: "credentials", source: "https://user:password@github.com/a/b" },
        {
          name: "bad-pin",
          source: { source: "url", url: "https://github.com/example/tasks", sha: "main" },
        },
        {
          name: "conflicting",
          source: { source: "url", url: "https://github.com/example/tasks@other", sha },
        },
      ]),
      registry,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toBe(7);
  });
  it("keeps the subdirectory of a pinned URL source", () => {
    const result = parsePluginMarketplace(
      index([
        {
          name: "stripe",
          source: {
            source: "url",
            url: "https://github.com/stripe/ai.git",
            sha,
            path: "providers/grok",
          },
          category: "Payments",
          homepage: "https://stripe.com",
          domains: ["stripe.com"],
        },
      ]),
      { name: "xAI", repository: "https://github.com/example/index" },
    );
    expect(result.entries[0]).toMatchObject({
      source: `https://github.com/stripe/ai@${sha}#providers/grok`,
      category: "payments",
      homepage: "https://stripe.com",
      domains: ["stripe.com"],
    });
  });
  it("rejects malformed or oversized index structure", () => {
    expect(() => parsePluginMarketplace("invalid", registry)).toThrow();
    expect(() => parsePluginMarketplace(JSON.stringify({ plugins: {} }), registry)).toThrow();
    expect(() => parsePluginMarketplace(index(Array(1001).fill({})), registry)).toThrow();
  });
});

describe("marketplace service", () => {
  it("filters metadata, caches success, and does not cache provider failures", async () => {
    let failed = true;
    const read = vi.fn(async (url: string) => {
      if (url.includes("xai-org")) {
        if (failed) throw new Error("Unavailable");
        return index([{ name: "Tasks", source: "tasks", keywords: ["planning"] }]);
      }
      return index([{ name: "Notes", description: "Daily planning", source: "notes" }]);
    });
    const service = createPluginMarketplace(read);
    const first = await service.catalog("PLANNING daily");
    expect(first.entries.map((entry) => entry.name)).toEqual(["Notes"]);
    expect(first.unavailableRegistries).toEqual(["xAI"]);
    failed = false;
    const second = await service.catalog("planning");
    expect(second.entries.map((entry) => entry.name)).toEqual(["Notes", "Tasks"]);
    expect(second.unavailableRegistries).toEqual([]);
    expect(indexReads(read)).toBe(3);
    await service.catalog("no match");
    expect(indexReads(read)).toBe(3);
  });
  it("shares concurrent reads and expires the per-instance cache", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const read = vi.fn(async () => index([{ name: "Notes", source: "notes" }]));
    const service = createPluginMarketplace(read);
    await Promise.all([service.catalog(""), service.catalog("Notes")]);
    expect(indexReads(read)).toBe(2);
    now.mockReturnValue(62_000);
    await service.catalog("");
    expect(indexReads(read)).toBe(4);
  });
  it("reads the title, category and logo of vendored plugins from their manifests", async () => {
    const read = vi.fn(async (url: string) => {
      if (url.includes("xai-org")) return index([]);
      if (url.endsWith("/mail/.cursor-plugin/plugin.json"))
        return JSON.stringify({
          displayName: "Mail",
          category: "Productivity",
          logo: "assets/logo.svg",
        });
      if (url.endsWith("plugin.json")) return JSON.stringify({ logo: "../../escape.svg" });
      return index([
        { name: "mail", source: "mail" },
        { name: "notes", source: "notes" },
      ]);
    });
    const { entries } = await createPluginMarketplace(read).catalog("");
    expect(entries).toMatchObject([
      {
        name: "mail",
        displayName: "Mail",
        category: "productivity",
        logo: "https://raw.githubusercontent.com/cursor/plugins/HEAD/mail/assets/logo.svg",
      },
      { name: "notes", displayName: "Notes", category: null, logo: null },
    ]);
  });
  it("returns explicit unavailability without leaking provider errors", async () => {
    const service = createPluginMarketplace(async () => {
      throw new Error("private diagnostic");
    });
    expect(await service.catalog("")).toEqual({
      entries: [],
      unavailableRegistries: ["Cursor", "xAI"],
      skippedEntries: 0,
    });
  });
});
