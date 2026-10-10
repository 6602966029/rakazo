import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { FullWindowOverlay } from "react-native-screens";

/** A window above sheets and modals; VoiceOver can still reach the screen under it. */
export function ToastOverlay({ children }: { children: ReactNode }) {
  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {children}
      </GestureHandlerRootView>
    </FullWindowOverlay>
  );
}
