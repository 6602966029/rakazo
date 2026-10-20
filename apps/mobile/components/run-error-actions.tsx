import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Intrinsic button widths wrap together; each wrapped button fills its row. */
export function RunErrorActions({
  onConnection,
  onModel,
}: {
  onConnection?: () => void;
  onModel?: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { fontScale } = useWindowDimensions();
  return (
    <View style={styles.actions}>
      {[
        { label: t("Set your own key"), onPress: onConnection, primary: true },
        { label: t("Change model"), onPress: onModel, primary: false },
      ].map(({ label, onPress, primary }) =>
        onPress ? (
          <Pressable
            key={label}
            accessibilityRole="button"
            onPress={onPress}
            style={({ pressed }) => [
              styles.button,
              { flexBasis: fontScale > 1.3 ? "100%" : "auto" },
              {
                backgroundColor: primary ? tokens.primary : tokens.card,
                borderColor: primary ? tokens.primary : tokens.foreground,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text
              style={{
                color: primary ? tokens.primaryForeground : tokens.foreground,
                fontSize: 15,
                fontWeight: "600",
                textAlign: "center",
              }}
            >
              {label}
            </Text>
          </Pressable>
        ) : null,
      )}
    </View>
  );
}

export function RunErrorTextAction({ label, onPress }: { label: string; onPress: () => void }) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={{ alignSelf: "flex-start", paddingVertical: 8 }}
    >
      <Text style={{ color: tokens.primary, fontSize: 16, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "stretch" },
  button: {
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 9,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
});
