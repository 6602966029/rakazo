import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { ConnectionPhase } from "../lib/connection-phase";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** At the top of the inbox, in place of its error line, while the server can't be reached. */
export function ConnectionBar({
  phase,
  saved,
  onRetry,
}: {
  phase: ConnectionPhase;
  /** The inbox shows saved chats; false before anything has loaded on this device. */
  saved: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  if (phase === "connected") return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginHorizontal: 16,
        marginBottom: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderRadius: 16,
        backgroundColor: tokens.muted,
      }}
    >
      {phase === "reconnecting" ? (
        <>
          <ActivityIndicator size="small" color={tokens.mutedForeground} />
          <Text style={{ flex: 1, color: tokens.foreground, fontSize: 15 }}>
            {t("Reconnecting to the server…")}
          </Text>
        </>
      ) : (
        <>
          <View accessible style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
              {t("Can't reach the server")}
            </Text>
            {saved ? (
              <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
                {t("Your bots are safe — showing saved chats.")}
              </Text>
            ) : null}
          </View>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={onRetry}>
            <Text style={{ color: tokens.primary, fontSize: 15, fontWeight: "600" }}>
              {t("Retry")}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
