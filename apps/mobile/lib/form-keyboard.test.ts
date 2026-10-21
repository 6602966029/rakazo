import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const screen = (name: string) => readFileSync(new URL(`../app/${name}`, import.meta.url), "utf8");
const scrollViewProps = (source: string) => {
  const start = source.indexOf("<ScrollView");
  return source.slice(start, source.indexOf(">", start));
};

describe("form keyboard handling", () => {
  // The keyboard covered the primary button at the end of these forms, and the form could not
  // scroll it clear, so it could only be reached after dismissing the keyboard.
  it("New group keeps Skip/Create reachable above the keyboard and submits on Return", () => {
    const source = screen("new-group.tsx");
    const props = scrollViewProps(source);
    expect(props).toContain("automaticallyAdjustKeyboardInsets");
    expect(props).toContain('keyboardShouldPersistTaps="handled"');
    // Next lives in the floating header, so the keyboard never covers it.
    expect(source).toContain("headerRight:");
    expect(source).toContain('returnKeyType="done"');
    expect(source).toContain("onSubmitEditing={() => void create()}");
  });

  it.each(["group-settings.tsx", "bot-settings.tsx", "new.tsx"])(
    "%s lets its form scroll clear of the keyboard",
    (name) => {
      const props = scrollViewProps(screen(name));
      expect(props).toContain("automaticallyAdjustKeyboardInsets");
      expect(props).toContain('keyboardShouldPersistTaps="handled"');
    },
  );
});
