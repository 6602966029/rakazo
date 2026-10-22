import { ActionSheetIOS, Alert, Platform } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isComposeViewAvailable } from "./compose-available";
import { presentCreateChooser } from "./create-chooser";
import {
  getMessageActionSheet,
  mountMessageActionSheetHost,
  selectMessageActionSheet,
} from "./message-action-sheet-store";

vi.mock("./compose-available", () => ({ isComposeViewAvailable: vi.fn(() => false) }));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  ActionSheetIOS: { showActionSheetWithOptions: vi.fn() },
  Alert: { alert: vi.fn() },
}));

const t = (text: string) => text;
const kinds = ["bot", "group", "space"] as const;
const labels = ["New bot", "New group", "New space"];

describe("Android create chooser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Platform.OS = "android";
    vi.mocked(isComposeViewAvailable).mockReturnValue(false);
  });

  it.each(["light", "dark"] as const)(
    "presents the Compose sheet in %s mode",
    async (colorScheme) => {
      vi.mocked(isComposeViewAvailable).mockReturnValue(true);
      const unmount = mountMessageActionSheetHost();
      const onSelect = vi.fn();
      try {
        for (const [index, kind] of kinds.entries()) {
          presentCreateChooser({ t, colorScheme, onSelect });
          const current = getMessageActionSheet()!;
          expect(current.title).toBe("Create");
          expect(current.colorScheme).toBe(colorScheme);
          expect(current.actions.map((action) => action.text)).toEqual(labels);
          expect(current.actions.every((action) => !action.text.endsWith("."))).toBe(true);
          await selectMessageActionSheet(current, index, async () => {});
          expect(onSelect).toHaveBeenNthCalledWith(index + 1, kind);
        }
        expect(onSelect).toHaveBeenCalledTimes(3);
        expect(Alert.alert).not.toHaveBeenCalled();
        expect(ActionSheetIOS.showActionSheetWithOptions).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    },
  );

  it.each(["Compose unavailable", "host unmounted"])(
    "preserves today's Alert when %s",
    (reason) => {
      vi.mocked(isComposeViewAvailable).mockReturnValue(reason === "host unmounted");
      const unmount = reason === "Compose unavailable" ? mountMessageActionSheetHost() : undefined;
      const onSelect = vi.fn();
      try {
        presentCreateChooser({ t, colorScheme: "dark", onSelect });
        expect(getMessageActionSheet()).toBeNull();
        expect(Alert.alert).toHaveBeenCalledExactlyOnceWith(
          "Create",
          undefined,
          labels.map((text) => ({ text, onPress: expect.any(Function) })),
          { cancelable: true },
        );
        const buttons = vi.mocked(Alert.alert).mock.calls[0]![2]!;
        expect(buttons.every((button) => !button.text?.endsWith("."))).toBe(true);
        buttons.forEach((button, index) => {
          button.onPress?.();
          expect(onSelect).toHaveBeenNthCalledWith(index + 1, kinds[index]);
        });
        expect(onSelect).toHaveBeenCalledTimes(3);
        expect(ActionSheetIOS.showActionSheetWithOptions).not.toHaveBeenCalled();
      } finally {
        unmount?.();
      }
    },
  );
});
