import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const screen = readFileSync(new URL("../app/(settings)/account.tsx", import.meta.url), "utf8");
const start = screen.indexOf("  async function saveName(");
const end = screen.indexOf("\n  function closeNameDialog", start);
if (start < 0 || end < 0) throw new Error("Missing account name handlers");
const handlers = ts.transpileModule(screen.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function nameEditor(os: "ios" | "android" = "android", currentName = "Old Name") {
  const dependencies = {
    currentName,
    namePending: false,
    Platform: { OS: os },
    Alert: { alert: vi.fn(), prompt: vi.fn() },
    setNameDraft: vi.fn(),
    setNamePending: vi.fn(),
    setNameError: vi.fn(),
    setNameDialogOpen: vi.fn(),
    updateAccountName: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    rpc: vi.fn<() => Promise<unknown>>(),
    setMe: vi.fn(),
    errorText: (_error: unknown, fallback: string) => fallback,
    t: (value: string) => value,
  };
  // Execute the screen handlers without loading native modules.
  const run = new Function(
    ...Object.keys(dependencies),
    `${handlers}; return { saveName, editName };`,
  )(...Object.values(dependencies)) as {
    saveName: (value: string) => Promise<void>;
    editName: () => void;
  };
  return { ...dependencies, ...run };
}

it("saves the trimmed name, closes the dialog, and ignores a failed refresh", async () => {
  const editor = nameEditor();
  let rejectRefresh!: (error: Error) => void;
  editor.rpc.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }),
  );
  await editor.saveName("  Sam Rivera  ");
  expect(editor.updateAccountName).toHaveBeenCalledWith("Sam Rivera");
  expect(editor.setNameDialogOpen).toHaveBeenCalledExactlyOnceWith(false);
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
  expect(editor.rpc).toHaveBeenCalledWith("me");
  rejectRefresh(new Error("offline"));
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.setNameError).toHaveBeenCalledExactlyOnceWith(null);
  // The saved name shows right away; the failed refresh leaves it in place.
  expect(editor.setMe).toHaveBeenCalledOnce();
  const update = editor.setMe.mock.calls[0]![0] as (me: { name: string } | null) => unknown;
  expect(update({ name: "Old" })).toEqual({ name: "Sam Rivera" });
  expect(update(null)).toBeNull();
});

it("updates the account data when refresh succeeds", async () => {
  const editor = nameEditor();
  const me = { name: "Sam Rivera" };
  editor.rpc.mockResolvedValue(me);
  await editor.saveName("Sam Rivera");
  expect(editor.setMe).toHaveBeenCalledWith(me);
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(false);
});

it("closes without saving when the name is unchanged or blank", async () => {
  const editor = nameEditor();
  await editor.saveName(" Old Name ");
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(false);
  await editor.saveName("   ");
  expect(editor.updateAccountName).not.toHaveBeenCalled();
});

it("keeps the Android dialog open with an inline error when saving fails", async () => {
  const editor = nameEditor("android");
  editor.updateAccountName.mockRejectedValue(new Error("offline"));
  await editor.saveName("Sam Rivera");
  expect(editor.setNameDialogOpen).not.toHaveBeenCalled();
  expect(editor.rpc).not.toHaveBeenCalled();
  expect(editor.setNameError).toHaveBeenLastCalledWith("Could not update name");
  expect(editor.Alert.alert).not.toHaveBeenCalled();
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
});

it("shows a system alert on iOS when saving fails", async () => {
  const editor = nameEditor("ios");
  editor.updateAccountName.mockRejectedValue(new Error("offline"));
  await editor.saveName("Sam Rivera");
  expect(editor.Alert.alert).toHaveBeenCalledWith("Could not update name", "Could not update name");
  expect(editor.setNameError).toHaveBeenCalledExactlyOnceWith(null);
});

it("opens the system prompt prefilled on iOS and saves its value", async () => {
  const editor = nameEditor("ios");
  editor.editName();
  expect(editor.setNameDialogOpen).not.toHaveBeenCalled();
  const [title, message, buttons, type, value] = editor.Alert.prompt.mock.calls[0]!;
  expect([title, message, type, value]).toEqual(["Edit name", undefined, "plain-text", "Old Name"]);
  expect(buttons.map((b: { text: string }) => b.text)).toEqual(["Cancel", "Save"]);
  await buttons[1].onPress(" Sam Rivera ");
  expect(editor.updateAccountName).toHaveBeenCalledWith("Sam Rivera");
});

it("opens the drawn dialog prefilled on Android", () => {
  const editor = nameEditor("android");
  editor.editName();
  expect(editor.Alert.prompt).not.toHaveBeenCalled();
  expect(editor.setNameDraft).toHaveBeenCalledWith("Old Name");
  expect(editor.setNameError).toHaveBeenCalledWith(null);
  expect(editor.setNameDialogOpen).toHaveBeenCalledWith(true);
});
