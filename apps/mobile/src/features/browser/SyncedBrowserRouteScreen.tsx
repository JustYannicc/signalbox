import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { browsingTabHost, browsingTabLabel } from "@t3tools/client-runtime/browsing";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { BrowsingTab } from "@t3tools/contracts/signalboxBrowsing";
import { useCallback, useEffect, useState } from "react";
import { AppState, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar, type AppBarMenuItem } from "../../components/ui/AppBar";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { useBrowsingDispatch, useThreadBrowsing } from "../../state/browsing";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { uuidv4 } from "../../lib/uuid";
import {
  browsingTabEngine,
  browsingTabSubtitle,
  shownBrowsingTab,
  type PendingActivation,
} from "./syncedBrowsing";
import { SyncedBrowserTab } from "./SyncedBrowserTab";
import { opensInSystemBrowser } from "./systemBrowser";

type SyncedBrowserRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/**
 * A thread's synced tabs (#585), loaded in this device's own WebView. Pushed
 * like the terminal, so its header is the workspace stack's own.
 */
export function SyncedBrowserRouteScreen({ route }: SyncedBrowserRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <SyncedBrowserScreen
      environmentId={EnvironmentId.make(route.params.environmentId)}
      threadId={ThreadId.make(route.params.threadId)}
      onClose={onClose}
    />
  );
}

function SyncedBrowserScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, onClose } = props;
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state !== "background"),
    );
    return () => subscription.remove();
  }, []);
  const browsing = useThreadBrowsing(environmentId, threadId);
  const act = useBrowsingDispatch(environmentId, threadId, "action");
  const report = useBrowsingDispatch(environmentId, threadId, "report");
  const [pending, setPending] = useState<PendingActivation | null>(null);
  const state = browsing.data;
  const record = state?.record ?? null;
  const tab = record === null ? null : shownBrowsingTab(record, pending);
  const you = state?.you ?? null;
  const engine = tab === null ? null : browsingTabEngine(tab, you);

  const run = (command: Parameters<typeof act>[0], failure: string) =>
    act(command).then((result) => {
      if (result._tag === "Success") return true;
      setPending(null);
      Dialog.alert(failure);
      return false;
    });
  const select = (tabId: string) => {
    if (record === null || tabId === tab?.id) return;
    setPending({ tabId, sinceActiveTabId: record.activeTabId });
    void run({ _tag: "Activate", tabId }, "Could not switch tabs");
  };
  const openTab = () => {
    // Minted here so a retried open lands once; devices never pick the same id.
    const tabId = `tab_${uuidv4()}`;
    setPending({ tabId, sinceActiveTabId: record?.activeTabId ?? null });
    void run(
      { _tag: "Open", tabId, activate: true, ...(tab ? { afterTabId: tab.id } : {}) },
      "Could not open a new tab",
    );
  };
  const closeTab = (closing: BrowsingTab) =>
    void run({ _tag: "Close", tabId: closing.id }, "Could not close this tab");

  const tabs = record?.tabs ?? [];
  const tabItems: AppBarMenuItem[] = tabs.map((entry) => {
    const subtitle = browsingTabSubtitle(entry, you);
    return {
      id: entry.id,
      title: browsingTabLabel(entry),
      ...(subtitle === undefined ? {} : { subtitle }),
      selected: entry.id === tab?.id,
      onPress: () => select(entry.id),
    };
  });
  const tabActions: AppBarMenuItem[] = [
    { id: "new-tab", title: "New tab", icon: "plus", onPress: openTab },
    // Only the owner drives a tab, closing included.
    ...(tab && engine === "here"
      ? [{ id: "close-tab", title: "Close this tab", icon: "xmark", onPress: () => closeTab(tab) }]
      : []),
  ];

  return (
    <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title={tab ? browsingTabLabel(tab) : "Browser"}
        sidebar={false}
        onBack={onClose}
        menus={
          record === null
            ? []
            : [
                {
                  title: "Tabs",
                  icon: "square.on.square",
                  items: [
                    // An inline group needs a title; without one it shows its items' text run together.
                    ...(tabItems.length > 0
                      ? [{ id: "tabs", title: "Open tabs", inline: true, items: tabItems }]
                      : []),
                    ...tabActions,
                  ],
                },
              ]
        }
      />
      {tab !== null && engine !== "here" ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title={
              engine === "agent"
                ? "This tab is open in an agent's browser"
                : "This tab is open in someone else's browser"
            }
            detail={
              engine === "agent"
                ? "The agent drives it from the cloud. Your own tabs open here."
                : "Only the person who opened it can use it. Your own tabs open here."
            }
          />
        </View>
      ) : tab !== null && tab.url !== null && opensInSystemBrowser(tab.url) ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="This page opens in the browser view"
            detail="Google only signs you in there. 1Password fills it in with one tap, once on this phone."
            actionLabel={`Open ${browsingTabHost(tab.url) ?? "page"}`}
            onAction={() => void WebBrowser.openBrowserAsync(tab.url ?? "")}
          />
        </View>
      ) : tab !== null && state !== null ? (
        <SyncedBrowserTab
          key={tab.id}
          environmentId={environmentId}
          threadId={threadId}
          tab={tab}
          you={state.you}
          live={focused && foreground}
          background={themeVariables["--color-sheet-solid"]}
          report={report}
        />
      ) : record !== null ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="No tabs open"
            detail="Tabs opened in this thread on any of your devices show up here."
            actionLabel="New tab"
            onAction={openTab}
          />
        </View>
      ) : !browsing.supported ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="Synced tabs aren't available here"
            detail="This thread's environment doesn't keep browser tabs."
          />
        </View>
      ) : browsing.error !== null ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="Couldn't load this thread's tabs"
            detail={browsing.error}
            actionLabel="Try again"
            onAction={browsing.refresh}
          />
        </View>
      ) : (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
        </View>
      )}
    </View>
  );
}
