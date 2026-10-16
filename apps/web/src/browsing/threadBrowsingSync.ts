import type { BrowsingState } from "@t3tools/client-runtime/browsing";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { BrowsingCommand } from "@t3tools/contracts/signalboxBrowsing";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  previewStateAtom,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  setActivePreviewTab,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { browsing } from "~/state/browsing";

import {
  browserSurfaceChange,
  browserSurfaceMoves,
  browserSurfaceTabIds,
  browsingPreviewList,
  type LocalIntent,
  localActivation,
  localIntentHeld,
  localIntentSettled,
  localIntentStarted,
  NO_LOCAL_INTENT,
  remoteActivation,
  samePanelRecord,
  tabMovesForLocalOrder,
} from "./browsingPanel";

/**
 * Keeps the browser panel of a thread in Signalbox Cloud on the thread's
 * synced record (#585), in place of upstream's `preview.list` + global
 * preview events feed, which the cloud doesn't push. Runs while the thread is
 * open: the record lands in `previewStateStore` and the right panel's browser
 * tabs; this device's switches and tab-strip drags go back as commands. Opening,
 * navigating and closing already reach the record through the cloud-served
 * `preview.*` RPCs.
 */

/** The record as this device last received it, for the engines that load it. Null while the thread isn't open. */
export const threadBrowsingStateAtom = Atom.family((threadKey: string) =>
  Atom.make<BrowsingState | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`browsing:state:${threadKey}`),
  ),
);

/** Runs a command against the thread's record; resolves to its sequence after, or null on failure. */
export async function dispatchBrowsingCommand(
  ref: ScopedThreadRef,
  command: BrowsingCommand,
): Promise<number | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    browsing.dispatch,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId, command } },
    { reportFailure: false },
  );
  return result._tag === "Success" ? result.value.sequence : null;
}

type Intent = "activation" | "order";

export const threadBrowsingSyncAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  return Atom.make((get) => {
    if (ref === null) return;
    const recordAtom = browsing.thread({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    });
    const stateAtom = threadBrowsingStateAtom(threadKey);
    let disposed = false;
    let latest: BrowsingState | null = null;
    /** The record as last applied, and whether a hold of ours kept part of it out. */
    let applied: BrowsingState | null = null;
    let heldBack = false;
    const intents: Record<Intent, LocalIntent> = {
      activation: NO_LOCAL_INTENT,
      order: NO_LOCAL_INTENT,
    };
    /** Set while this applies the record, so its own store writes aren't read as the person's. */
    let applying = false;
    let lastLocalActiveTabId = readThreadPreviewState(ref).activeTabId;
    /** A remote switch to a browser tab the right panel had no tab for yet, or showed closed. */
    let pendingSurfaceTabId: string | null = null;

    const whileApplying = (write: () => void) => {
      if (applying) return write();
      applying = true;
      try {
        write();
      } finally {
        applying = false;
        lastLocalActiveTabId = readThreadPreviewState(ref).activeTabId;
      }
    };

    const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

    const showBrowserSurface = (tabId: string) => {
      const current = panel();
      const shown = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
      const surfaceId = `browser:${tabId}`;
      // Someone else switching tabs never pulls this device out of a terminal or files.
      if (shown?.kind !== "preview" || shown.id === surfaceId) {
        pendingSurfaceTabId = null;
        return;
      }
      if (!current.isOpen || !current.surfaces.some((surface) => surface.id === surfaceId)) {
        pendingSurfaceTabId = tabId;
        return;
      }
      pendingSurfaceTabId = null;
      useRightPanelStore.getState().activateSurface(ref, surfaceId);
    };

    const applyOrder = (state: BrowsingState) => {
      const moves = browserSurfaceMoves(
        panel().surfaces,
        state.record.tabs.map((tab) => tab.id),
      );
      for (const move of moves) {
        useRightPanelStore.getState().moveSurface(ref, move.surfaceId, move.toIndex);
      }
    };

    /** `settled`: one of our commands landed, so whatever its hold kept out applies now. */
    const apply = (settled = false) => {
      const state = latest;
      if (disposed || state === null || state.you === null) return;
      const listLoaded = readThreadPreviewState(ref).listLoaded;
      const previous = applied;
      if (!settled && !heldBack && listLoaded && previous !== null) {
        if (samePanelRecord(previous, state)) return;
      }
      applied = state;
      const orderHeld = localIntentHeld(intents.order, state.sequence);
      const activationHeld = localIntentHeld(intents.activation, state.sequence);
      heldBack = orderHeld || activationHeld;
      whileApplying(() => {
        reconcilePreviewServerSessions(
          ref,
          browsingPreviewList(ref.threadId, state, readThreadPreviewState(ref).sessions),
        );
        if (!orderHeld) applyOrder(state);
        const target = remoteActivation(
          state,
          readThreadPreviewState(ref).activeTabId,
          intents.activation,
        );
        if (target !== null && readThreadPreviewState(ref).sessions[target]) {
          setActivePreviewTab(ref, target);
          showBrowserSurface(target);
        }
      });
    };

    const send = (command: BrowsingCommand, intent: Intent) => {
      intents[intent] = localIntentStarted(intents[intent]);
      void dispatchBrowsingCommand(ref, command).then((sequence) => {
        intents[intent] = localIntentSettled(intents[intent], sequence);
        apply(true);
      });
    };

    get.subscribe(
      recordAtom,
      (result) => {
        if (!AsyncResult.isSuccess(result)) return;
        latest = result.value;
        appAtomRegistry.set(stateAtom, latest);
        apply();
      },
      { immediate: true },
    );
    get.mount(recordAtom);

    get.subscribe(previewStateAtom(threadKey), (preview) => {
      if (applying || preview.activeTabId === lastLocalActiveTabId) return;
      lastLocalActiveTabId = preview.activeTabId;
      // The person picked a tab here; an earlier switch from elsewhere no longer applies.
      pendingSurfaceTabId = null;
      const command = latest === null ? null : localActivation(latest, preview.activeTabId);
      if (command !== null) send(command, "activation");
    });

    const unsubscribePanel = useRightPanelStore.subscribe((next, previous) => {
      if (applying) return;
      const after = selectThreadRightPanelState(next.byThreadKey, ref);
      const before = selectThreadRightPanelState(previous.byThreadKey, ref);
      if (after === before) return;
      const change = browserSurfaceChange(before.surfaces, after.surfaces);
      const state = latest;
      if (change === "order" && state !== null) {
        // Only the person's drag reorders browser tabs; our own moves run while applying.
        const moves = tabMovesForLocalOrder(
          state.record.tabs.map((tab) => tab.id),
          browserSurfaceTabIds(after.surfaces),
        );
        for (const command of moves) send(command, "order");
        return;
      }
      if (change === "set" && state !== null && !localIntentHeld(intents.order, state.sequence)) {
        whileApplying(() => applyOrder(state));
      }
      const tabId = pendingSurfaceTabId;
      if (tabId !== null && (change === "set" || (after.isOpen && !before.isOpen))) {
        whileApplying(() => showBrowserSurface(tabId));
      }
    });

    get.addFinalizer(() => {
      disposed = true;
      unsubscribePanel();
      appAtomRegistry.set(stateAtom, null);
    });
  }).pipe(Atom.setIdleTTL(1_000), Atom.withLabel(`browsing:sync:${threadKey}`));
});
