import { SEND_PROGRESS_DELAY_MS } from "@rakazo/core";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

const WIDTH = 20;
const SEGMENT = 8;

/** A small bar at the bubble's corner once a send has taken longer than a moment. No text. */
export function SendProgress({ since }: { since: number }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const reduceMotion = useReducedMotion();
  // Worked out from `since` on every render, so a newer, quicker send starts hidden again.
  const shown = Date.now() - since >= SEND_PROGRESS_DELAY_MS;
  const [, setElapsed] = useState(0);
  const offset = useSharedValue(-SEGMENT);

  useEffect(() => {
    if (shown) return;
    const timer = setTimeout(
      () => setElapsed((count) => count + 1),
      since + SEND_PROGRESS_DELAY_MS - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [since, shown]);

  useEffect(() => {
    if (!shown || reduceMotion) return;
    offset.value = withRepeat(withTiming(WIDTH, { duration: 1000, easing: Easing.linear }), -1);
  }, [shown, reduceMotion, offset]);

  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  if (!shown) return null;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("Sending")}
      style={{
        position: "absolute",
        right: 8,
        bottom: -8,
        width: WIDTH,
        height: 4,
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: tokens.border,
      }}
    >
      <Animated.View
        style={[
          { width: SEGMENT, height: 4, borderRadius: 2, backgroundColor: tokens.mutedForeground },
          reduceMotion ? { transform: [{ translateX: (WIDTH - SEGMENT) / 2 }] } : sweep,
        ]}
      />
    </View>
  );
}
