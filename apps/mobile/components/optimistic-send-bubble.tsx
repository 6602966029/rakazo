import { formatMonthDayTime } from "@rakazo/core";
import * as Clipboard from "expo-clipboard";
import { Image, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { messageMenuEntry } from "../lib/message-context-menu";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import { MessageContextMenu } from "./message-context-menu";
import { SendProgress } from "./send-progress";

/** The user's message until the server has it: shown at once, like a sent one, with its send state. */
export function OptimisticSendBubble({
  attempt,
  progressSince,
  onRetry,
  onCancelSend,
  onSelectText,
}: {
  attempt: SendAttempt;
  /** Set on the bubble that shows send progress: since when sending has been going on. */
  progressSince?: number;
  onRetry: () => void;
  onCancelSend: () => void;
  onSelectText: (text: string) => void;
}) {
  const { locale, t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { width: windowWidth } = useWindowDimensions();
  const { payload, state } = attempt;
  const undelivered = state === "failed" || state === "refused";
  const footer =
    state === "pending" && attempt.heldOffline
      ? t("Sent while offline · {time}", {
          time: formatMonthDayTime(attempt.createdAt, dateLocaleForUi(locale)),
        })
      : undelivered
        ? t("Not delivered")
        : null;
  const stateLabel =
    footer ??
    (state === "queued" ? t("Messages waiting to send until the server reconnects") : t("Sending"));
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const text = payload.displayText;
  const copy = () => {
    if (text) void Clipboard.setStringAsync(text).catch(() => undefined);
  };
  const actions = [
    { name: "copy", text: t("Copy"), onPress: copy },
    ...(text
      ? [{ name: "select", text: t("Select text"), onPress: () => onSelectText(text) }]
      : []),
    // A message already going out can't be taken back.
    ...(state === "pending"
      ? []
      : [{ name: "cancelSend", text: t("Cancel send"), onPress: onCancelSend }]),
  ];
  const menu = actions.map((action) =>
    messageMenuEntry(action.name as "copy" | "select" | "cancelSend", action.text),
  );

  return (
    // Each row keeps its own width at the right edge, so a footer wider than the bubble can't move it.
    <View
      style={{
        alignSelf: "flex-end",
        alignItems: "flex-end",
        maxWidth: "90%",
        marginTop: 12,
        gap: 4,
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
            alignSelf: "flex-end",
          }}
        >
          {payload.replyPreview}
        </Text>
      ) : null}
      <MessageContextMenu
        actions={menu}
        maxWidth={(windowWidth - 40) * 0.9}
        colorScheme={colorScheme}
        onAction={(id) => actions.find((action) => action.name === id)?.onPress()}
        onLongPress={
          Platform.OS === "ios"
            ? undefined
            : () =>
                presentMessageActionSheet({
                  actions,
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                })
        }
      >
        <View
          accessible
          accessibilityLabel={messageLabel ? `${messageLabel}. ${stateLabel}` : stateLabel}
          accessibilityActions={actions.map(({ name, text: label }) => ({ name, label }))}
          onAccessibilityAction={(event) =>
            actions.find((action) => action.name === event.nativeEvent.actionName)?.onPress()
          }
          style={{
            borderRadius: 20,
            backgroundColor: tokens.secondary,
            ...(payload.attachments.length
              ? {
                  borderWidth: 1,
                  borderColor: tokens.border,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }
              : { padding: 12 }),
            gap: 8,
          }}
        >
          {text ? (
            <Text style={{ color: tokens.secondaryForeground, fontSize: 15.5, lineHeight: 23 }}>
              {text}
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
          {progressSince !== undefined ? <SendProgress since={progressSince} /> : null}
        </View>
      </MessageContextMenu>
      {footer ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            maxWidth: "100%",
            gap: 6,
            // Clears the progress bar that hangs below the bubble's corner.
            marginTop: progressSince !== undefined ? 6 : 0,
          }}
        >
          {/* The bubble's own label already says this. Long captions wrap instead of widening the row. */}
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={{
              color: tokens.mutedForeground,
              fontSize: 12,
              flexShrink: 1,
              textAlign: "right",
            }}
          >
            {footer}
          </Text>
          {state === "failed" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Retry send")}
              hitSlop={8}
              onPress={onRetry}
            >
              <Text style={{ color: tokens.primary, fontSize: 12, fontWeight: "600" }}>
                {t("Retry")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
