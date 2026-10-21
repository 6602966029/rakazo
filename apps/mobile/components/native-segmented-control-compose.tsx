import {
  Host,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from "@expo/ui/jetpack-compose";
import { alpha, defaultMinSize, height } from "@expo/ui/jetpack-compose/modifiers";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { NativeSegmentedControlProps } from "../lib/native-controls";

/** Loaded only after the running binary's Compose views have been checked. */
export default function ComposeSegmentedControl<T extends string>({
  accessibilityLabel,
  value,
  onChange,
  options,
  disabled = false,
}: NativeSegmentedControlProps<T>) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  const selectedFill = scheme === "light" ? tokens.popover : tokens.chatUser;
  const [width, setWidth] = useState(0);
  const colors = {
    activeContainerColor: selectedFill,
    inactiveContainerColor: tokens.accent,
    activeContentColor: tokens.foreground,
    inactiveContentColor: tokens.mutedForeground,
    activeBorderColor: tokens.border,
    inactiveBorderColor: tokens.border,
    disabledActiveContainerColor: selectedFill,
    disabledInactiveContainerColor: tokens.accent,
    disabledActiveContentColor: tokens.mutedForeground,
    disabledInactiveContentColor: tokens.mutedForeground,
    disabledActiveBorderColor: tokens.border,
    disabledInactiveBorderColor: tokens.border,
  };
  return (
    <ScrollView
      horizontal
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", flexGrow: 0, height: 40 }}
    >
      <View>
        {/* Material's icon cannot be hidden by this API. Intrinsic sizing preserves its labels. */}
        <View importantForAccessibility="no-hide-descendants" pointerEvents="none">
          <Host
            colorScheme={scheme}
            seedColor={tokens.foreground}
            matchContents={{ horizontal: true }}
            style={{ height: 40 }}
          >
            <SingleChoiceSegmentedButtonRow
              modifiers={[
                defaultMinSize({ minWidth: width }),
                height(40),
                alpha(disabled ? 0.38 : 1),
              ]}
            >
              {options.map((option) => (
                <SegmentedButton
                  key={option.value}
                  selected={value === option.value}
                  enabled={!disabled}
                  colors={colors}
                  onClick={() => {
                    if (!disabled) onChange(option.value);
                  }}
                >
                  <SegmentedButton.Label>
                    <Text maxLines={1} softWrap={false} style={{ fontSize: 14 }}>
                      {option.label}
                    </Text>
                  </SegmentedButton.Label>
                </SegmentedButton>
              ))}
            </SingleChoiceSegmentedButtonRow>
          </Host>
        </View>
        {/* Expo's semantics modifier cannot merge or clear the Material and label nodes.
            Own a single labeled radio per segment, including the group name, as on the switch. */}
        <View style={[StyleSheet.absoluteFill, { flexDirection: "row" }]}>
          {options.map((option) => (
            <Pressable
              key={option.value}
              accessible
              accessibilityRole="radio"
              accessibilityLabel={`${accessibilityLabel}, ${option.label}`}
              accessibilityState={{ selected: value === option.value, disabled }}
              disabled={disabled}
              onPress={() => {
                if (!disabled) onChange(option.value);
              }}
              style={{ flex: 1 }}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
