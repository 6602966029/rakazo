import type { ChatModelChoice } from "@rakazo/core";
import { groupModelChoices } from "@rakazo/core";
import { useNavigation } from "expo-router";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { Checkmark } from "./row-accessories";
import { SettingsLabel, SettingsRow } from "./settings-group";

/** Searchable grouped model cells shared by chat and connection settings. */
export function ModelPickerList({
  choices,
  selectedKey,
  onSelect,
  error,
  providerLabel,
}: {
  choices: readonly ChatModelChoice[] | null;
  selectedKey: string;
  onSelect: (choice: ChatModelChoice) => void;
  error?: string | null;
  /** A single-provider picker only needs vendor headings. */
  providerLabel?: string;
}) {
  const { t } = useI18n();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState("");
  useLayoutEffect(() => {
    if (Platform.OS === "android") return;
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t("Search"),
        hideWhenScrolling: false,
        hideNavigationBar: false,
        autoCapitalize: "none",
        onChangeText: (event: { nativeEvent: { text: string } }) =>
          setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        onClose: () => setQuery(""),
      },
    });
  }, [navigation, t]);

  const sections = useMemo(
    () =>
      choices
        ? groupModelChoices(choices, query).map((section) => ({
            ...section,
            heading:
              providerLabel && section.heading === providerLabel
                ? undefined
                : providerLabel && section.heading?.startsWith(`${providerLabel} · `)
                  ? section.heading.slice(providerLabel.length + 3)
                  : section.heading,
          }))
        : [],
    [choices, query, providerLabel],
  );
  const noMatches = choices !== null && sections.length === 0;

  // The search field keeps focus, so tell screen readers once when the results run out.
  useEffect(() => {
    if (noMatches) AccessibilityInfo.announceForAccessibility(t("No matching models"));
  }, [noMatches, t]);

  return (
    <SectionList
      key={Platform.OS === "android" ? "android" : query}
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 72 }]}
      // Reserve the floating search field; UIKit adds the keyboard and header insets.
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      sections={sections}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) =>
        section.heading ? (
          <View style={styles.sectionHeading}>
            <SettingsLabel>{section.heading}</SettingsLabel>
          </View>
        ) : null
      }
      renderSectionFooter={() => <View style={styles.sectionGap} />}
      keyExtractor={(choice) => choice.key || "space-default"}
      ItemSeparatorComponent={() => (
        <View style={styles.cell}>
          <View style={styles.separator} />
        </View>
      )}
      ListHeaderComponent={
        Platform.OS === "android" ? (
          <TextInput
            accessibilityLabel={t("Search")}
            placeholder={t("Search")}
            placeholderTextColor={native.secondaryLabel}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.search}
          />
        ) : null
      }
      ListEmptyComponent={
        error || noMatches ? (
          <Text style={styles.empty}>{error ?? t("No matching models")}</Text>
        ) : (
          <ActivityIndicator color={native.secondaryLabel} />
        )
      }
      renderItem={({ item, index, section }) => {
        const selected = item.key === selectedKey;
        return (
          <View
            style={[
              styles.cell,
              index === 0 && styles.first,
              index === section.data.length - 1 && styles.last,
            ]}
          >
            <SettingsRow
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ selected }}
              onPress={() => onSelect(item)}
              title={item.title ?? item.label}
              detail={item.detail}
              trailing={selected ? <Checkmark /> : null}
            />
          </View>
        );
      }}
    />
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingHorizontal: 16, paddingTop: 16 },
    sectionHeading: { paddingBottom: 7 },
    sectionGap: { height: 20 },
    cell: { backgroundColor: native.fill, overflow: "hidden" },
    first: { borderTopLeftRadius: 16, borderTopRightRadius: 16, borderCurve: "continuous" },
    last: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderCurve: "continuous" },
    separator: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: native.separator,
    },
    search: {
      color: native.label,
      backgroundColor: native.fill,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
      fontSize: 17,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 15,
      paddingHorizontal: 16,
      paddingVertical: 10,
      textAlign: "center",
    },
  });
}
