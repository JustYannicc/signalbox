/**
 * The composer send lock's hooks into ChatComposer and ChatView. `/lock` locks
 * the open draft: nothing sends from it, Enter adds a line, and Send turns into
 * a padlock that explains itself and unlocks. Answering the agent is never
 * locked: a pending question or a proposed plan's Refine/Implement follow-up.
 * Approvals answer through their own buttons.
 */
import { useCallback, useMemo } from "react";

import { composerTargetKey, type ComposerThreadTarget } from "../../../composerDraftStore";
import type { ComposerCommandItem } from "../ComposerCommandMenu";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import {
  isComposerSendLocked,
  SEND_LOCKED_REASON,
  useComposerSendLockStore,
} from "./composerSendLockStore";

export interface ComposerSendLock {
  /** The lock's own state, which picks `/lock` or `/unlock`. */
  on: boolean;
  /** The lock holds right now: free-text sends are refused and Enter adds a line. */
  locked: boolean;
  /** Why sending is disabled, while the lock holds. */
  disabledReason: string | null;
  setLocked: (locked: boolean) => void;
}

/** ChatComposer's lock for the open draft. `answeringAgent` lifts the hold, not the lock. */
export function useComposerSendLock(targetKey: string, answeringAgent: boolean): ComposerSendLock {
  const on = useComposerSendLockStore((state) => state.lockedTargetKeys[targetKey] === true);
  const locked = on && !answeringAgent;
  const setLocked = useCallback(
    (next: boolean) => useComposerSendLockStore.getState().setSendLocked(targetKey, next),
    [targetKey],
  );
  return useMemo(
    () => ({ on, locked, disabledReason: locked ? SEND_LOCKED_REASON : null, setLocked }),
    [on, locked, setLocked],
  );
}

/** ChatComposer's built-in slash command: `/lock`, or `/unlock` once the draft is locked. */
export function sendLockSlashCommandItem(
  on: boolean,
): Extract<ComposerCommandItem, { type: "slash-command" }> {
  return on
    ? {
        id: "slash:unlock",
        type: "slash-command",
        command: "unlock",
        label: "/unlock",
        description: "Let this draft send again",
      }
    : {
        id: "slash:lock",
        type: "slash-command",
        command: "lock",
        label: "/lock",
        description: "Lock sending for this draft: Enter adds a line",
      };
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
