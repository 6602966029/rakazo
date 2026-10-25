import { MenuView } from "@expo/ui/community/menu";
import type { RunActivityRow, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { normalizeCreateBotProfile } from "@rakazo/contracts";
import { accountDisplay, isRetryableError } from "@rakazo/core";
import type { Href } from "expo-router";
import {
  Redirect,
  useFocusEffect,
  useGlobalSearchParams,
  useIsFocused,
  useNavigation,
  usePathname,
  useRouter,
} from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ViewToken } from "react-native";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotOrganizeModal } from "../components/bot-organize-modal";
import { HomeErrorState } from "../components/home-error-state";
import { createHomeStyles } from "../components/home-styles";
import { ActivitySection } from "../components/inbox-activity";
import { InboxHeader } from "../components/inbox-header";
import {
  ArchivedChatsRow,
  BotRow,
  CompactRowsContext,
  GroupRow,
  PinnedTiles,
  SectionChevron,
  SelectedChatContext,
} from "../components/inbox-rows";
import { NativeSymbol } from "../components/native-symbol";
import { useUnreadJumpPills } from "../components/unread-jump-overlay";
import { fetchSpaceActivity } from "../lib/activity";
import { loadActivityMode, saveActivityMode } from "../lib/activity-mode";
import { readableGutters } from "../lib/adaptive-layout";
import type {
  MobileBot,
  MobileBotSection,
  MobileGroup,
  MobileMe,
  MobileSpace,
  MobileSpaceNavigation,
} from "../lib/api";
import {
  captureApiRequestContext,
  currentApiBase,
  loadSessionToken,
  rpc,
  selectedSpaceId,
  selectInitialSpace,
  selectSpace,
  signOut,
} from "../lib/api";
import {
  appBadgeGeneration,
  forgetAppBadge,
  syncInboxAppBadge,
  unreadChatCount,
} from "../lib/app-badge";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { AvatarRow, AvatarViewportScope, createAvatarViewport } from "../lib/avatar-life";
import type { CollapsedSections } from "../lib/collapsed-sections";
import { loadCollapsedSections, saveCollapsedSections } from "../lib/collapsed-sections";
import { useHeaderHeightIfAny } from "../lib/floating-header";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { useForegroundPoll } from "../lib/foreground-poll";
import { t, useI18n } from "../lib/i18n";
import { retainInboxValue } from "../lib/inbox-retention";
import type { InboxItem, InboxSpace, PinnedChat } from "../lib/inbox-spaces";
import {
  canDeleteInboxSpace,
  deleteSpaceTitle,
  inboxHasNoChats,
  inboxItemKey,
  inboxNeedsCreateHint,
  inboxSignal,
  removeInboxSpace,
  retryInboxSpaceFallback,
  selectInboxSpace,
  spaceInboxItems,
} from "../lib/inbox-spaces";
import { applyUnreadOverrides, withoutArchiving } from "../lib/inbox-swipe";
import { native, useThemedStyles } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { offerPasskeyOnce } from "../lib/passkey";
import { ACTIVITY_POLL_INTERVAL_MS, INBOX_POLL_INTERVAL_MS } from "../lib/poll-cadence";
import { registerPushToken } from "../lib/push";
import { loadSavedInbox, saveInbox } from "../lib/saved-chats";
import { addToSearchInbox, searchInboxSession, setSearchInbox } from "../lib/search-inbox";
import {
  currentReadySessionGeneration,
  currentSessionGeneration,
  subscribeSessionGeneration,
} from "../lib/session";
import { useSplitView } from "../lib/split-view";
import { useArchivedCount } from "../lib/use-archived-count";
import { useHomeHeader } from "../lib/use-home-header";
import { chatRpc, useInboxChatActions } from "../lib/use-inbox-chat-actions";
import { useInboxDay } from "../lib/use-inbox-day";
import type { LoadFailureKind } from "../lib/user-error";
import { errorText, loadFailureKind } from "../lib/user-error";

/** A row counts as on screen as soon as any of it shows. */
const AVATAR_VIEWABILITY = { itemVisiblePercentThreshold: 1 };
// A list narrower than this, beside an open chat, keeps names whole by leaving out the title tag.
const TAGLESS_LIST_WIDTH = 360;
// Swipe actions and the context menu are iOS list behaviour; other platforms keep the long-press
// sheet.
const SWIPE_ROWS = Platform.OS === "ios";

async function openMobileSpace(spaceId: string | undefined, open: () => void) {
  if (spaceId && !(await selectSpace(spaceId))) {
    Alert.alert(t("Could not switch spaces"), t("Try again."));
    return;
  }
  open();
}

export default function HomeRoute() {
  const { split } = useSplitView();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  useLayoutEffect(() => {
    // Home restores its native controls when the compact inbox mounts again.
    if (split) navigation.setOptions({ headerShown: false });
  }, [split, navigation]);
  return split ? (
    <View
      style={[
        styles.screen,
        styles.centered,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <Text style={styles.emptyPane}>{t("Pick a chat")}</Text>
    </View>
  ) : (
    <HomeSession />
  );
}

/** The chat list beside the open chat on a wide window. */
type InboxPaneProps = { onSelectSpace?: (spaceId: string) => void };

export function InboxPane({ onSelectSpace }: InboxPaneProps) {
  return <HomeSession embedded onSelectSpace={onSelectSpace} />;
}

function HomeSession({ embedded = false, onSelectSpace }: InboxPaneProps & { embedded?: boolean }) {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const ready = useSyncExternalStore(subscribeSessionGeneration, currentReadySessionGeneration);
  return <Home key={`${generation}:${ready}`} embedded={embedded} onSelectSpace={onSelectSpace} />;
}

function Home({ embedded, onSelectSpace }: InboxPaneProps & { embedded: boolean }) {
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t, locale } = useI18n();
  const isFocused = useIsFocused();
  const day = useInboxDay();
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [groups, setGroups] = useState<MobileGroup[]>([]);
  const [botSections, setBotSections] = useState<MobileBotSection[]>([]);
  const [spaces, setSpaces] = useState<MobileSpace[]>([]);
  const [me, setMe] = useState<Pick<MobileMe, "userId" | "spaceId" | "name"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept apart from action errors so a failed action never borrows the load's title.
  const [inboxLoading, setInboxLoading] = useState(false);
  const [loadFailure, setLoadFailure] = useState<{ kind: LoadFailureKind; message: string } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [organizeTarget, setOrganizeTarget] = useState<{
    kind: "bot" | "group";
    id: string;
    spaceId?: string;
    chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup;
    sections: MobileBotSection[];
  } | null>(null);
  const organizeRequestId = useRef(0);
  const [activityMode, setActivityMode] = useState(false);
  const [activity, setActivity] = useState<{ active: RunActivityRow[]; recent: RunActivityRow[] }>({
    active: [],
    recent: [],
  });
  const activityRequestId = useRef(0);
  const inboxRequestId = useRef(0);
  const inboxLoaded = useRef(false);
  const creatingBotRef = useRef(false);
  const spaceActionRef = useRef<{ busy: boolean; recoveryId: string | null }>({
    busy: false,
    recoveryId: null,
  });
  const [spaceBusy, setSpaceBusy] = useState(false);
  const [spaceRecoveryId, setSpaceRecoveryId] = useState<string | null>(null);
  // Roster parent bot ids and section heading keys, kept on this device for the last account
  // that changed them. Loaded before the inbox first renders, so sections don't fold on launch.
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>(() => ({
    keys: new Set(),
  }));
  const userId = me?.userId;
  const collapsed = useMemo(
    () => (collapsedSections.userId === userId ? collapsedSections.keys : new Set<string>()),
    [collapsedSections, userId],
  );
  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsedSections((previous) => {
        const next = new Set(previous.userId === userId ? previous.keys : []);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return { userId, keys: next };
      });
    },
    [userId],
  );
  useEffect(() => {
    if (collapsedSections.userId) {
      saveCollapsedSections(collapsedSections.userId, collapsedSections.keys);
    }
  }, [collapsedSections]);

  useEffect(() => {
    void loadActivityMode().then(setActivityMode);
  }, []);

  // Only while the inbox is in front, so the offer waits until signup setup is done.
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let active = true;
      void offerPasskeyOnce(userId, () => active);
      return () => {
        active = false;
      };
    }, [userId]),
  );

  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      void saveActivityMode(next);
      return next;
    });
  }, []);

  const [badgeLoad, setBadgeLoad] = useState<{ generation: number } | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") forgetAppBadge();
    });
    return () => subscription.remove();
  }, []);

  const loadBots = useCallback(async () => {
    const badgeGeneration = appBadgeGeneration();
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    const requestId = ++inboxRequestId.current;
    const apiBase = currentApiBase();
    const generation = currentSessionGeneration();
    setError(null);
    setInboxLoading(true);
    try {
      const [navigation, nextMe] = await Promise.all([
        rpc<MobileSpaceNavigation>("spaces/list"),
        rpc<MobileMe>("me"),
      ]);
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (!(await selectInitialSpace(nextMe.spaceId))) {
        throw new Error(t("Could not save the default space"));
      }
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      if (nextMe.billingEnabled) {
        void rpc<{ access: boolean; funding?: string | null }>("billing/status")
          .then((billing) => {
            if (
              requestId === inboxRequestId.current &&
              generation === currentSessionGeneration() &&
              apiBase === currentApiBase() &&
              billing.funding !== undefined &&
              !billing.access
            )
              router.push("/billing");
          })
          .catch(() => undefined);
      }
      setBots((current) => retainInboxValue(current, navigation.current.bots));
      setBotSections((current) => retainInboxValue(current, navigation.current.botSections));
      setGroups((current) => retainInboxValue(current, navigation.current.groups));
      setSpaces((current) => retainInboxValue(current, navigation.spaces));
      setMe((current) => retainInboxValue(current, nextMe));
      inboxLoaded.current = true;
      setBadgeLoad({ generation: badgeGeneration });
      setLoadFailure(null);
      saveInbox(
        {
          apiBase,
          userId: nextMe.userId,
          spaceId: navigation.current.id,
          sessionGeneration: generation,
          selectionId: selectedSpaceId(),
        },
        navigation,
        nextMe,
      );
      return true;
    } catch (err) {
      if (
        requestId !== inboxRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      setLoadFailure({
        kind: loadFailureKind(err),
        message: errorText(err, t("Could not load bots")),
      });
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(err);
    } finally {
      if (requestId === inboxRequestId.current) setInboxLoading(false);
    }
  }, []);

  const refreshBots = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadBots();
    } finally {
      setRefreshing(false);
    }
  }, [loadBots]);

  useEffect(() => {
    void Promise.all([loadSessionToken(), loadCollapsedSections()]).then(([token, stored]) => {
      if (stored) setCollapsedSections(stored);
      setHasSession(Boolean(token));
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!hasSession) return;
    void registerPushToken().catch(() => undefined);
  }, [hasSession]);

  // Show the inbox saved on this device until the first live load replaces it.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    void loadSavedInbox().then((saved) => {
      if (cancelled || !saved || inboxLoaded.current) return;
      setBots(saved.bots);
      setBotSections(saved.botSections);
      setGroups(saved.groups);
      setSpaces(saved.spaces);
      setMe(saved.me);
    });
    return () => {
      cancelled = true;
    };
  }, [hasSession]);

  // The embedded pane is visible beside the chat, so it keeps polling even when
  // the chat route owns focus.
  useForegroundPoll(loadBots, INBOX_POLL_INTERVAL_MS, hasSession && (embedded || isFocused));

  const archivedCount = useArchivedCount(me?.spaceId, hasSession);
  const {
    unreadOverrides,
    archiving,
    updateChat,
    botAction,
    groupAction,
    createSection,
    renameSection,
    organizeFromMenu,
    editSectionFromMenu,
    deleteSection,
  } = useInboxChatActions({ loadBots, setBots, setGroups, setSpaces, botSections });

  const loadActivity = useCallback(async () => {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    if (!hasSession || !activityMode) {
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      return;
    }
    const requestId = ++activityRequestId.current;
    try {
      const next = await fetchSpaceActivity();
      if (requestId !== activityRequestId.current) return;
      setActivity(next);
    } catch (error) {
      // Keep the last good snapshot on transient RPC failures; only drop stale responses.
      if (requestId !== activityRequestId.current) return;
      // False when the server refused rather than failed: asking again only polls it.
      return isRetryableError(error);
    }
  }, [activityMode, hasSession]);

  useForegroundPoll(
    loadActivity,
    ACTIVITY_POLL_INTERVAL_MS,
    hasSession && activityMode && (embedded || isFocused),
  );

  useEffect(
    () => () => {
      activityRequestId.current += 1;
    },
    [activityMode, hasSession],
  );

  const visible = useMemo(
    () => withoutArchiving("bot", applyUnreadOverrides("bot", bots, unreadOverrides), archiving),
    [bots, unreadOverrides, archiving],
  );
  const visibleGroups = useMemo(
    () =>
      withoutArchiving("group", applyUnreadOverrides("group", groups, unreadOverrides), archiving),
    [groups, unreadOverrides, archiving],
  );
  const shownSpaces = useMemo(
    () =>
      archiving.size === 0
        ? spaces
        : spaces.map((space) => ({
            ...space,
            bots: withoutArchiving("bot", space.bots, archiving),
            groups: withoutArchiving("group", space.groups, archiving),
          })),
    [spaces, archiving],
  );
  const inboxSpaces = useMemo(
    () =>
      shownSpaces.length > 0
        ? shownSpaces.map((space) =>
            space.id === me?.spaceId
              ? { ...space, bots: visible, groups: visibleGroups, botSections }
              : space,
          )
        : me
          ? [
              {
                id: me.spaceId,
                name: t("Personal"),
                isDefault: true,
                hasContent: true,
                bots: visible,
                groups: visibleGroups,
                botSections,
              },
            ]
          : [],
    [shownSpaces, me, visible, visibleGroups, botSections, t, locale],
  );
  useEffect(() => {
    // A remounted session has no roster until its saved or live inbox arrives.
    if (me) setSearchInbox(inboxSpaces);
  }, [inboxSpaces, me]);
  const listData = useMemo((): InboxItem[] => {
    // Android pins sit above the list; iOS keeps rows with native swipe and context menus.
    const otherSpaces = shownSpaces.filter((space) => space.id !== me?.spaceId);
    const pinned: PinnedChat[] = [
      ...[...visible, ...otherSpaces.flatMap((space) => space.bots)]
        .filter((bot) => bot.pinned)
        .map((bot) => ({ kind: "bot" as const, bot })),
      ...[...visibleGroups, ...otherSpaces.flatMap((space) => space.groups)]
        .filter((group) => group.pinned)
        .map((group) => ({ kind: "group" as const, group })),
    ];
    const sidebarSpaces = inboxSpaces.map((space) => ({
      ...space,
      bots: space.bots.filter((bot) => SWIPE_ROWS || !bot.pinned),
      groups: space.groups.filter((group) => SWIPE_ROWS || !group.pinned),
    }));
    const items: InboxItem[] = spaceInboxItems(sidebarSpaces, collapsed, me?.spaceId);
    return !SWIPE_ROWS && pinned.length > 0 ? [{ type: "pinned", chats: pinned }, ...items] : items;
  }, [inboxSpaces, collapsed, me?.spaceId, shownSpaces, visible, visibleGroups, locale]);
  const badgeCount = me ? unreadChatCount(inboxSpaces) : null;
  useEffect(() => {
    if (badgeCount === null || badgeLoad === null) return;
    void syncInboxAppBadge(badgeCount, badgeLoad.generation);
  }, [badgeCount, badgeLoad]);
  const initials = accountDisplay(me ?? {}, t("You")).initial ?? "?";
  const organizeSpace = organizeTarget
    ? organizeTarget.spaceId === me?.spaceId
      ? { bots, groups, botSections }
      : spaces.find((space) => space.id === organizeTarget.spaceId)
    : undefined;
  const organizeChat = organizeTarget
    ? organizeTarget.kind === "bot"
      ? (organizeSpace?.bots.find((bot) => bot.id === organizeTarget.id) ?? organizeTarget.chat)
      : (organizeSpace?.groups.find((group) => group.id === organizeTarget.id) ??
        organizeTarget.chat)
    : null;
  const insets = useSafeAreaInsets();
  // An unfolded or tablet window keeps the inbox in a centred column.
  const windowWidth = useWindowDimensions().width;
  const { inboxWidth } = useSplitView();
  const compactRows = embedded && inboxWidth < TAGLESS_LIST_WIDTH;
  const columnInsets = readableGutters(embedded ? inboxWidth : windowWidth, {
    left: insets.left,
    right: embedded ? 0 : insets.right,
  });
  // Liquid Glass uses the native bar: glass bar items and a native menu.
  // The list beside a chat has no navigation bar of its own.
  const nativeHeader = iosAtLeast(26) && !embedded;
  const headerHeight = useHeaderHeightIfAny();
  const listRef = useRef<FlatList<InboxItem>>(null);
  const jumpSignals = useMemo(() => listData.map(inboxSignal), [listData]);
  const jumpKeys = useMemo(() => listData.map(inboxItemKey), [listData]);
  const unreadJump = useUnreadJumpPills({
    signals: jumpSignals,
    keys: jumpKeys,
    listRef,
    // The Liquid Glass header floats over the list; the older header sits above it.
    topInset: nativeHeader ? headerHeight : 0,
    bottomInset: insets.bottom,
  });
  const router = useRouter();
  const pathname = usePathname();
  const openParams = useGlobalSearchParams<{ botId?: string; groupId?: string }>();
  const selectedChatId =
    pathname === "/thread"
      ? (openParams.botId ?? null)
      : pathname === "/group-thread"
        ? (openParams.groupId ?? null)
        : null;
  // Beside the list, a chat replaces the open one instead of stacking on it.
  const openChat = useCallback(
    (href: Href) => {
      if (!embedded) router.push(href);
      else if (pathname === "/thread" || pathname === "/group-thread") router.replace(href);
      else {
        if (router.canDismiss()) router.dismissAll();
        router.push(href);
      }
    },
    [embedded, pathname, router],
  );
  const signInAgain = useCallback(async () => {
    // A rejected session cannot sign out on the server; clearing it here is what matters.
    await signOut().catch(() => undefined);
    router.replace("/sign-in");
  }, [router]);

  const chooseInboxSpace = useCallback(
    async (spaceId: string) => {
      if (spaceActionRef.current.busy) return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      setActivity({ active: [], recent: [] });
      // Close a pane in another space before selection can change its request context.
      onSelectSpace?.(spaceId);
      try {
        const refresh = async () => {
          spaceActionRef.current.recoveryId = null;
          setSpaceRecoveryId(null);
          // A space seen before opens as it was saved; polling stays off until it is painted.
          const saved = await loadSavedInbox().catch(() => null);
          if (saved?.me.spaceId === spaceId) {
            setBots(saved.bots);
            setBotSections(saved.botSections);
            setGroups(saved.groups);
            setMe(saved.me);
          }
          spaceActionRef.current.busy = false;
          await refreshBots();
          await loadActivity();
        };
        const selected =
          spaceActionRef.current.recoveryId === spaceId
            ? await retryInboxSpaceFallback(spaceId, refresh)
            : await selectInboxSpace(spaceId, refresh);
        if (!selected) throw new Error(t("Could not switch spaces"));
      } catch (err) {
        const message = errorText(err, t("Could not switch spaces"));
        setError(message);
        Alert.alert(message, t("Try again."));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, onSelectSpace, t],
  );

  const deleteInboxSpace = useCallback(
    async (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      spaceActionRef.current.busy = true;
      setSpaceBusy(true);
      inboxRequestId.current += 1;
      activityRequestId.current += 1;
      try {
        const recoveryId = await removeInboxSpace(space.id, async () => {
          spaceActionRef.current.busy = false;
          setActivity({ active: [], recent: [] });
          await refreshBots();
          await loadActivity();
        });
        if (recoveryId) {
          spaceActionRef.current.recoveryId = recoveryId;
          setSpaceRecoveryId(recoveryId);
          setError(t("Could not switch spaces"));
        }
      } catch (err) {
        Alert.alert(t("Could not delete space"), errorText(err, t("Try again.")));
      } finally {
        spaceActionRef.current.busy = false;
        setSpaceBusy(false);
      }
    },
    [refreshBots, loadActivity, t],
  );

  const confirmDeleteSpace = useCallback(
    (space: InboxSpace) => {
      if (
        !canDeleteInboxSpace(space) ||
        spaceActionRef.current.busy ||
        spaceActionRef.current.recoveryId
      )
        return;
      Alert.alert(deleteSpaceTitle(space), t("This removes the space for everyone."), [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => void deleteInboxSpace(space),
        },
      ]);
    },
    [deleteInboxSpace, t],
  );

  const createQuickBot = useCallback(async () => {
    if (creatingBotRef.current || spaceActionRef.current.busy || spaceActionRef.current.recoveryId)
      return;
    creatingBotRef.current = true;
    const askedIn = searchInboxSession();
    try {
      // Authoritative roster so a slow home fetch does not treat later bots as first.
      // A failed list is unknown — use the delayed path rather than assuming first.
      const existing = await rpc<MobileBot[]>("bots/list").catch(() => null);
      const isFirstBot = existing !== null && existing.length === 0;
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name: "New Bot", title: "", description: "" }),
        notifyOnFinish: true,
        computerMode: "team",
      });
      void refreshBots().catch(() => undefined);
      allowFocusPrompt(bot.id);
      addToSearchInbox({ kind: "bot", bot }, askedIn);
      openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      void (async () => {
        const started = await rpc("onboarding/start", { botId: bot.id })
          .then(() => true)
          .catch(() => false);
        if (!started) return;
        scheduleFocusPrompt(bot.id, isFirstBot);
      })();
    } catch (err) {
      setError(errorText(err, t("Could not create bot")));
    } finally {
      creatingBotRef.current = false;
    }
  }, [openChat, refreshBots, t]);

  const runCreateAction = useCallback(
    (action: "bot" | "group" | "space") => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      if (action === "bot") void createQuickBot();
      else if (action === "group") router.push("/new-group");
      else router.push("/new-space");
    },
    [createQuickBot, router],
  );

  useHomeHeader({
    nativeHeader,
    ready,
    hasSession,
    initials,
    activityMode,
    toggleActivityMode,
    runCreateAction,
  });

  const openBot = useCallback(
    (bot: MobileBot | SpaceBot) => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      void openMobileSpace(bot.spaceId, () =>
        openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } }),
      );
    },
    [openChat],
  );
  const openGroup = useCallback(
    (group: MobileGroup | SpaceGroup) => {
      if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
      void openMobileSpace(group.spaceId, () =>
        openChat({ pathname: "/group-thread", params: { groupId: group.id, name: group.name } }),
      );
    },
    [openChat],
  );
  const organize = useCallback(
    async (kind: "bot" | "group", chat: MobileBot | MobileGroup | SpaceBot | SpaceGroup) => {
      const requestId = ++organizeRequestId.current;
      const generation = currentSessionGeneration();
      const apiBase = currentApiBase();
      const spaceId = chat.spaceId ?? me?.spaceId;
      let space =
        spaceId === me?.spaceId
          ? { bots, groups, botSections }
          : spaces.find((space) => space.id === spaceId);
      let target = (kind === "bot" ? space?.bots : space?.groups)?.find(
        (item) => item.id === chat.id,
      );
      if (!target && spaceId) {
        try {
          // Independent of inbox polling: only a newer organize press supersedes this request.
          const context = await captureApiRequestContext();
          const navigation = await rpc<MobileSpaceNavigation>("spaces/list", undefined, {
            requestContext: {
              ...context,
              headers: { ...context.headers, "x-rakazo-space-id": spaceId },
            },
            skipSpaceAuthRecovery: true,
          });
          if (navigation.current.id !== spaceId) return;
          space = navigation.current;
          target = (kind === "bot" ? space.bots : space.groups).find((item) => item.id === chat.id);
        } catch (err) {
          if (
            requestId === organizeRequestId.current &&
            generation === currentSessionGeneration() &&
            apiBase === currentApiBase()
          ) {
            Alert.alert(t("Could not load bots"), errorText(err, t("Try again.")));
          }
          return;
        }
      }
      if (
        !space ||
        !target ||
        requestId !== organizeRequestId.current ||
        generation !== currentSessionGeneration() ||
        apiBase !== currentApiBase()
      )
        return;
      setOrganizeTarget({ kind, id: chat.id, spaceId, chat: target, sections: space.botSections });
      void loadBots();
    },
    [bots, groups, botSections, spaces, me?.spaceId, loadBots, t],
  );
  const organizeBot = useCallback(
    (bot: MobileBot | SpaceBot) => {
      void organize("bot", bot);
    },
    [organize],
  );
  const organizeGroup = useCallback(
    (group: MobileGroup | SpaceGroup) => {
      void organize("group", group);
    },
    [organize],
  );

  const [avatarViewport] = useState(createAvatarViewport);
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) =>
    avatarViewport.update(viewableItems.map((token) => token.key)),
  ).current;
  const renderItem = useCallback(
    ({ item }: { item: InboxItem }) =>
      item.type === "pinned" ? (
        // The pinned tiles' avatars freeze with their row when it scrolls away.
        <AvatarRow id={inboxItemKey(item)}>
          <PinnedTiles
            chats={item.chats}
            onOpenBot={openBot}
            onOpenGroup={openGroup}
            onLongPressBot={organizeBot}
            onLongPressGroup={organizeGroup}
            onBotAction={botAction}
            onGroupAction={groupAction}
          />
        </AvatarRow>
      ) : item.type === "heading" ? (
        item.space ? (
          <View style={styles.spaceHeading}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              accessibilityState={{
                selected: item.space.id === me?.spaceId,
                disabled: spaceBusy,
              }}
              disabled={spaceBusy}
              onPress={() => {
                if (item.space) void chooseInboxSpace(item.space.id);
              }}
              style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
            >
              <Text style={styles.spaceTitle}>{item.title}</Text>
            </Pressable>
            <MenuView
              actions={[
                { id: "settings", title: t("Settings"), image: "gearshape" },
                ...(canDeleteInboxSpace(item.space)
                  ? [
                      {
                        id: "delete",
                        title: t("Delete space"),
                        image: "trash" as const,
                        attributes: {
                          destructive: true,
                          disabled: spaceBusy || !!spaceRecoveryId,
                        },
                      },
                    ]
                  : []),
              ]}
              colorScheme={appearance}
              onPressAction={({ nativeEvent }) => {
                if (!item.space) return;
                if (nativeEvent.event === "delete") confirmDeleteSpace(item.space);
                else
                  router.push({
                    pathname: "/space",
                    params: { spaceId: item.space.id, name: item.space.name },
                  });
              }}
            >
              <View
                accessibilityLabel={t("Space actions for {name}", { name: item.title })}
                accessibilityRole="button"
                style={styles.spaceActions}
              >
                <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
              </View>
            </MenuView>
          </View>
        ) : (
          <View style={styles.sectionHeadingRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                item.collapsed
                  ? t("Expand {name}", { name: item.title })
                  : t("Collapse {name}", { name: item.title })
              }
              accessibilityState={{ expanded: !item.collapsed }}
              accessibilityValue={item.collapsed ? { text: String(item.count ?? 0) } : undefined}
              onPress={() => toggleCollapsed(item.key)}
              style={({ pressed }) => [styles.sectionToggle, pressed && styles.rowPressed]}
            >
              <Text style={styles.sectionTitle}>{item.title}</Text>
              {item.collapsed ? <Text style={styles.sectionCount}>{item.count ?? 0}</Text> : null}
              <SectionChevron collapsed={item.collapsed === true} />
            </Pressable>
            {item.sectionId && Platform.OS === "android" ? (
              // A plain button, like the create control: the Android menu trigger can collapse to
              // zero width on an older binary, which would hide the only way to delete an empty section.
              <Pressable
                accessibilityLabel={t("Delete section")}
                accessibilityRole="button"
                onPress={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
                style={styles.spaceActions}
              >
                <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
              </Pressable>
            ) : item.sectionId ? (
              <MenuView
                actions={[
                  {
                    id: "delete",
                    title: t("Delete section"),
                    image: "trash",
                    attributes: { destructive: true },
                  },
                ]}
                colorScheme={appearance}
                onPressAction={() => {
                  if (item.sectionId) deleteSection({ id: item.sectionId, name: item.title });
                }}
              >
                <View
                  accessibilityLabel={t("Section actions for {name}", { name: item.title })}
                  accessibilityRole="button"
                  style={styles.spaceActions}
                >
                  <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                </View>
              </MenuView>
            ) : null}
          </View>
        )
      ) : item.type === "group" ? (
        <GroupRow
          group={item.group}
          day={day}
          onPress={openGroup}
          onLongPress={!SWIPE_ROWS ? organizeGroup : undefined}
          onAction={SWIPE_ROWS && item.group.spaceId === me?.spaceId ? groupAction : undefined}
          sections={botSections}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
        />
      ) : (
        <BotRow
          bot={item.bot}
          day={day}
          onPress={openBot}
          onLongPress={!SWIPE_ROWS ? organizeBot : undefined}
          onAction={SWIPE_ROWS && item.bot.spaceId === me?.spaceId ? botAction : undefined}
          sections={botSections}
          onOrganize={organizeFromMenu}
          onEditSection={editSectionFromMenu}
        />
      ),
    [
      appearance,
      botAction,
      botSections,
      chooseInboxSpace,
      confirmDeleteSpace,
      deleteSection,
      day,
      editSectionFromMenu,
      groupAction,
      me?.spaceId,
      openBot,
      openGroup,
      organizeBot,
      organizeFromMenu,
      organizeGroup,
      router,
      spaceBusy,
      spaceRecoveryId,
      styles,
      t,
      toggleCollapsed,
    ],
  );

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;
  // With nothing to show, the failure takes the screen; over saved chats it stays one line.
  // Headings of empty saved Spaces are not chats, so they do not hide the failure.
  const showLoadFailure = Boolean(loadFailure) && inboxHasNoChats(listData);
  const inlineError = error ?? (showLoadFailure ? null : (loadFailure?.message ?? null));

  return (
    <View style={styles.screen}>
      {nativeHeader ? null : (
        <InboxHeader
          initials={initials}
          activityMode={activityMode}
          toggleActivityMode={toggleActivityMode}
          runCreateAction={runCreateAction}
          columnInsets={columnInsets}
        />
      )}

      <SelectedChatContext.Provider value={embedded ? selectedChatId : null}>
        <CompactRowsContext.Provider value={compactRows}>
          <View style={styles.listArea}>
            <AvatarViewportScope viewport={avatarViewport}>
              <FlatList<InboxItem>
                ref={listRef}
                {...unreadJump.listProps}
                style={{ flex: 1 }}
                // Rows scrolled out of view freeze their avatars until they come back.
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={AVATAR_VIEWABILITY}
                data={showLoadFailure ? [] : listData}
                keyExtractor={inboxItemKey}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                indicatorStyle={appearance === "dark" ? "white" : "black"}
                contentContainerStyle={[
                  styles.list,
                  { paddingLeft: columnInsets.left, paddingRight: columnInsets.right },
                ]}
                contentInsetAdjustmentBehavior="automatic"
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={() => {
                      void refreshBots();
                      void loadActivity();
                    }}
                    tintColor={native.secondaryLabel}
                    colors={[tokens.mutedForeground]}
                    progressBackgroundColor={tokens.muted}
                  />
                }
                ListHeaderComponent={
                  <>
                    {inlineError ? <Text style={styles.error}>{inlineError}</Text> : null}
                    {spaceRecoveryId ? (
                      <Pressable
                        accessibilityRole="button"
                        disabled={spaceBusy}
                        onPress={() => void chooseInboxSpace(spaceRecoveryId)}
                        style={styles.recoveryAction}
                      >
                        <Text style={styles.spaceTitle}>{t("Try again.")}</Text>
                      </Pressable>
                    ) : null}
                    {activityMode && (activity.active.length > 0 || activity.recent.length > 0) ? (
                      <ActivitySection activity={activity} bots={bots} />
                    ) : null}
                  </>
                }
                ListEmptyComponent={
                  showLoadFailure && loadFailure ? (
                    <HomeErrorState
                      kind={loadFailure.kind}
                      message={loadFailure.message}
                      loading={inboxLoading && !refreshing}
                      onRetry={() => void refreshBots()}
                      onSignIn={() => void signInAgain()}
                    />
                  ) : (
                    <Text style={styles.empty}>{me ? t("Tap + to create a bot") : null}</Text>
                  )
                }
                ListFooterComponent={
                  <>
                    {!showLoadFailure && inboxNeedsCreateHint(listData) ? (
                      <Text style={styles.empty}>{t("Tap + to create a bot")}</Text>
                    ) : null}
                    <ArchivedChatsRow
                      count={archivedCount}
                      onPress={() => router.push("/archived-bots")}
                    />
                  </>
                }
                renderItem={renderItem}
              />
            </AvatarViewportScope>
            {refreshing || showLoadFailure || inboxHasNoChats(listData) ? null : unreadJump.overlay}
          </View>
        </CompactRowsContext.Provider>
      </SelectedChatContext.Provider>
      {organizeChat && organizeTarget ? (
        <BotOrganizeModal
          bot={organizeChat}
          sections={organizeSpace?.botSections ?? organizeTarget.sections}
          onClose={() => {
            organizeRequestId.current += 1;
            setOrganizeTarget(null);
          }}
          onUpdate={(update) => updateChat(organizeTarget.kind, organizeChat, update)}
          onCreateSection={(name) =>
            createSection(organizeTarget.kind, organizeChat.id, name, organizeTarget.spaceId)
          }
          onRenameSection={(sectionId, name) =>
            renameSection(sectionId, name, organizeTarget.spaceId)
          }
          onDeleteSection={async (sectionId) => {
            await chatRpc(organizeTarget.spaceId, "botSections/remove", { sectionId });
            await loadBots();
          }}
        />
      ) : null}
    </View>
  );
}
