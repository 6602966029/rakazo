import { describe, expect, it } from "vitest";
import { chatUserBubbleColors, resolvePersonaColorDef } from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("keeps Amber Gold on dark eyes instead of a brightness heuristic", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#141414");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#FFFFFF");
  });
});

describe("chatUserBubbleColors", () => {
  it("wears the bot's color with readable text", () => {
    expect(chatUserBubbleColors("#8B5CF6::shape_2", "bot-1")).toEqual({
      background: "#8B5CF6",
      foreground: "#FFFFFF",
    });
    expect(chatUserBubbleColors("#EAB308", "bot-1")).toEqual({
      background: "#EAB308",
      foreground: "#141414",
    });
  });

  it("keeps the neutral bubble for a photo or the white bot", () => {
    expect(chatUserBubbleColors("data:image/png;base64,AAAA", "bot-1")).toBeUndefined();
    expect(chatUserBubbleColors("#FFFFFF", "bot-1")).toBeUndefined();
  });
});
