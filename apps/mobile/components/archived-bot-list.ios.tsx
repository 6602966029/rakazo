import {
  Button,
  ContextMenu,
  Host,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  SwipeActions,
  Text,
} from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  buttonStyle,
  disabled,
  foregroundStyle,
  frame,
  listRowInsets,
  listSectionMargins,
  listStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MobileBot, MobileGroup } from "../lib/api";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import type { ArchivedBotListProps } from "./archived-bot-list";

export function ArchivedBotList({
  bots,
  groups,
  pending,
  onOpen,
  onRestore,
  onDelete,
  onRestoreGroup,
}: ArchivedBotListProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // The list sits under the floating header. Its height comes from navigation, not from the
  // hosting view's safe area, which can be stale after a text size change and put the first
  // row under the close button and title. The inset is a spacer inside the scroll content, not
  // padding on the list, so rows still scroll under the header.
  const headerInset = useFloatingHeaderInset();
  const scheme = useResolvedAppearance();
  const tokens = useMobileTokens();
  function actions(bot: MobileBot) {
    return (
      <>
        <Button
          label={t("Restore")}
          systemImage="arrow.uturn.backward"
          onPress={() => onRestore(bot)}
        />
        {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI Button role, not an ARIA role. */}
        <Button
          label={t("Delete")}
          systemImage="trash"
          role="destructive"
          onPress={() => onDelete(bot)}
        />
      </>
    );
  }
  function groupActions(group: MobileGroup) {
    return (
      <Button
        label={t("Restore")}
        systemImage="arrow.uturn.backward"
        onPress={() => onRestoreGroup(group)}
      />
    );
  }
  return (
    <Host
      style={{ flex: 1 }}
      colorScheme={scheme}
      seedColor={tokens.foreground}
      ignoreSafeArea={headerInset > 0 ? "container" : undefined}
    >
      <List modifiers={[listStyle("insetGrouped")]}>
        <Section
          modifiers={
            iosAtLeast(26)
              ? [
                  listSectionMargins({
                    edges: "top",
                    length: 0,
                  }),
                ]
              : undefined
          }
          header={
            headerInset > 0 ? (
              <Spacer
                modifiers={[
                  frame({ height: headerInset }),
                  listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
                ]}
              />
            ) : undefined
          }
          footer={<Spacer modifiers={[frame({ height: insets.bottom })]} />}
        >
          <List.ForEach>
            {bots.map((bot) => (
              <SwipeActions key={bot.id} modifiers={[disabled(pending)]}>
                <ContextMenu>
                  <ContextMenu.Trigger>
                    <Button onPress={() => onOpen(bot)} modifiers={[buttonStyle("plain")]}>
                      <HStack spacing={12}>
                        <Text modifiers={[foregroundStyle(tokens.foreground)]}>{bot.name}</Text>
                        <Spacer />
                        <Image
                          systemName="chevron.right"
                          modifiers={[foregroundStyle({ type: "hierarchical", style: "tertiary" })]}
                        />
                      </HStack>
                    </Button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Items>{actions(bot)}</ContextMenu.Items>
                </ContextMenu>
                <SwipeActions.Actions allowsFullSwipe={false}>{actions(bot)}</SwipeActions.Actions>
              </SwipeActions>
            ))}
            {groups.map((group) => (
              <SwipeActions key={`group-${group.id}`} modifiers={[disabled(pending)]}>
                <ContextMenu>
                  <ContextMenu.Trigger>
                    <HStack
                      spacing={12}
                      modifiers={[
                        accessibilityElement("ignore"),
                        accessibilityLabel(`${group.name}, ${t("Group")}`),
                      ]}
                    >
                      <Image
                        systemName="person.2"
                        modifiers={[foregroundStyle({ type: "hierarchical", style: "secondary" })]}
                      />
                      <Text modifiers={[foregroundStyle(tokens.foreground)]}>{group.name}</Text>
                      <Spacer />
                    </HStack>
                  </ContextMenu.Trigger>
                  <ContextMenu.Items>{groupActions(group)}</ContextMenu.Items>
                </ContextMenu>
                <SwipeActions.Actions allowsFullSwipe={false}>
                  {groupActions(group)}
                </SwipeActions.Actions>
              </SwipeActions>
            ))}
          </List.ForEach>
        </Section>
      </List>
    </Host>
  );
}
