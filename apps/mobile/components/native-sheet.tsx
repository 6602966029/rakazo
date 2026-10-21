import type { BottomSheetProps } from "@expo/ui/community/bottom-sheet";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { isComposeViewAvailable } from "../lib/compose-available";
import { useMobileTokens } from "../lib/native";

const sheetViews = ["HostView", "ModalBottomSheetView", "RNHostView", "SlotView"];

export function useNativeSheet() {
  const [Sheet, setSheet] = useState<ComponentType<BottomSheetProps> | null>(null);
  useEffect(() => {
    if (Platform.OS !== "android" || !sheetViews.every(isComposeViewAvailable)) return;
    let active = true;
    // Loading the module constructs native adapters, so it must follow the view checks.
    void import("@expo/ui/community/bottom-sheet").then(
      ({ BottomSheet }) => {
        if (active) setSheet(() => BottomSheet);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  return Sheet;
}

export function NativeSheet({
  Sheet,
  children,
  onClose,
  expanded = false,
  label,
}: {
  Sheet: ComponentType<BottomSheetProps>;
  children: ReactNode;
  onClose: () => void;
  expanded?: boolean;
  label?: string;
}) {
  const tokens = useMobileTokens();
  const { height } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const closed = useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (event) =>
      setKeyboardHeight(event.endCoordinates.height),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Reserve the native drag handle and cap hosted content above the IME.
  const maxHeight = Math.max(0, height * 0.9 - keyboardHeight - 48);
  return (
    <Sheet
      enableDynamicSizing
      enablePanDownToClose
      backgroundStyle={{ backgroundColor: tokens.background }}
      onClose={() => {
        if (closed.current) return;
        closed.current = true;
        onClose();
      }}
    >
      <View
        accessibilityViewIsModal
        accessibilityLabel={label}
        style={{ maxHeight, height: expanded ? maxHeight : undefined }}
      >
        <ScrollView style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {children}
        </ScrollView>
      </View>
    </Sheet>
  );
}
