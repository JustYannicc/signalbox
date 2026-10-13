import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";

/**
 * Demo dataset threads (`scripts/lib/demo-dataset.ts`) that start unread on
 * every load, so the demo shows the unread state. Other data never matches.
 */
const DEMO_UNREAD_THREAD_IDS = new Set([
  "demo-ws-payloads",
  "demo-account-pools",
  "demo-api-versioning",
  "demo-tip-rounding",
  "demo-protein",
]);
// Module state, not storage: every reload starts the demo unread again.
let seeded = false;

/** Marks the demo's unread threads once per page load, through the real unread state. */
export function useDemoUnreadSeed() {
  const threads = useThreadShells();
  useEffect(() => {
    if (seeded) return;
    const demo = threads.filter((thread) => DEMO_UNREAD_THREAD_IDS.has(thread.id));
    if (demo.length === 0) return;
    const { markThreadUnread } = useUiStateStore.getState();
    for (const thread of demo) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      markThreadUnread(key, thread.latestRun?.completedAt);
    }
    seeded = true;
  }, [threads]);
}
