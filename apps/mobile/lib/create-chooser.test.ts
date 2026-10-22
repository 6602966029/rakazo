import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMenuActions, isCreateAction } from "./create-chooser";
import { materialIcons } from "./material-icons";

vi.mock("./material-icons", () => ({
  materialIcons: { person_add: 101, group: 102, grid_view: 103 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const t = (text: string) => text;

describe("create menu", () => {
  it("keeps the iOS actions, icons and order", () => {
    expect(createMenuActions(t, "ios")).toEqual([
      { id: "bot", title: "New bot", image: "person.crop.circle.badge.plus" },
      { id: "group", title: "New group", image: "person.2" },
      { id: "space", title: "New space", image: "square.grid.2x2" },
    ]);
  });

  it("uses Material icon assets for Android in the same order", () => {
    expect(createMenuActions(t, "android")).toEqual([
      { id: "bot", title: "New bot", image: materialIcons.person_add },
      { id: "group", title: "New group", image: materialIcons.group },
      { id: "space", title: "New space", image: materialIcons.grid_view },
    ]);
  });

  it("translates the titles", () => {
    expect(
      createMenuActions((label) => `translated: ${label}`, "android").map(({ title }) => title),
    ).toEqual(["translated: New bot", "translated: New group", "translated: New space"]);
  });

  it.each(["bot", "group", "space"])("accepts %s", (id) => {
    expect(isCreateAction(id)).toBe(true);
  });

  it.each(["", "other", "Bot", "person_add", "constructor"])("rejects %s", (id) => {
    expect(isCreateAction(id)).toBe(false);
  });

  it.each(["ios", "android"])("omits full stops from %s titles", (platform) => {
    expect(createMenuActions(t, platform).every(({ title }) => !title?.endsWith("."))).toBe(true);
  });

  it("uses one shared native Create menu on the home screen", () => {
    const source = readFileSync(new URL("../app/index.tsx", import.meta.url), "utf8");
    const createMenu = source.slice(
      source.indexOf("<View style={styles.headerActions}>"),
      source.indexOf("<SelectedChatContext.Provider"),
    );
    expect(source).toContain("createMenuActions(t, Platform.OS)");
    expect(createMenu.match(/<MenuView\b/g)).toHaveLength(1);
    expect(createMenu).toContain("actions={createActions}");
    expect(createMenu).toContain("isCreateAction(action)");
    expect(createMenu).toContain("runCreateAction(action)");
    expect(createMenu).toContain('accessibilityLabel={t("Create")}');
    expect(createMenu).toContain('accessibilityRole="button"');
    expect(createMenu).toContain('<NativeSymbol ios="plus" android="add" size={18} />');
    expect(createMenu).not.toContain('Platform.OS === "android"');
    expect(source).not.toContain("openCreateChooser");
    expect(source).not.toContain("presentCreateChooser");
    expect(source).not.toMatch(/Alert\.alert\(\s*t\("Create"\)/);
  });
});
