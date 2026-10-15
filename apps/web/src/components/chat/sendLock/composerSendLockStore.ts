import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../../lib/storage";

export const SEND_LOCKED_REASON = "Sending is locked for this draft";

/**
 * Per-draft send lock, keyed by `composerTargetKey`. While locked, Enter inserts a
 * newline and every composer submit path refuses to send. Lives outside the draft
 * store so clearing a draft never unlocks it; only locked keys are kept.
 */
interface ComposerSendLockState {
  lockedTargetKeys: Record<string, true>;
  toggleSendLocked: (targetKey: string) => void;
  setSendLocked: (targetKey: string, locked: boolean) => void;
}

export const useComposerSendLockStore = create<ComposerSendLockState>()(
  persist(
    (set, get) => ({
      lockedTargetKeys: {},
      toggleSendLocked: (targetKey) =>
        get().setSendLocked(targetKey, !get().lockedTargetKeys[targetKey]),
      setSendLocked: (targetKey, locked) =>
        set((state) => {
          if (locked === (state.lockedTargetKeys[targetKey] === true)) return state;
          if (locked) {
            return { lockedTargetKeys: { ...state.lockedTargetKeys, [targetKey]: true } };
          }
          const { [targetKey]: _removed, ...lockedTargetKeys } = state.lockedTargetKeys;
          return { lockedTargetKeys };
        }),
    }),
    {
      name: "signalbox:composer-send-lock:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ lockedTargetKeys: state.lockedTargetKeys }),
    },
  ),
);

/** Non-reactive read for send handlers that run outside render. */
export function isComposerSendLocked(targetKey: string): boolean {
  return useComposerSendLockStore.getState().lockedTargetKeys[targetKey] === true;
}
