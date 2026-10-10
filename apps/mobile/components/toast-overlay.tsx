import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

/** Android draws the host last in the root view, above the navigation stack. */
export function ToastOverlay({ children }: { children: ReactNode }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {children}
    </View>
  );
}
