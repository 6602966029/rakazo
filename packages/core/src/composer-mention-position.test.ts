import { describe, expect, it } from "vitest";
import {
  completeComposerMention,
  composerMentionQuery,
  removeComposerMention,
} from "./composer-mentions.js";

describe("inline mention completion", () => {
  it.each([
    ["@bo", 3, "@Bot ", 5],
    ["ask @bo", 7, "ask @Bot ", 9],
    ["ask @bo and do this", 7, "ask @Bot and do this", 9],
    ["ask @bo, please", 6, "ask @Bot, please", 8],
    [" \task\n @bo  later\n", 10, " \task\n @Bot  later\n", 12],
    ["@Bot ask @bo later", 12, "@Bot ask @Bot later", 14],
  ] as const)("replaces the active query in %j", (text, caret, expected, nextCaret) => {
    const query = composerMentionQuery(text, caret);
    expect(query).not.toBeNull();
    expect(completeComposerMention(text, query!, { name: "Bot" })).toEqual({
      text: expected,
      caret: nextCaret,
    });
  });

  it.each(["email@bo", "@bo done", "ordinary text"])(
    "ignores nonqueries at the end of %j",
    (text) => {
      expect(composerMentionQuery(text)).toBeNull();
    },
  );

  it("does not complete a selected range", () => {
    expect(composerMentionQuery("ask @bo later", 5, 7)).toBeNull();
  });

  it("removes repeated tokens without touching suffixes or whitespace", () => {
    expect(removeComposerMention("ask @Bot  and @Bot\n@Botany", { name: "Bot" })).toBe(
      "ask   and \n@Botany",
    );
  });
});
