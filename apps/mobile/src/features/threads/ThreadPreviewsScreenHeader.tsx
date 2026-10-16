import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  previewOpenFailureMessage,
  previewPortLabel,
} from "@t3tools/client-runtime/state/signalboxPreviews";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SignalboxPreviewPort } from "@t3tools/contracts/signalboxPreviews";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useRef } from "react";
import { Alert, Keyboard, Platform } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import { signalboxPreviews, useThreadPreviews } from "../../state/signalboxPreviews";
import { useAtomCommand } from "../../state/use-atom-command";

const previewTitle = (port: SignalboxPreviewPort) =>
  `Open ${port.processName ?? "the dev server"} on port ${port.port}`;

/** Mints a fresh link and opens it in the in-app browser, where HMR keeps working. */
function useOpenThreadPreview(environmentId: EnvironmentId, threadId: ThreadId) {
  const open = useAtomCommand(signalboxPreviews.open, { reportFailure: false });
  const opening = useRef(false);
  return useCallback(
    (port: number) => {
      if (opening.current) return;
      opening.current = true;
      const fail = (error: unknown) =>
        Alert.alert(`Couldn't open preview :${port}`, previewOpenFailureMessage(error));
      void open({ environmentId, input: { threadId, port } })
        .then(async (result) => {
          if (isAtomCommandInterrupted(result)) return;
          if (result._tag === "Failure") return fail(squashAtomCommandFailure(result));
          await WebBrowser.openBrowserAsync(result.value.url);
        })
        .catch(fail)
        .finally(() => {
          opening.current = false;
        });
    },
    [environmentId, open, threadId],
  );
}

/** The thread whose previews the header offers. */
interface ThreadPreviewsTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const AGENT_BROWSER_LABEL = "Agent's browser";
const AGENT_BROWSER_ICON = { ios: "macwindow", android: "desktop_windows" } as const;

/**
 * The thread screen's header plus its running dev servers and the agent's
 * browser, shown only when the thread's Signalbox Cloud machine serves one or
 * the agent has browsed: one entry opens directly, several open a menu. iOS
 * gets a native header item beside the git controls; Android gets a header
 * action or menu. The agent's browser opens only when asked.
 */
export function ThreadPreviewsScreenHeader({
  environmentId,
  threadId,
  ...props
}: AppBarProps & Partial<ThreadPreviewsTarget>) {
  // Without a thread (e.g. a header rendered on its own) there's nothing to preview.
  if (environmentId === undefined || threadId === undefined) return <AppBar {...props} />;
  return <PreviewsHeader {...props} environmentId={environmentId} threadId={threadId} />;
}

function PreviewsHeader({ environmentId, threadId, ...props }: AppBarProps & ThreadPreviewsTarget) {
  const navigation = useNavigation();
  const { ports, browsed } = useThreadPreviews(environmentId, threadId);
  const canOpen = useAtomValue(signalboxPreviews.open.permissionAtom(environmentId));
  const openPreview = useOpenThreadPreview(environmentId, threadId);
  const openAgentBrowser = useCallback(() => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAgentBrowser", { environmentId, threadId });
  }, [environmentId, navigation, threadId]);
  const offered = canOpen ? ports : [];
  const [first] = offered;
  if (first === undefined && !browsed) return <AppBar {...props} />;
  // One entry opens directly; the agent's browser alone, or one preview alone.
  const single =
    first === undefined
      ? {
          label: AGENT_BROWSER_LABEL,
          accessibilityLabel: "Watch the agent's browser",
          onPress: openAgentBrowser,
        }
      : offered.length === 1 && !browsed
        ? {
            label: `Preview ${previewPortLabel(first)}`,
            accessibilityLabel: previewTitle(first),
            onPress: () => openPreview(first.port),
          }
        : null;
  const browserOnly = first === undefined;

  if (Platform.OS === "ios") {
    const item =
      single !== null
        ? {
            accessibilityLabel: single.accessibilityLabel,
            icon: { name: browserOnly ? AGENT_BROWSER_ICON.ios : "globe", type: "sfSymbol" },
            identifier: "thread-right-previews",
            label: single.label,
            onPress: single.onPress,
            sharesBackground: true,
            type: "button",
            variant: "plain",
          }
        : {
            accessibilityLabel: browsed
              ? `The agent's browser and ${offered.length} ${offered.length === 1 ? "preview" : "previews"}`
              : `${offered.length} previews running`,
            icon: { name: "globe", type: "sfSymbol" },
            identifier: "thread-right-previews",
            label: "Previews",
            menu: {
              items: [
                ...(browsed
                  ? [
                      {
                        icon: { name: AGENT_BROWSER_ICON.ios, type: "sfSymbol" },
                        label: AGENT_BROWSER_LABEL,
                        onPress: openAgentBrowser,
                        type: "action",
                      },
                    ]
                  : []),
                ...offered.map((port) => ({
                  description: port.processName ?? undefined,
                  label: previewPortLabel(port),
                  onPress: () => openPreview(port.port),
                  type: "action",
                })),
              ],
              title: "Open a preview",
            },
            sharesBackground: true,
            type: "menu",
            variant: "plain",
          };
    const rightItems = props.options?.unstable_headerRightItems;
    return (
      <AppBar
        {...props}
        options={{
          ...props.options,
          unstable_headerRightItems: () => [
            ...(typeof rightItems === "function" ? (rightItems() as unknown[]) : []),
            item,
          ],
        }}
        // Header factories are stabilized by source, so the entries themselves must reapply them.
        optionsVersion={[props.optionsVersion, offered, browsed]}
      />
    );
  }

  return single !== null ? (
    <AppBar
      {...props}
      actions={[
        ...(props.actions ?? []),
        {
          accessibilityLabel: single.accessibilityLabel,
          icon: browserOnly ? AGENT_BROWSER_ICON : "globe",
          onPress: single.onPress,
        },
      ]}
    />
  ) : (
    <AppBar
      {...props}
      menus={[
        ...(props.menus ?? []),
        {
          title: "Previews",
          icon: "globe",
          items: [
            ...(browsed
              ? [{ id: "agent-browser", title: AGENT_BROWSER_LABEL, onPress: openAgentBrowser }]
              : []),
            ...offered.map((port) => ({
              id: `preview-${port.port}`,
              title: previewPortLabel(port),
              ...(port.processName ? { subtitle: port.processName } : {}),
              onPress: () => openPreview(port.port),
            })),
          ],
        },
      ]}
    />
  );
}
