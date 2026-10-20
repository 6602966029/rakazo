import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { GlassSurface } from "./glass-surface";
import { NativeActionButton } from "./native-action-button";

/** Floats below the header without reserving space in the message list. */
export function ThreadErrorNotice({
  top,
  inset,
  error,
  summary,
  onDetails,
  onConnection,
  onModel,
}: {
  top: number;
  inset: number;
  error: string | null;
  summary: string | null;
  onDetails: () => void;
  onConnection?: () => void;
  onModel?: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  if (!error && !summary) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      pointerEvents="box-none"
      style={{ position: "absolute", top, left: inset, right: inset, zIndex: 1 }}
    >
      <GlassSurface
        style={{
          alignSelf: "flex-start",
          maxWidth: "100%",
          paddingHorizontal: 16,
          paddingVertical: 8,
        }}
        fallbackStyle={{
          borderRadius: 24,
          backgroundColor: tokens.card,
          borderColor: tokens.border,
          borderWidth: 1,
        }}
      >
        {error ? <Text style={{ color: tokens.foreground }}>{error}</Text> : null}
        {summary ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: tokens.foreground, fontSize: 13.5, flexShrink: 1 }}>
              {summary}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              {onConnection ? (
                <NativeActionButton
                  label={t("Connection settings")}
                  fill={false}
                  prominence="plain"
                  size="compact"
                  onPress={onConnection}
                />
              ) : null}
              {onModel ? (
                <NativeActionButton
                  label={t("Change model")}
                  fill={false}
                  prominence="quiet"
                  size="compact"
                  onPress={onModel}
                />
              ) : null}
              <NativeActionButton
                label={t("Details")}
                prominence="quiet"
                size="compact"
                onPress={onDetails}
              />
            </View>
          </View>
        ) : null}
      </GlassSurface>
    </View>
  );
}
