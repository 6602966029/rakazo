import { BottomSheet } from "@expo/ui/community/bottom-sheet";
import type { ReactNode } from "react";
import { useMobileTokens } from "../lib/native";

export function RunErrorSheetContainer({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const tokens = useMobileTokens();
  return (
    <BottomSheet
      snapPoints={["50%", "90%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      onClose={onClose}
      backgroundStyle={{ backgroundColor: tokens.background }}
    >
      {children}
    </BottomSheet>
  );
}
