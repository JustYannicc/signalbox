import type { ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";

import { dispatchBrowsingCommand } from "./threadBrowsingSync";

/**
 * Copying a tab you follow (#597): a tab of your own in the thread at `url`,
 * shown in the browser panel. It loads in your engine, signed in as you, and
 * the tab you followed never moves.
 */
export async function openOwnCopy(threadRef: ScopedThreadRef, url: string): Promise<void> {
  const tabId = `tab_${randomUUID().replaceAll("-", "")}`;
  const sequence = await dispatchBrowsingCommand(threadRef, {
    _tag: "Open",
    tabId,
    url,
    activate: true,
  });
  if (sequence === null) {
    toastManager.add({ type: "error", title: "Couldn't open your own copy", description: url });
    return;
  }
  useRightPanelStore.getState().openBrowser(threadRef, tabId);
}
