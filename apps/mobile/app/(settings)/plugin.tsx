import type { CapabilityInstall, McpServer, PluginPreview } from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { PluginIcon } from "../../components/plugin-icon";
import { Chevron } from "../../components/row-accessories";
import { rpc } from "../../lib/api";
import { useAppForeground } from "../../lib/app-foreground";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { loadLastBotId } from "../../lib/last-bot";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import type { PluginParams } from "../../lib/plugin-marketplace";
import { mcpServerReady, sourceHref } from "../../lib/plugin-marketplace";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

const SKILLS_SHOWN = 5;

export default function PluginScreen() {
  const params = useLocalSearchParams<PluginParams>();
  const navigation = useNavigation();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const foreground = useAppForeground();
  const [installs, setInstalls] = useState<CapabilityInstall[]>([]);
  const [allServers, setAllServers] = useState<McpServer[]>([]);
  const [assigned, setAssigned] = useState(new Set<string>());
  const [botId, setBotId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allSkills, setAllSkills] = useState(false);
  const [skippedOpen, setSkippedOpen] = useState(false);
  const [noAuth, setNoAuth] = useState(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    const [installRows, serverRows, lastBot] = await Promise.all([
      rpc("capabilities/list"),
      rpc("mcp/servers/list"),
      loadLastBotId(),
    ]);
    const assignments = lastBot
      ? await rpc("mcp/assignments/list", { botId: lastBot }).catch(() => [])
      : [];
    if (!live.current) return;
    setInstalls(installRows);
    setAllServers(serverRows);
    setBotId(lastBot);
    setAssigned(new Set(assignments.map((row) => row.serverId)));
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      live.current = true;
      void load().catch((reason) => {
        if (live.current) setError(errorText(reason, t("Could not load plugin")));
      });
      return () => {
        live.current = false;
      };
    }, [load, t]),
  );

  // Sign-in finishes in the browser, so coming back is the moment to look again.
  useEffect(() => {
    if (foreground && loaded) void load().catch(() => undefined);
  }, [foreground]);

  // A pasted URL can differ from the normalized source the install is saved under.
  const install = installs.find(
    (row) =>
      row.kind === "plugin" &&
      (row.source === params.installedSource || row.source === preview?.installedSource),
  );
  const servers = install ? allServers.filter((server) => server.installId === install.id) : [];
  const installed = Boolean(install);
  useEffect(() => {
    if (!loaded || installed) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setPreviewLoading(true);
    rpc("capabilities/pluginPreview", { source: params.source })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason, t("Could not preview plugin")));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, installed, params.source, attempt]);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (live.current) setError(errorText(reason, failure));
    } finally {
      if (live.current) setPending(null);
    }
  }

  const add = () =>
    preview &&
    run(
      "install",
      async () => {
        await rpc("capabilities/install", {
          kind: "plugin",
          name: preview.name,
          source: preview.pinnedSource ?? params.source,
          pluginDigest: preview.digest,
          config: {},
        });
        await load();
      },
      t("Could not install plugin"),
    );

  const remove = () =>
    install &&
    Alert.alert(t("Remove {name}?", { name: params.name }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Remove"),
        style: "destructive",
        onPress: () =>
          void run(
            "remove",
            async () => {
              await rpc("capabilities/remove", { id: install.id });
              if (live.current) router.back();
            },
            t("Could not remove plugin"),
          ),
      },
    ]);

  const signIn = (server: McpServer) =>
    run(
      server.id,
      async () => {
        const { webUrl } = await rpc("integrationSetup/get");
        const started = await rpc("mcp/oauth/begin", {
          serverId: server.id,
          redirectUri: new URL("/mcp/oauth/callback", webUrl).toString(),
        });
        if (started.status === "authorization_required") {
          await Linking.openURL(started.authorizationUrl);
          return;
        }
        if (started.status === "authorization_not_requested")
          setNoAuth((current) => new Set([...current, server.id]));
        await load();
      },
      t("Could not sign in"),
    );

  const enable = (server: McpServer) =>
    run(
      server.id,
      async () => {
        await rpc("mcp/assignments/approve", { botId, serverId: server.id });
        await load();
      },
      t("Could not enable tools"),
    );

  const busy = Boolean(pending);
  const canAdd = Boolean(preview && (preview.skills.length || preview.mcpServers.length));
  const action = installed
    ? { label: pending === "remove" ? t("Removing…") : t("Remove"), onPress: remove }
    : { label: pending === "install" ? t("Adding…") : t("Add"), onPress: add };
  const actionDisabled = !loaded || busy || (!installed && !canAdd);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: params.name,
      headerRight: iosAtLeast(26)
        ? undefined
        : () => (
            <NativeActionButton
              disabled={actionDisabled}
              fill={false}
              label={action.label}
              onPress={() => void action.onPress()}
              prominence={installed ? "destructive" : "primary"}
            />
          ),
      ...(iosAtLeast(26)
        ? {
            unstable_headerRightItems: () => [
              {
                type: "button" as const,
                label: action.label,
                ...(installed
                  ? { tintColor: mobileTokens().destructive }
                  : { variant: "prominent" as const, tintColor: mobileTokens().primary }),
                disabled: actionDisabled,
                onPress: () => void action.onPress(),
              },
            ],
          }
        : {}),
    } satisfies NativeStackNavigationOptions);
  }, [navigation, params.name, installed, action.label, actionDisabled]);

  const parsed = install ? PluginPreviewSchema.safeParse(install.config) : null;
  const detail = parsed?.success ? parsed.data : preview;
  const description = detail?.description || params.description;
  const skills = detail?.skills ?? [];
  const shownSkills = allSkills ? skills : skills.slice(0, SKILLS_SHOWN);
  const prefix = `${detail?.name ?? ""}: `;
  const appCount = installed ? servers.length : (detail?.mcpServers.length ?? 0);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.hero}>
          <PluginIcon logo={params.logo} name={params.name} site={params.site} size={56} />
          <View style={styles.grow}>
            <Text numberOfLines={2} style={styles.name}>
              {params.name}
            </Text>
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() =>
                void Linking.openURL(sourceHref(params.installedSource, detail?.resolvedSha))
              }
              style={styles.sourceLink}
            >
              <Text style={styles.secondary}>{t("View source")}</Text>
              <NativeSymbol
                android="open-outline"
                color={native.secondaryLabel}
                ios="arrow.up.right"
                size={12}
              />
            </Pressable>
          </View>
        </View>

        {description ? <Text style={styles.description}>{description}</Text> : null}

        {error ? (
          <View style={styles.errorRow}>
            <Text style={styles.error}>{error}</Text>
            {!installed && !preview && !previewLoading && loaded ? (
              <NativeActionButton
                fill={false}
                label={t("Retry")}
                onPress={() => setAttempt((value) => value + 1)}
                prominence="secondary"
              />
            ) : null}
          </View>
        ) : null}

        {!loaded || previewLoading ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
        ) : null}

        {appCount ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {t("Apps")} <Text style={styles.count}>{appCount}</Text>
            </Text>
            <View style={styles.card}>
              {installed
                ? servers.map((server, index) => (
                    <View
                      key={server.id}
                      accessibilityLabel={server.name}
                      style={[styles.item, index > 0 && styles.divider]}
                    >
                      <View style={styles.itemRow}>
                        <NativeSymbol
                          android="flash-outline"
                          color={native.secondaryLabel}
                          ios="powerplug"
                          size={15}
                        />
                        <View style={styles.grow}>
                          <Text numberOfLines={1} style={styles.title}>
                            {server.name.startsWith(prefix)
                              ? server.name.slice(prefix.length)
                              : server.name}
                          </Text>
                          <Text numberOfLines={1} style={styles.secondary}>
                            {server.endpoint}
                          </Text>
                        </View>
                        {mcpServerReady(server) ? (
                          <View accessible accessibilityLabel={t("Connected")}>
                            <NativeSymbol
                              ios="checkmark.circle.fill"
                              android="checkmark-circle"
                              size={16}
                              color={mobileTokens().success}
                            />
                          </View>
                        ) : null}
                      </View>
                      <View style={styles.itemActions}>
                        {mcpServerReady(server) || noAuth.has(server.id) ? null : (
                          <NativeActionButton
                            busy={pending === server.id}
                            disabled={busy}
                            fill={false}
                            label={
                              server.oauthStatus === "reconnect" ? t("Reconnect") : t("Sign in")
                            }
                            onPress={() => void signIn(server)}
                            prominence="secondary"
                          />
                        )}
                        {botId ? (
                          assigned.has(server.id) ? (
                            <Text style={styles.secondary}>{t("In this bot")}</Text>
                          ) : (
                            <NativeActionButton
                              disabled={busy}
                              fill={false}
                              label={t("Use in this bot")}
                              onPress={() => void enable(server)}
                              prominence="secondary"
                            />
                          )
                        ) : null}
                      </View>
                    </View>
                  ))
                : detail?.mcpServers.map((server, index) => (
                    <View
                      key={server.name}
                      style={[styles.item, styles.itemRow, index > 0 && styles.divider]}
                    >
                      <NativeSymbol
                        android="flash-outline"
                        color={native.secondaryLabel}
                        ios="powerplug"
                        size={15}
                      />
                      <View style={styles.grow}>
                        <Text numberOfLines={1} style={styles.title}>
                          {server.name}
                        </Text>
                        <Text numberOfLines={1} style={styles.secondary}>
                          {server.endpoint}
                        </Text>
                      </View>
                    </View>
                  ))}
            </View>
          </View>
        ) : null}

        {skills.length ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {t("Skills")} <Text style={styles.count}>{skills.length}</Text>
            </Text>
            <View style={styles.card}>
              {shownSkills.map((skill, index) => (
                <View
                  key={skill.name}
                  style={[styles.item, styles.itemRow, index > 0 && styles.divider]}
                >
                  <NativeSymbol
                    android="cube-outline"
                    color={native.secondaryLabel}
                    ios="shippingbox"
                    size={15}
                  />
                  <View style={styles.grow}>
                    <Text numberOfLines={1} style={styles.title}>
                      {skill.name}
                    </Text>
                    {skill.description ? (
                      <Text numberOfLines={2} style={styles.secondary}>
                        {skill.description}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              {skills.length > shownSkills.length ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAllSkills(true)}
                  style={[styles.item, styles.divider]}
                >
                  <Text style={styles.more}>
                    {t("{count} more", { count: skills.length - shownSkills.length })}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {detail?.skipped.length ? (
          <View style={styles.section}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: skippedOpen }}
              onPress={() => setSkippedOpen((open) => !open)}
              style={styles.disclosure}
            >
              <Text style={styles.secondary}>
                {detail.skipped.length === 1
                  ? t("1 part not added")
                  : t("{count} parts not added", { count: detail.skipped.length })}
              </Text>
              <Chevron expanded={skippedOpen} />
            </Pressable>
            {skippedOpen
              ? detail.skipped.map((entry, index) => (
                  <Text key={`${entry.kind}:${entry.name}:${index}`} style={styles.secondary}>
                    <Text style={styles.skippedName}>{entry.name}</Text> {entry.reason}
                  </Text>
                ))
              : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 20 },
    hero: { flexDirection: "row", alignItems: "center", gap: 14 },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    name: { color: native.label, fontSize: 22, fontWeight: "600" },
    sourceLink: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" },
    description: { color: native.secondaryLabel, fontSize: 15, lineHeight: 21 },
    section: { gap: 8 },
    sectionTitle: { color: native.label, fontSize: 15, fontWeight: "600", paddingHorizontal: 4 },
    count: { color: native.secondaryLabel, fontWeight: "400" },
    card: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    item: { paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
    itemRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    itemActions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 8,
      paddingLeft: 27,
    },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: native.separator },
    title: { color: native.label, fontSize: 15, fontWeight: "500" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    more: { color: native.label, fontSize: 14, textAlign: "right" },
    disclosure: {
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 4,
    },
    skippedName: { color: native.label, fontWeight: "500" },
    errorRow: { gap: 8 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
