import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { runErrorExplanation } from "../lib/run-error-presentation";
import { NativeSymbol } from "./native-symbol";
import { RunErrorActions } from "./run-error-actions";

/** A list item: its full height participates in scrolling above the composer. */
export function ThreadErrorNotice({
  error,
  summary,
  resetAt,
  onDetails,
  onConnection,
  onModel,
}: {
  error: string | null;
  summary: string | null;
  resetAt?: number;
  onDetails?: () => void;
  onConnection?: () => void;
  onModel?: () => void;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const { fontScale } = useWindowDimensions();
  if (!error && !summary) return null;
  const explanation = runErrorExplanation(t, !!onConnection, !!onModel);
  const upcomingReset =
    resetAt && resetAt > Date.now()
      ? t("Resets {date}.", {
          date: new Intl.DateTimeFormat(locale, {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          }).format(resetAt),
        })
      : null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
    >
      <View style={styles.header}>
        <View style={{ paddingTop: Math.max(0, (20 * fontScale - 18) / 2) }}>
          <NativeSymbol
            ios="exclamationmark.triangle.fill"
            android="warning"
            size={18}
            color={tokens.warning}
          />
        </View>
        <Text style={[styles.headline, { color: tokens.foreground }]}>{summary ?? error}</Text>
      </View>
      <View style={styles.body}>
        {summary && error ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{error}</Text>
        ) : null}
        {explanation || upcomingReset ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
            {[explanation, upcomingReset].filter(Boolean).join("\n")}
          </Text>
        ) : null}
        {onConnection || onModel ? (
          <RunErrorActions onConnection={onConnection} onModel={onModel} />
        ) : null}
        {summary && onDetails ? (
          <Pressable
            accessibilityRole="link"
            onPress={onDetails}
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            style={styles.details}
          >
            <Text style={{ color: tokens.link, fontSize: 14, fontWeight: "600" }}>
              {t("Details")}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 16, marginTop: 12, gap: 6 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  headline: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  body: { marginLeft: 26, gap: 12 },
  details: { alignSelf: "flex-start" },
});
