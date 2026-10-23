import { describe, expect, it } from "vitest";
import { botBubblePalette, resolvePersonaColorDef } from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("keeps Amber Gold on dark eyes instead of a brightness heuristic", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#141414");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#FFFFFF");
  });
});

describe("bot bubble palette", () => {
  it("fills the bubble with the bot's full color", () => {
    expect(botBubblePalette("#00C972").background).toBe("#00C972");
    expect(botBubblePalette("#fff").background).toBe("#ffffff");
  });

  it("picks the text color with the higher contrast", () => {
    expect(botBubblePalette("#00C972").foreground).toBe("#141414");
    expect(botBubblePalette("#FFAF38").foreground).toBe("#141414");
    expect(botBubblePalette("#FFFFFF").foreground).toBe("#141414");
    expect(botBubblePalette("#1D4ED8").foreground).toBe("#FFFFFF");
    expect(botBubblePalette("#78350F").foreground).toBe("#FFFFFF");
  });

  it("draws nested fills in the text's ink", () => {
    expect(botBubblePalette("#00C972").muted).toBe("rgba(0, 0, 0, 0.08)");
    expect(botBubblePalette("#1D4ED8").muted).toBe("rgba(255, 255, 255, 0.16)");
  });
});
