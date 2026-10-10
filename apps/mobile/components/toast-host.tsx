import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Directions, Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { Toast, ToastVariant } from "../lib/toast";
import {
  TOAST_EXIT_MS,
  toastAccessibilityLabel,
  toast as toasts,
  useToastState,
} from "../lib/toast";
import { NativeSymbol } from "./native-symbol";
import { ToastOverlay } from "./toast-overlay";

const ICONS: Record<
  ToastVariant,
  { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] }
> = {
  error: { ios: "exclamationmark.circle.fill", android: "alert-circle" },
  info: { ios: "info.circle.fill", android: "information-circle" },
  success: { ios: "checkmark.circle.fill", android: "checkmark-circle" },
};
/**
 * Surface, text and icon colour per variant. Error is red in both themes, from the light palette so
 * white text passes 4.5:1; white on green does not, so success is ink with a green check.
 */
function variantColors(variant: ToastVariant, tokens: ReturnType<typeof useMobileTokens>) {
  const light = mobileTokens("light");
  const ink = { surface: tokens.primary, text: tokens.primaryForeground };
  return {
    error: {
      surface: light.destructive,
      text: light.destructiveForeground,
      icon: light.destructiveForeground,
    },
    success: { ...ink, icon: light.success },
    info: { ...ink, icon: tokens.primaryForeground },
  }[variant];
}
const TRAVEL = 26;
const TOAST_MATERIALIZE_MS = 320;
const CONTENT_DELAY_MS = 150;
// Toast text follows Dynamic Type up to the largest standard size, so a card can't cover the screen.
const MAX_FONT_SCALE = 1.35;

/** Shows the current toast; mounted once at the app root. */
export function ToastHost() {
  const state = useToastState();
  if (!state) return null;
  return (
    <ToastOverlay>
      <ToastCard key={state.toast.id} toast={state.toast} leaving={state.leaving} />
    </ToastOverlay>
  );
}

function ToastCard({ toast, leaving }: { toast: Toast; leaving: boolean }) {
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const contentOpacity = useSharedValue(0);
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  // Glass starts clear and materializes after mount, the way UIKit animates it in and out.
  const [materialized, setMaterialized] = useState(false);
  const label = toastAccessibilityLabel(toast);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibilityWithOptions(label, { queue: true });
  }, [label]);

  useEffect(() => setMaterialized(!leaving), [leaving]);

  // On glass the text waits for the glass to materialize, so it never shows on bare screen.
  useEffect(() => {
    if (!glass) return;
    const fade = (to: number) =>
      withTiming(to, { duration: TOAST_EXIT_MS, reduceMotion: ReduceMotion.Never });
    contentOpacity.value = leaving
      ? fade(0)
      : withDelay(CONTENT_DELAY_MS, fade(1), ReduceMotion.Never);
  }, [contentOpacity, glass, leaving]);

  useEffect(() => {
    progress.value = leaving
      ? withTiming(0, {
          duration: TOAST_EXIT_MS,
          easing: Easing.in(Easing.cubic),
          // Reduce Motion drops the slide, not the fade; Reanimated would otherwise jump.
          reduceMotion: ReduceMotion.Never,
        })
      : reduceMotion
        ? withTiming(1, { duration: TOAST_EXIT_MS, reduceMotion: ReduceMotion.Never })
        : withSpring(1, { damping: 20, stiffness: 220, mass: 0.9 });
  }, [leaving, progress, reduceMotion]);

  // UIKit skips glass whose view or an ancestor is nearly transparent when it lays out, so with
  // glass only the content fades and the glass itself materializes.
  const motion = useAnimatedStyle(() => ({
    opacity: glass ? 1 : Math.min(progress.value, 1),
    transform: reduceMotion ? [] : [{ translateY: (1 - progress.value) * -TRAVEL }],
  }));
  const contentFade = useAnimatedStyle(() => ({ opacity: glass ? contentOpacity.value : 1 }));

  const swipeUp = Gesture.Fling()
    .direction(Directions.UP)
    .runOnJS(true)
    .onEnd(() => toasts.dismiss());

  const colors = variantColors(toast.variant, tokens);
  const runAction = () => {
    toast.action?.run();
    toasts.dismiss();
  };
  const action = toast.action;
  const content = (
    // UIKit glass, not GlassSurface: FullWindowOverlay's view has no view controller, so a
    // SwiftUI Host draws nothing there. Without Liquid Glass the card is a solid fill.
    <GlassView
      glassEffectStyle={{
        style: materialized ? "regular" : "none",
        animate: true,
        animationDuration: (leaving ? TOAST_EXIT_MS : TOAST_MATERIALIZE_MS) / 1000,
      }}
      tintColor={colors.surface}
      colorScheme={appearance}
      style={[
        styles.card,
        !glass && [
          styles.solid,
          { backgroundColor: colors.surface, shadowColor: tokens.foreground },
        ],
      ]}
    >
      <Animated.View style={[styles.row, contentFade]}>
        <View style={styles.icon}>
          <NativeSymbol {...ICONS[toast.variant]} size={18} color={colors.icon} />
        </View>
        <View style={styles.text}>
          <Text
            numberOfLines={2}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={[styles.title, { color: colors.text }]}
          >
            {toast.message}
          </Text>
          {toast.detail ? (
            <Text
              numberOfLines={3}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[styles.detail, { color: colors.text }]}
            >
              {toast.detail}
            </Text>
          ) : null}
          {action ? (
            <Pressable accessible={false} hitSlop={8} onPress={runAction} style={styles.action}>
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={MAX_FONT_SCALE}
                style={[styles.actionLabel, { color: colors.text }]}
              >
                {action.label}
              </Text>
              <NativeSymbol
                ios="chevron.right"
                android="chevron-forward"
                size={11}
                color={colors.text}
              />
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </GlassView>
  );

  return (
    <View
      pointerEvents="box-none"
      style={[styles.frame, { top: insets.top + 8, maxWidth: Math.min(420, width - 32) }]}
    >
      <GestureDetector gesture={swipeUp}>
        <Animated.View style={motion}>
          {/* The card overlaps the header, so a stray tap only dismisses; the action row (or
              VoiceOver's activate on the one card element) runs the action. */}
          <Pressable
            accessibilityRole={action ? "button" : undefined}
            accessibilityLabel={label}
            accessibilityActions={action ? [{ name: "activate", label: action.label }] : undefined}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "activate") runAction();
            }}
            onPress={() => toasts.dismiss()}
          >
            {content}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { position: "absolute", alignSelf: "center" },
  card: { borderRadius: 16, borderCurve: "continuous" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    paddingTop: 10,
  },
  // Glass brings its own depth; a shadow on the clear glass view would outline the text instead.
  solid: {
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  icon: { height: 19, justifyContent: "center" },
  text: { flexShrink: 1, gap: 2 },
  title: { fontSize: 15, lineHeight: 19, fontWeight: "600" },
  detail: { fontSize: 13, lineHeight: 17 },
  action: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  actionLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
});
