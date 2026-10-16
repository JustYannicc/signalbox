import { createAgentBrowserLease } from "@t3tools/client-runtime/state/signalboxAgentBrowserLease";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * Whether to watch the agent's browser: while the screen is focused, the app
 * is active, and the person touched it in the last five minutes. Touches inside
 * the mirror's WebView don't reach React Native; the page reports them, so pass
 * those to `noteActivity` too.
 */
export function useAgentBrowserLease(screenVisible: boolean): {
  readonly watching: boolean;
  readonly noteActivity: () => void;
} {
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  // Opening the screen counts as activity, so it starts watching without a paused flash.
  const [watching, setWatching] = useState(() => screenVisible && appActive);
  const [lease] = useState(() => createAgentBrowserLease({ onChange: setWatching }));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // Coming back to the app counts as being around.
      if (state === "active") lease.noteActivity();
      setAppActive(state === "active");
    });
    return () => {
      subscription.remove();
      lease.dispose();
    };
  }, [lease]);

  useEffect(() => lease.update(screenVisible, appActive), [lease, screenVisible, appActive]);

  return { watching, noteActivity: lease.noteActivity };
}
