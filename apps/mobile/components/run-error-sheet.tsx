import { normalizeRunError } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useEffect, useReducer, useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { parseRunDiagnostic, runErrorExplanation } from "../lib/run-error-presentation";
import { NativeSymbol } from "./native-symbol";
import { RunErrorActions, RunErrorTextAction } from "./run-error-actions";
import { RunErrorSheetContainer } from "./run-error-sheet-container";

/** Saved provider diagnostics do not identify the credential owner. */
export function useRunError(details: string | null, includeReset = true) {
  const { t, locale } = useI18n();
  const [clockVersion, refreshClock] = useReducer((version: number) => version + 1, 0);
  const error = details
    ? normalizeRunError(
        details,
        (message, values) => {
          if (!includeReset && message === "{summary} Resets {date}.")
            return String(values?.summary ?? "");
          if (message === "Your OpenRouter") return "OpenRouter";
          if (message === "Your OpenAI") return "OpenAI";
          if (message === "Your Anthropic") return "Anthropic";
          if (message === "Your model provider") return t("Model provider");
          return t(message, values);
        },
        locale,
        Date.now(),
      )
    : null;
  useEffect(() => {
    if (!error?.resetAt) return;
    const timer = setTimeout(
      refreshClock,
      Math.min(2_147_483_647, Math.max(0, error.resetAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [error?.resetAt, clockVersion]);
  return error;
}

export function RunErrorSheet({
  details,
  onClose,
  onConnection,
  onModel,
}: {
  details: string | null;
  onClose: () => void;
  onConnection: () => void;
  onModel?: () => void;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const error = useRunError(details, false);
  const [technical, setTechnical] = useState(false);
  useEffect(() => setTechnical(false), [details]);
  if (!error) return null;
  const diagnostic = parseRunDiagnostic(details ?? "", locale);
  const explanation = runErrorExplanation(
    t,
    error.recovery === "connection",
    !!error.recovery && !!onModel,
  );
  const textStyle = { color: tokens.foreground, fontSize: 16, lineHeight: 24 };
  return (
    <RunErrorSheetContainer onClose={onClose}>
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "flex-end", padding: 16 }}>
          <RunErrorTextAction label={t("Done")} onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: 16 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <NativeSymbol
              ios="exclamationmark.triangle.fill"
              android="warning"
              size={18}
              color={tokens.warning}
            />
            <Text style={{ flex: 1, color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
              {error.summary}
            </Text>
          </View>
          {explanation ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{explanation}</Text>
          ) : null}
          {error.recovery ? (
            <>
              {error.recovery === "connection" ? (
                <Text style={{ color: tokens.mutedForeground, fontSize: 14, lineHeight: 20 }}>
                  {t("The provider did not report whether this was a personal or shared key.")}
                </Text>
              ) : null}
              <RunErrorActions
                onConnection={error.recovery === "connection" ? onConnection : undefined}
                onModel={onModel}
              />
            </>
          ) : null}
          <RunErrorTextAction
            label={t("Technical details")}
            expanded={technical}
            onPress={() => setTechnical(!technical)}
          />
          {technical ? (
            <>
              {[
                [t("Status"), diagnostic.status],
                [t("Provider message"), diagnostic.message],
                [t("Limit"), diagnostic.limit],
                [t("Resets"), diagnostic.resets],
              ].map(([label, value]) =>
                value ? (
                  <View key={label} style={{ gap: 4 }}>
                    <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{label}</Text>
                    <Text selectable style={textStyle}>
                      {value}
                    </Text>
                  </View>
                ) : null,
              )}
              <RunErrorTextAction
                label={t("Copy")}
                onPress={() => {
                  void Clipboard.setStringAsync(details ?? "");
                }}
              />
            </>
          ) : null}
        </ScrollView>
      </View>
    </RunErrorSheetContainer>
  );
}
