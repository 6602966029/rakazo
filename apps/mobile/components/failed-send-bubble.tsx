import { isModelRequiredSendError } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { ActionSheetIOS, Alert, Image, Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { openModelSettings } from "../lib/model-settings";
import { useMobileTokens } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import { NativeSymbol } from "./native-symbol";

export function FailedSendBubble({
  attempt,
  onRetry,
  onDelete,
}: {
  attempt: SendAttempt;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { payload, state } = attempt;
  const sending = state === "pending";
  const retryable = state === "failed" || state === "queued";
  const modelRequired = isModelRequiredSendError(attempt.error);
  const caption = sending
    ? t("Sending…")
    : retryable
      ? t("Not sent · Tap to retry")
      : t("Not sent");
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const color = sending ? tokens.mutedForeground : tokens.destructive;

  function showActions() {
    const actions = [
      ...(modelRequired ? [{ text: t("Add Model"), onPress: openModelSettings }] : []),
      ...(retryable ? [{ text: t("Try Again"), onPress: onRetry }] : []),
      { text: t("Delete"), style: "destructive" as const, onPress: onDelete },
    ];
    const message = modelRequired ? t("Add an AI model to keep chatting.") : attempt.error;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          message,
          options: [...actions.map((action) => action.text), t("Cancel")],
          destructiveButtonIndex: actions.length - 1,
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.onPress(),
      );
    } else {
      // Android supports three buttons; the sheet can also be dismissed outside it.
      Alert.alert(
        caption,
        message,
        [...actions, ...(!modelRequired ? [{ text: t("Cancel"), style: "cancel" as const }] : [])],
        { cancelable: true },
      );
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
      accessibilityHint={sending ? undefined : t("Long press to delete")}
      accessibilityState={{ disabled: sending }}
      disabled={sending}
      onPress={retryable ? onRetry : undefined}
      onLongPress={showActions}
      style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12, gap: 4 }}
    >
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.secondary,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
          opacity: 0.8,
        }}
      >
        {payload.replyPreview ? (
          <Text
            numberOfLines={3}
            style={{
              color: tokens.mutedForeground,
              fontSize: 13,
              borderLeftWidth: 2,
              borderLeftColor: tokens.border,
              paddingLeft: 8,
            }}
          >
            {payload.replyPreview}
          </Text>
        ) : null}
        {payload.displayText ? (
          <Text style={{ color: tokens.secondaryForeground, ...typeScale.body }}>
            {payload.displayText}
          </Text>
        ) : null}
        {payload.attachments.map((attachment) => (
          <View key={attachment.id} style={{ gap: 4 }}>
            {attachment.previewUri ? (
              <Image
                source={{ uri: attachment.previewUri }}
                style={{ width: 180, height: 120, borderRadius: 12 }}
              />
            ) : null}
            <Text style={{ color: tokens.secondaryForeground, fontSize: 13 }}>
              {attachment.name}
            </Text>
          </View>
        ))}
      </View>
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 }}
      >
        {!sending ? (
          <NativeSymbol
            ios="exclamationmark.circle.fill"
            android="alert-circle"
            size={13}
            color={color}
          />
        ) : null}
        <Text style={{ color, fontSize: 13 }}>{caption}</Text>
      </View>
    </Pressable>
  );
}
