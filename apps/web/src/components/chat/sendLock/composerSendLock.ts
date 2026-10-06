/**
 * The composer send lock's hooks into ChatComposer and ChatView. A padlock on
 * the send button: while a draft is locked nothing sends from it and Enter adds
 * a line. Answering the agent is never locked: a pending question or a proposed
 * plan's Refine/Implement follow-up. Approvals answer through their own buttons.
 */
import { useCallback, useMemo } from "react";

import { composerTargetKey, type ComposerThreadTarget } from "../../../composerDraftStore";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import {
  isComposerSendLocked,
  SEND_LOCKED_REASON,
  useComposerSendLockStore,
} from "./composerSendLockStore";

export interface ComposerSendLock {
  /** The lock's own state, which the shackle shows. */
  on: boolean;
  /** The lock holds right now: free-text sends are refused and Enter adds a line. */
  locked: boolean;
  /** Why sending is disabled, while the lock holds. */
  disabledReason: string | null;
  toggle: () => void;
}

/** ChatComposer's lock for the open draft. `answeringAgent` lifts the hold, not the lock. */
export function useComposerSendLock(targetKey: string, answeringAgent: boolean): ComposerSendLock {
  const on = useComposerSendLockStore((state) => state.lockedTargetKeys[targetKey] === true);
  const locked = on && !answeringAgent;
  const toggle = useCallback(
    () => useComposerSendLockStore.getState().toggleSendLocked(targetKey),
    [targetKey],
  );
  return useMemo(
    () => ({ on, locked, disabledReason: locked ? SEND_LOCKED_REASON : null, toggle }),
    [on, locked, toggle],
  );
}

/** ChatView's `composer.toggleSendLock` shortcut. */
export function toggleComposerSendLockFromShortcut(
  event: KeyboardEvent,
  target: ComposerThreadTarget,
): void {
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  useComposerSendLockStore.getState().toggleSendLocked(composerTargetKey(target));
}

/**
 * ChatView's last word on a send, which also catches sends that bypass the
 * composer's gate, like "send annotation" from the preview. Call it after
 * pending questions are handled. Returns true when the send was held.
 */
export function holdLockedComposerSend(
  target: ComposerThreadTarget,
  input: { annotation: boolean; answeringPlan: boolean },
): boolean {
  if (input.answeringPlan && !input.annotation) return false;
  if (!isComposerSendLocked(composerTargetKey(target))) return false;
  if (input.annotation) {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Annotation attached to draft",
        description: "Sending is locked for this draft. Unlock it to send.",
      }),
    );
  }
  return true;
}
