import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** Above the messages held until the live connection is back. */
export function HeldSendsDivider() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const rule = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: tokens.border };
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={t("Messages waiting to send until the server reconnects")}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 }}
    >
      <View style={rule} />
      <Text
        style={{
          color: tokens.mutedForeground,
          fontSize: 13,
          fontWeight: "600",
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        {t("Send after reconnect")}
      </Text>
      <View style={rule} />
    </View>
  );
}
