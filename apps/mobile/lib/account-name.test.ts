import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const screen = readFileSync(new URL("../app/(settings)/account.tsx", import.meta.url), "utf8");
const start = screen.indexOf("  async function saveName()");
const end = screen.indexOf("\n  const [deleteOpen", start);
if (start < 0 || end < 0) throw new Error("Missing account name handler");
const handler = ts.transpileModule(screen.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function nameEditor() {
  const dependencies = {
    nameDraft: "  Sam Rivera  ",
    namePending: false,
    setNamePending: vi.fn(),
    setNameError: vi.fn(),
    setEditingName: vi.fn(),
    updateAccountName: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    rpc: vi.fn<() => Promise<unknown>>(),
    setMe: vi.fn(),
    errorText: (_error: unknown, fallback: string) => fallback,
    t: (value: string) => value,
  };
  // Execute the screen handler without loading native modules.
  const run = new Function(...Object.keys(dependencies), `${handler}; return saveName();`);
  return { ...dependencies, submit: () => run(...Object.values(dependencies)) as Promise<void> };
}

it("closes the editor after saving while refresh is pending and ignores refresh failure", async () => {
  const editor = nameEditor();
  let rejectRefresh!: (error: Error) => void;
  editor.rpc.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }),
  );
  await editor.submit();
  expect(editor.updateAccountName).toHaveBeenCalledWith("Sam Rivera");
  expect(editor.setEditingName).toHaveBeenCalledExactlyOnceWith(false);
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
  expect(editor.rpc).toHaveBeenCalledWith("me");
  rejectRefresh(new Error("offline"));
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.setNameError).toHaveBeenCalledExactlyOnceWith(null);
  expect(editor.setEditingName).toHaveBeenCalledTimes(1);
  expect(editor.setMe).not.toHaveBeenCalled();
});

it("updates the account data when refresh succeeds", async () => {
  const editor = nameEditor();
  const me = { name: "Sam Rivera" };
  editor.rpc.mockResolvedValue(me);
  await editor.submit();
  expect(editor.setMe).toHaveBeenCalledWith(me);
  expect(editor.setEditingName).toHaveBeenCalledWith(false);
  expect(editor.setNameError).toHaveBeenCalledExactlyOnceWith(null);
});

it("keeps the editor open and shows an error when saving fails", async () => {
  const editor = nameEditor();
  editor.updateAccountName.mockRejectedValue(new Error("offline"));
  await editor.submit();
  expect(editor.setEditingName).not.toHaveBeenCalled();
  expect(editor.rpc).not.toHaveBeenCalled();
  expect(editor.setNameError).toHaveBeenLastCalledWith("Could not update name");
  expect(editor.setNamePending).toHaveBeenLastCalledWith(false);
});
