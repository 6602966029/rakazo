import { normalizeRunError } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { useEffect, useReducer, useState } from "react";
import { Modal, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { RunErrorActions, RunErrorTextAction } from "./run-error-actions";

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
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const error = useRunError(details);
  const [technical, setTechnical] = useState(false);
  useEffect(() => setTechnical(false), [details]);
  if (!error) return null;
  const textStyle = { color: tokens.foreground, fontSize: 16, lineHeight: 24 };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
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
          <Text style={textStyle}>{error.summary}</Text>
          {error.recovery ? (
            <>
              {error.recovery === "connection" ? (
                <Text style={textStyle}>
                  {t("The provider did not report whether this was a personal or shared key.")}
                </Text>
              ) : null}
              <Text style={textStyle}>
                {t("Check your model connection or choose another model.")}
              </Text>
              <RunErrorActions
                onConnection={error.recovery === "connection" ? onConnection : undefined}
                onModel={onModel}
              />
            </>
          ) : null}
          <RunErrorTextAction
            label={t("Technical details")}
            onPress={() => setTechnical(!technical)}
          />
          {technical ? (
            <>
              <Text selectable style={textStyle}>
                {details}
              </Text>
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
    </Modal>
  );
}
