import type { CapabilityInstall, PluginMarketplaceEntry } from "@rakazo/contracts";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { PluginIcon } from "../../components/plugin-icon";
import { Chevron } from "../../components/row-accessories";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import {
  gitImportParams,
  pluginParams,
  pluginSite,
  skillPacks,
} from "../../lib/plugin-marketplace";
import { useSideInsets } from "../../lib/side-insets";

const LOGO_SIZE = 32;

/** Skill packs: plugins with nothing to connect, which teach a bot how to work. */
export default function SkillsScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [entries, setEntries] = useState<PluginMarketplaceEntry[]>([]);
  const [installs, setInstalls] = useState<CapabilityInstall[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "partial">("loading");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const live = useRef(true);

  const load = useCallback(() => {
    void Promise.all([rpc("marketplace/catalog", { query: "" }), rpc("capabilities/list")])
      .then(([catalog, rows]) => {
        if (!live.current) return;
        setEntries(catalog.entries);
        setInstalls(rows.filter((row) => row.kind === "plugin"));
        setState(catalog.unavailableRegistries.length ? "partial" : "ready");
      })
      .catch(() => {
        if (live.current) setState("partial");
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      live.current = true;
      load();
      return () => {
        live.current = false;
      };
    }, [load]),
  );

  useLayoutEffect(() => {
    const toggle = () => setImporting((open) => !open);
    navigation.setOptions(
      iosAtLeast(26)
        ? {
            unstable_headerRightItems: () => [
              { type: "button" as const, label: t("From GitHub"), onPress: toggle },
            ],
          }
        : {
            headerRight: () => (
              <NativeActionButton
                fill={false}
                label={t("From GitHub")}
                onPress={toggle}
                prominence="secondary"
              />
            ),
          },
    );
  }, [navigation, t]);

  const installed = new Set(installs.map((row) => row.source));
  const packs = skillPacks(entries, query);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {importing ? (
          <View testID="plugin-git-import" style={styles.card}>
            <TextInput
              value={gitUrl}
              onChangeText={setGitUrl}
              accessibilityLabel={t("Plugin GitHub URL")}
              placeholder="https://github.com/owner/plugin"
              placeholderTextColor={native.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              maxLength={2048}
              style={styles.input}
            />
            <NativeActionButton
              disabled={!gitUrl.trim()}
              label={t("Preview")}
              onPress={() => router.push({ pathname: "/plugin", params: gitImportParams(gitUrl) })}
              prominence="secondary"
            />
          </View>
        ) : null}
        <TextInput
          value={query}
          onChangeText={setQuery}
          accessibilityLabel={t("Search skills")}
          placeholder={t("Search skills")}
          placeholderTextColor={native.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
        />
        {state === "partial" ? (
          <View style={styles.row}>
            <Text style={[styles.secondary, styles.grow]}>
              {t("Some plugins could not be loaded.")}
            </Text>
            <NativeActionButton
              fill={false}
              label={t("Retry")}
              onPress={() => {
                setState("loading");
                load();
              }}
              prominence="secondary"
            />
          </View>
        ) : null}
        {state === "loading" ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : null}
        <View testID="skill-packs" style={styles.list}>
          {packs.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={entry.displayName}
              onPress={() => router.push({ pathname: "/plugin", params: pluginParams(entry) })}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <PluginIcon
                logo={entry.logo}
                name={entry.displayName}
                site={pluginSite(entry)}
                size={LOGO_SIZE}
              />
              <View style={styles.grow}>
                <Text numberOfLines={1} style={styles.title}>
                  {entry.displayName}
                </Text>
                {entry.description ? (
                  <Text numberOfLines={1} style={styles.secondary}>
                    {entry.description}
                  </Text>
                ) : null}
              </View>
              {installed.has(entry.installedSource) ? (
                <Text style={styles.secondary}>{t("Added")}</Text>
              ) : (
                <Chevron />
              )}
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    card: { gap: 10 },
    list: { gap: 8 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    pressed: { backgroundColor: native.fillPressed },
    grow: { flex: 1, gap: 2, minWidth: 0 },
    title: { color: native.label, fontSize: 15, fontWeight: "500" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
  });
}
