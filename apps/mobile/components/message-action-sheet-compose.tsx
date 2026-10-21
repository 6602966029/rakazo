import type { ModalBottomSheetRef } from "@expo/ui/jetpack-compose";
import { Host, LazyColumn, ListItem, ModalBottomSheet, Text } from "@expo/ui/jetpack-compose";
import { clickable, fillMaxWidth, padding } from "@expo/ui/jetpack-compose/modifiers";
import { tokensForAppearance } from "@rakazo/ui-tokens";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  dismissMessageActionSheet,
  getMessageActionSheet,
  mountMessageActionSheetHost,
  selectMessageActionSheet,
  subscribeMessageActionSheet,
} from "../lib/message-action-sheet-store";

export default function AndroidMessageActionSheetHost() {
  const sheet = useSyncExternalStore(
    subscribeMessageActionSheet,
    getMessageActionSheet,
    getMessageActionSheet,
  );
  const ref = useRef<ModalBottomSheetRef>(null);
  useEffect(mountMessageActionSheetHost, []);
  if (!sheet) return null;
  const tokens = tokensForAppearance(sheet.colorScheme);
  return (
    <Host
      useViewportSizeMeasurement
      colorScheme={sheet.colorScheme}
      seedColor={tokens.primary}
      style={{ position: "absolute", width: 0, height: 0 }}
    >
      <ModalBottomSheet
        ref={ref}
        skipPartiallyExpanded
        containerColor={tokens.card}
        contentColor={tokens.foreground}
        scrimColor={tokens.overlay}
        onDismissRequest={() => dismissMessageActionSheet(sheet)}
      >
        <LazyColumn modifiers={[fillMaxWidth()]}>
          {sheet.title ? (
            <Text
              color={tokens.foreground}
              style={{ typography: "titleMedium" }}
              modifiers={[padding(16, 8, 16, 12)]}
            >
              {sheet.title}
            </Text>
          ) : null}
          {sheet.actions.map((action, index) => (
            <ListItem
              key={`${index}-${action.text}`}
              colors={{ containerColor: tokens.card, contentColor: tokens.foreground }}
              modifiers={[
                fillMaxWidth(),
                clickable(() => {
                  void selectMessageActionSheet(sheet, index, async () => {
                    await ref.current?.hide();
                  });
                }),
              ]}
            >
              <ListItem.HeadlineContent>
                <Text color={tokens.foreground}>{action.text}</Text>
              </ListItem.HeadlineContent>
            </ListItem>
          ))}
        </LazyColumn>
      </ModalBottomSheet>
    </Host>
  );
}
