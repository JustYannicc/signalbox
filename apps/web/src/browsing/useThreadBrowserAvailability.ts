import type { ScopedThreadRef } from "@t3tools/contracts";

import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentSupportsThreadBrowsing } from "~/state/browsing";

/**
 * What a thread's browser panel can do on this client. A synced thread's
 * tabs (#585) list on every client, even one with no engine to load them
 * (plain web), where the panel points people to the app instead.
 */
export function useThreadBrowserAvailability(
  threadRef: ScopedThreadRef | null,
  serverBrowser: boolean,
) {
  const synced = useEnvironmentSupportsThreadBrowsing(threadRef?.environmentId ?? null);
  const engine = isPreviewSupportedInRuntime() || serverBrowser;
  return {
    /** The panel can show the thread's browser. */
    viewable: engine || synced,
    /** The thread's tabs come from a list the panel waits for before reconciling its tabs. */
    listed: serverBrowser || synced,
    /** Opens the browser panel with no tab where this client can't open one; false where it can. */
    openWithoutEngine: () => {
      if (engine || !synced || threadRef === null) return false;
      useRightPanelStore.getState().openBrowser(threadRef, null);
      return true;
    },
  };
}
