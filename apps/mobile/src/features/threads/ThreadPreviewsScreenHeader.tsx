import { useAtomValue } from "@effect/atom-react";
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
import { Alert, Platform } from "react-native";

import { ScreenHeader } from "../../components/ScreenHeader";
import type { ScreenHeaderProps } from "../../components/ScreenHeader.types";
import { signalboxPreviews, useThreadPreviewPorts } from "../../state/signalboxPreviews";
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

/**
 * The thread screen's header plus its running dev servers, shown only when the
 * thread's Signalbox Cloud machine serves one: one port opens directly,
 * several open a menu. iOS gets a native header item beside the git controls;
 * Android gets a header action or menu.
 */
export function ThreadPreviewsScreenHeader({
  environmentId,
  threadId,
  ...props
}: ScreenHeaderProps & Partial<ThreadPreviewsTarget>) {
  // Without a thread (e.g. a header rendered on its own) there's nothing to preview.
  if (environmentId === undefined || threadId === undefined) return <ScreenHeader {...props} />;
  return <PreviewsHeader {...props} environmentId={environmentId} threadId={threadId} />;
}

function PreviewsHeader({
  environmentId,
  threadId,
  ...props
}: ScreenHeaderProps & ThreadPreviewsTarget) {
  const ports = useThreadPreviewPorts(environmentId, threadId);
  const canOpen = useAtomValue(signalboxPreviews.open.permissionAtom(environmentId));
  const openPreview = useOpenThreadPreview(environmentId, threadId);
  const [first] = ports;
  if (first === undefined || !canOpen) return <ScreenHeader {...props} />;

  if (Platform.OS === "ios") {
    const item =
      ports.length === 1
        ? {
            accessibilityLabel: previewTitle(first),
            icon: { name: "globe", type: "sfSymbol" },
            identifier: "thread-right-previews",
            label: `Preview ${previewPortLabel(first)}`,
            onPress: () => openPreview(first.port),
            sharesBackground: true,
            type: "button",
            variant: "plain",
          }
        : {
            accessibilityLabel: `${ports.length} previews running`,
            icon: { name: "globe", type: "sfSymbol" },
            identifier: "thread-right-previews",
            label: "Previews",
            menu: {
              items: ports.map((port) => ({
                description: port.processName ?? undefined,
                label: previewPortLabel(port),
                onPress: () => openPreview(port.port),
                type: "action",
              })),
              title: "Open a preview",
            },
            sharesBackground: true,
            type: "menu",
            variant: "plain",
          };
    const rightItems = props.options?.unstable_headerRightItems;
    return (
      <ScreenHeader
        {...props}
        options={{
          ...props.options,
          unstable_headerRightItems: () => [
            ...(typeof rightItems === "function" ? (rightItems() as unknown[]) : []),
            item,
          ],
        }}
        // Header factories are stabilized by source, so the ports themselves must reapply them.
        optionsVersion={[props.optionsVersion, ports]}
      />
    );
  }

  return ports.length === 1 ? (
    <ScreenHeader
      {...props}
      actions={[
        ...(props.actions ?? []),
        {
          accessibilityLabel: previewTitle(first),
          icon: "globe",
          onPress: () => openPreview(first.port),
        },
      ]}
    />
  ) : (
    <ScreenHeader
      {...props}
      menus={[
        ...(props.menus ?? []),
        {
          title: "Previews",
          icon: "globe",
          items: ports.map((port) => ({
            id: `preview-${port.port}`,
            title: previewPortLabel(port),
            ...(port.processName ? { subtitle: port.processName } : {}),
            onPress: () => openPreview(port.port),
          })),
        },
      ]}
    />
  );
}
