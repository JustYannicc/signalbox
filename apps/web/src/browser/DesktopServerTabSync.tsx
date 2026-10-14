"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { usePreviewSession } from "~/components/preview/usePreviewSession";
import {
  applyPreviewServerEvent,
  clearThreadPreviewState,
  readThreadPreviewState,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

/**
 * Syncs every thread with a tab on this desktop's own server, not only the
 * threads on screen. The server drives such a tab through the `<webview>`
 * ElectronBrowserHost mounts for it, so the agent acts in the page and logins
 * the person sees. Without the webview it falls back to a headless browser.
 */
export function DesktopServerTabSync() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const previewByThreadKey = useActivePreviewSessions();

  // A thread nobody has open learns of its first server tab here; once it has
  // a session, its own sync below keeps it current.
  useEffect(() => {
    if (environmentId === null) return;
    return appAtomRegistry.subscribe(
      previewEnvironment.events({ environmentId, input: {} }),
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        const event = result.value;
        if (event.type !== "opened" && event.type !== "navigated" && event.type !== "resized") {
          return;
        }
        if (event.snapshot.runtime !== "server") return;
        const threadRef = { environmentId, threadId: ThreadId.make(event.threadId) };
        const current = readThreadPreviewState(threadRef);
        if (Object.keys(current.sessions).length > 0) return;
        // State left from an earlier server process would refuse this event.
        if (current.serverEpoch !== event.serverEpoch) clearThreadPreviewState(threadRef);
        applyPreviewServerEvent(threadRef, event);
      },
    );
  }, [environmentId]);

  const threadIds = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, state]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef?.environmentId === environmentId &&
          Object.values(state.sessions).some((snapshot) => snapshot.runtime === "server")
          ? [threadRef.threadId]
          : [];
      }),
    [environmentId, previewByThreadKey],
  );

  if (environmentId === null) return null;
  return threadIds.map((threadId) => (
    <ThreadServerTabSync key={threadId} environmentId={environmentId} threadId={threadId} />
  ));
}

function ThreadServerTabSync(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const threadRef = useMemo<ScopedThreadRef>(
    () => ({ environmentId, threadId }),
    [environmentId, threadId],
  );
  usePreviewSession(threadRef);
  return null;
}
