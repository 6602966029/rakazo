import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ColorTokens } from "./index.js";
import {
  botColors,
  cssVariableName,
  darkTokens,
  lightTokens,
  normalizeAppearancePreference,
  persistAppearancePreference,
  renderTokensCss,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
} from "./index.js";

describe("appearance preference", () => {
  it("defaults unknown values to system", () => {
    expect(normalizeAppearancePreference(null)).toBe("system");
    expect(normalizeAppearancePreference("nope")).toBe("system");
    expect(normalizeAppearancePreference("light")).toBe("light");
  });

  it("resolves system from the platform scheme", () => {
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("reads and writes storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(resolveAppearancePreference({ storage })).toBe("system");
    persistAppearancePreference("light", storage);
    expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(resolveAppearancePreference({ storage })).toBe("light");
  });

  it("returns distinct light and dark token sets", () => {
    expect(tokensForAppearance("dark")).toBe(darkTokens);
    expect(tokensForAppearance("light")).toBe(lightTokens);
    for (const key of Object.keys(darkTokens) as (keyof ColorTokens)[]) {
      if (
        key === "destructiveForeground" ||
        key === "destructiveFill" ||
        key === "faviconPlate" ||
        key === "unread"
      )
        continue;
      expect(darkTokens[key], key).not.toBe(lightTokens[key]);
    }
  });

  it("keeps working-state blue in its own semantic token across themes", () => {
    expect(darkTokens.statusWorking).toBeTruthy();
    expect(lightTokens.statusWorking).toBeTruthy();
    expect(darkTokens.statusWorking).toBe(darkTokens.link);
    expect(lightTokens.statusWorking).toBe(lightTokens.link);
    expect(darkTokens.statusWorking).not.toBe(darkTokens.primary);
    expect(lightTokens.statusWorking).not.toBe(lightTokens.primary);
  });

  it("keeps user message surfaces muted, not cream invert", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.secondary).not.toBe(dark.primary);
    expect(light.secondary).not.toBe(light.primary);
    expect(dark.secondaryForeground).not.toBe(dark.primaryForeground);
  });

  it("separates user bubbles from bot bubbles and the sidebar from the app", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.chatUser).not.toBe(dark.muted);
    expect(light.chatUser).not.toBe(light.muted);
    expect(dark.sidebar).not.toBe(dark.background);
    expect(light.sidebar).not.toBe(light.background);
  });

  it("tolerates a throwing localStorage getter", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(resolveAppearancePreference()).toBe("system");
      persistAppearancePreference("light");
      expect(resolveAppearancePreference()).toBe("system");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

// Composite translucent foregrounds before measuring WCAG 2.x contrast.
function contrastRatio(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const alpha = a.length === 9 ? Number.parseInt(a.slice(7, 9), 16) / 255 : 1;
  const backdrop = rgb(b);
  const foreground = rgb(a).map((c, i) => c * alpha + backdrop[i]! * (1 - alpha));
  const luminance = (channels: number[]) =>
    channels.reduce((sum, value, i) => {
      const c = value / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][i]! * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  const la = luminance(foreground);
  const lb = luminance(backdrop);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("dark palette contrast", () => {
  // The destructive fill follows the system palette; ordinary body text meets AA.
  it.each(["background", "card", "muted"] as const)(
    "keeps faint text readable on %s",
    (surface) => {
      expect(contrastRatio(darkTokens.faintForeground, darkTokens[surface])).toBeGreaterThanOrEqual(
        3,
      );
    },
  );

  it.each(botColors)("keeps bot identity %s readable on dark messages", (color) => {
    for (const surface of [darkTokens.background, darkTokens.muted]) {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  const pairs: [keyof ColorTokens, keyof ColorTokens][] = [
    ["foreground", "background"],
    ["foreground", "dialog"],
    ["cardForeground", "card"],
    ["popoverForeground", "popover"],
    ["foreground", "muted"],
    ["chatUserForeground", "chatUser"],
    ["primaryForeground", "primary"],
    ["sidebarForeground", "sidebar"],
    ["sidebarAccentForeground", "sidebarAccent"],
    ["link", "background"],
    ["link", "card"],
    ["destructive", "background"],
    ["destructive", "card"],
    ["success", "background"],
    ["success", "card"],
  ];

  it.each(pairs)("%s on %s meets WCAG AA (4.5:1)", (text, surface) => {
    expect(contrastRatio(darkTokens[text], darkTokens[surface])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tokens.css", () => {
  it("derives kebab-case variable names", () => {
    expect(cssVariableName("background")).toBe("--background");
    expect(cssVariableName("mutedForeground")).toBe("--muted-foreground");
    expect(cssVariableName("sidebarAccentForeground")).toBe("--sidebar-accent-foreground");
  });

  it("is generated from the TS palette", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderTokensCss());
  });

  it("scopes light and dark under data-theme", () => {
    const css = renderTokensCss();
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css).toContain('[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain(`--background: ${lightTokens.background.toLowerCase()};`);
    expect(css).toContain(`--background: ${darkTokens.background.toLowerCase()};`);
  });
});
