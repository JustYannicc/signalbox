import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mergeAgentBrowserSteps } from "@t3tools/client-runtime/state/signalboxAgentBrowser";
import {
  agentBrowserFrame,
  agentBrowserMirrorContent,
  agentBrowserPlaceLabel,
  agentBrowserStatus,
} from "@t3tools/client-runtime/state/signalboxAgentBrowserFrame";
import { createAgentBrowserInputSender } from "@t3tools/client-runtime/state/signalboxAgentBrowserMirror";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentBrowserInput, AgentBrowserTab } from "@t3tools/contracts/signalboxPreviews";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import { AppText } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { Toolbar } from "../../components/ui/Toolbar";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { signalboxAgentBrowser, useAgentBrowserTrail } from "../../state/signalboxAgentBrowser";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { agentBrowserMirrorPageUrl } from "./agentBrowserMirrorBridge";
import { AgentBrowserHandoffNotice } from "./AgentBrowserHandoffNotice";
import { AgentBrowserMirrorWebView } from "./AgentBrowserMirrorWebView";
import { AgentBrowserStatusBar } from "./AgentBrowserStatusBar";
import { AgentBrowserTrailList } from "./AgentBrowserTrailList";
import { useAgentBrowserLease } from "./useAgentBrowserLease";

const AgentBrowserStack = createNativeStackNavigator<{ AgentBrowser: undefined }>();

type AgentBrowserRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** The agent's browser for one Signalbox Cloud thread, as a full-screen modal. */
export function AgentBrowserRouteScreen({ route }: AgentBrowserRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AgentBrowserStack.Navigator
        screenOptions={{
          headerShown: Platform.OS === "ios",
          headerBackVisible: false,
          headerShadowVisible: false,
          headerTransparent: false,
          headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        }}
      >
        <AgentBrowserStack.Screen name="AgentBrowser">
          {() => (
            <AgentBrowserScreen
              environmentId={EnvironmentId.make(route.params.environmentId)}
              threadId={ThreadId.make(route.params.threadId)}
              onClose={onClose}
            />
          )}
        </AgentBrowserStack.Screen>
      </AgentBrowserStack.Navigator>
    </View>
  );
}

const tabLabel = (tab: AgentBrowserTab) => agentBrowserPlaceLabel(tab.title, tab.url, "New tab");

/**
 * The agent's tabs mirrored live, who drives, take over and hand back, and the
 * trail of steps. Watches only while this screen shows, the app is active, and
 * the person is around.
 */
function AgentBrowserScreen({
  environmentId,
  threadId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const trail = useAgentBrowserTrail(environmentId, threadId);
  const { watching, noteActivity } = useAgentBrowserLease(focused && trail.supported);
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const canDrive = useAtomValue(signalboxAgentBrowser.input.permissionAtom(environmentId));
  const sendInput = useAtomCommand(signalboxAgentBrowser.input, { reportFailure: false });
  const connection = usePreparedConnection(environmentId);
  const pageUrl = agentBrowserMirrorPageUrl(
    Option.isSome(connection) ? connection.value.httpBaseUrl : null,
  );

  const watch = useEnvironmentQuery(
    watching
      ? signalboxAgentBrowser.watch({ environmentId, input: { threadId, tabId: pinnedTabId } })
      : null,
  );
  const view = watch.data;
  // A watch that failed (the cloud cuts a view that fell behind) opens again
  // on the person's next touch, not in a loop on its own.
  const { error: watchError, refresh: refreshWatch } = watch;
  const onActivity = useCallback(() => {
    noteActivity();
    if (watchError !== null) refreshWatch();
  }, [noteActivity, refreshWatch, watchError]);

  // A pinned tab the agent closed: follow the agent again.
  if (
    pinnedTabId !== null &&
    view !== null &&
    !view.offline &&
    !view.tabs.some((tab) => tab.tabId === pinnedTabId)
  ) {
    setPinnedTabId(null);
  }

  const steps = useMemo(
    () => mergeAgentBrowserSteps(trail.steps, view?.steps ?? []),
    [trail.steps, view?.steps],
  );
  // Steps that landed while watching live only in the stream, which pausing
  // drops; read the stored trail once then, and only if it lacks some.
  const unstored = steps.length > (trail.steps?.length ?? 0);
  const unstoredWhileWatchingRef = useRef(false);
  const { refresh: refreshTrail } = trail;
  useEffect(() => {
    if (watching) {
      unstoredWhileWatchingRef.current = unstored;
    } else if (unstoredWhileWatchingRef.current) {
      unstoredWhileWatchingRef.current = false;
      refreshTrail();
    }
  }, [refreshTrail, unstored, watching]);
  const lastStepId = steps.at(-1)?.stepId ?? null;
  const frame = agentBrowserFrame({ view, selectedStepId, lastStepId });
  const recording = useEnvironmentQuery(
    frame.kind === "step"
      ? signalboxAgentBrowser.step({ environmentId, input: { threadId, stepId: frame.stepId } })
      : null,
  );
  const content = agentBrowserMirrorContent(frame, recording.data);

  const live = view !== null && !view.offline && view.tabId !== null;
  const viewerId = view?.viewerId ?? null;
  const driving = live && view.control === "you";
  const interactive = driving && watching && selectedStepId === null;

  const send = useCallback(
    (input: AgentBrowserInput) => {
      if (viewerId === null) return Promise.resolve(null);
      return sendInput({ environmentId, input: { threadId, viewerId, input } });
    },
    [environmentId, sendInput, threadId, viewerId],
  );
  const onInput = useMemo(() => createAgentBrowserInputSender(send), [send]);
  const changeControl = (input: AgentBrowserInput) => {
    void send(input).then((result) => {
      if (result === null || isAtomCommandInterrupted(result) || result._tag === "Success") return;
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        input._tag === "take" ? "Couldn't take over" : "Couldn't hand back",
        error instanceof Error && error.message.trim().length > 0 ? error.message : "Try again.",
      );
    });
  };

  const status = agentBrowserStatus({
    view,
    watching,
    error: watch.error,
    hasSteps: lastStepId !== null,
  });
  const selectedIndex =
    selectedStepId === null ? -1 : steps.findIndex((step) => step.stepId === selectedStepId);
  const shownStepId = frame.kind === "step" ? frame.stepId : null;
  const shownTab = live ? view.tabs.find((tab) => tab.tabId === view.tabId) : undefined;

  const tabsMenu: ReadonlyArray<AppBarMenu> =
    live && view.tabs.length > 0
      ? [
          {
            title: "Tabs",
            icon: "square.on.square",
            items: [
              {
                id: "follow-agent",
                title: "Follow the agent",
                selected: pinnedTabId === null,
                onPress: () => setPinnedTabId(null),
              },
              {
                id: "tabs",
                inline: true,
                items: view.tabs.map((tab) => ({
                  id: tab.tabId,
                  title: tabLabel(tab),
                  subtitle: `${tab.browser === "person" ? "Your cloud browser" : "The machine's browser"} · ${tab.url}`,
                  selected: pinnedTabId === tab.tabId,
                  onPress: () => setPinnedTabId(tab.tabId),
                })),
              },
            ],
          },
        ]
      : [];

  const header = (
    <>
      <AppBar
        title="Agent's browser"
        subtitle={shownTab ? tabLabel(shownTab) : undefined}
        sidebar={false}
        onBack={onClose}
        options={{ headerBackVisible: false }}
        menus={tabsMenu}
      />
      {Platform.OS === "ios" ? (
        <Toolbar placement="left">
          <Toolbar.Button
            icon="xmark"
            accessibilityLabel="Close the agent's browser"
            onPress={onClose}
            separateBackground
          />
        </Toolbar>
      ) : null}
    </>
  );

  if (!trail.supported) {
    return (
      <View className="flex-1 bg-sheet" style={{ paddingBottom: insets.bottom }}>
        {header}
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="Agent's browser"
            detail="Follow the agent's browser in threads that run in Signalbox Cloud."
          />
        </View>
      </View>
    );
  }

  const blankReason =
    frame.kind === "blank"
      ? frame.reason
      : frame.kind === "step" && recording.error !== null
        ? recording.error
        : pageUrl === null
          ? "Reconnect to the environment to see the agent's browser."
          : null;

  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingBottom: insets.bottom }}
      // Touches outside the mirror count as being around; the page reports its own.
      onTouchStart={onActivity}
    >
      {header}

      <AgentBrowserStatusBar
        step={selectedIndex >= 0 ? { index: selectedIndex, count: steps.length } : null}
        control={view?.control ?? null}
        controlLabel={status.control}
        detail={status.detail}
        action={
          selectedStepId !== null
            ? { kind: "live", onPress: () => setSelectedStepId(null) }
            : !live || !canDrive
              ? null
              : driving
                ? { kind: "hand-back", onPress: () => changeControl({ _tag: "release" }) }
                : {
                    kind: "take",
                    disabled: view.control === "someone-else",
                    onPress: () => changeControl({ _tag: "take" }),
                  }
        }
      />

      {live && view.handoff !== null && selectedStepId === null ? (
        <AgentBrowserHandoffNotice
          environmentId={environmentId}
          site={view.handoff.site}
          runId={view.handoff.runId}
          ownBrowserUrl={view.handoff.ownBrowserUrl}
        />
      ) : null}

      {/* Kernel's own words, also when it refused to open a tab at all. */}
      {view !== null && !view.offline && view.problem !== null ? (
        <View className="border-b border-border-subtle p-2">
          <Notice message={view.problem} icon="exclamationmark.triangle" />
        </View>
      ) : null}

      <View className="relative min-h-0 flex-1 bg-subtle">
        {pageUrl !== null ? (
          <AgentBrowserMirrorWebView
            pageUrl={pageUrl}
            content={content}
            interactive={interactive}
            background={themeVariables["--color-subtle"]}
            onInput={onInput}
            onActivity={onActivity}
          />
        ) : null}
        {blankReason !== null ? (
          <View className="absolute inset-0 items-center justify-center bg-sheet px-8">
            <AppText selectable textRole="footnote" className="text-center text-foreground-muted">
              {blankReason}
            </AppText>
          </View>
        ) : null}
      </View>

      {steps.length > 0 ? (
        <AgentBrowserTrailList
          steps={steps}
          shownStepId={shownStepId}
          onSelect={setSelectedStepId}
        />
      ) : null}
    </View>
  );
}
