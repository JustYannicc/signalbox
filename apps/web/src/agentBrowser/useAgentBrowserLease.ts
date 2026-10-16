import { createAgentBrowserLease } from "@t3tools/client-runtime/state/signalboxAgentBrowserLease";
import { useEffect, useState } from "react";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"] as const;

const documentVisible = () => document.visibilityState === "visible";

/**
 * Whether to watch the agent's browser: while `panelVisible`, the app is in
 * front, and the person touched the app in the last five minutes. Activity
 * inside the mirror frame doesn't reach this document; pass it to `noteActivity`.
 */
export function useAgentBrowserLease(panelVisible: boolean): {
  readonly watching: boolean;
  readonly noteActivity: () => void;
} {
  const [appVisible, setAppVisible] = useState(documentVisible);
  // Opening the panel counts as activity, so it starts watching without a paused flash.
  const [watching, setWatching] = useState(() => panelVisible && documentVisible());
  const [lease] = useState(() => createAgentBrowserLease({ onChange: setWatching }));

  useEffect(() => {
    const onVisibility = () => setAppVisible(documentVisible());
    const onActivity = () => lease.noteActivity();
    document.addEventListener("visibilitychange", onVisibility);
    for (const type of ACTIVITY_EVENTS) {
      document.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    return () => {
      lease.dispose();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const type of ACTIVITY_EVENTS) {
        document.removeEventListener(type, onActivity, { capture: true });
      }
    };
  }, [lease]);

  useEffect(() => lease.update(panelVisible, appVisible), [lease, panelVisible, appVisible]);

  return { watching, noteActivity: lease.noteActivity };
}
