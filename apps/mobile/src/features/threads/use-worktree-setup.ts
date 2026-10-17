import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupActions,
  worktreeSetupAttemptKey,
  worktreeSetupRetryTarget,
  type WorktreeSetupPendingAction,
} from "@t3tools/client-runtime/worktree-setup";
import { useCallback, useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

const clearPendingAction =
  (kind: WorktreeSetupPendingAction["kind"], attempt: string) =>
  (current: WorktreeSetupPendingAction | null) =>
    current?.kind === kind && current.attempt === attempt ? null : current;

export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  preparing: boolean;
  turnStarted: boolean;
  followUpSent: boolean;
}) {
  const key = JSON.stringify([input.environmentId, input.threadId]);
  const [held, setHeld] = useState<{ key: string; snapshot: WorktreeSetupSnapshot } | null>(null);
  const live = held?.key === key ? held.snapshot : null;
  // A retryable ending stays subscribed so the retried attempt replaces it.
  const query = useEnvironmentQuery(
    input.environmentId &&
      input.threadId &&
      (live?.phase === "running" ||
        (live !== null && worktreeSetupRetryTarget(live) !== null) ||
        (!live && input.preparing))
      ? vcsEnvironment.worktreeSetup({
          environmentId: input.environmentId,
          input: { threadId: input.threadId },
        })
      : null,
  );
  const snapshot = resolveWorktreeSetupSnapshot(input.threadId, query.data, live);
  useEffect(() => {
    if (snapshot && snapshot !== live) setHeld({ key, snapshot });
  }, [key, live, snapshot]);

  const cancelCommand = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const retryCommand = useAtomCommand(threadEnvironment.retryWorkspacePreparation, "retry setup");
  const canCancel = useAtomValue(
    vcsEnvironment.cancelWorktreeSetup.permissionAtom(input.environmentId),
  );
  const [pending, setPending] = useState<WorktreeSetupPendingAction | null>(null);
  const actionState = snapshot ? resolveWorktreeSetupActions(snapshot, pending) : null;

  const environmentId = input.environmentId;
  const cancelInput = actionState?.cancelInput ?? null;
  /**
   * Asks the server to stop the shown attempt. Resolves true once it accepted.
   * Without a snapshot there is no attempt to address: Cloud rejects an
   * unguarded stop, so the stop waits for the first snapshot.
   */
  const cancel = useCallback(async () => {
    if (!environmentId || !canCancel || !snapshot || !cancelInput) return false;
    const attempt = worktreeSetupAttemptKey(snapshot);
    setPending({ kind: "cancel", attempt });
    const result = await cancelCommand({ environmentId, input: cancelInput });
    const accepted = result._tag === "Success" && result.value.cancelled;
    // An accepted stop stays pending until the snapshot ends.
    if (!accepted) setPending(clearPendingAction("cancel", attempt));
    return accepted;
  }, [canCancel, cancelCommand, cancelInput, environmentId, snapshot]);

  const retryTarget = actionState?.retry === "available" ? actionState.retryTarget : null;
  const retry = useCallback(() => {
    if (!environmentId || !snapshot || !retryTarget) return;
    const attempt = worktreeSetupAttemptKey(snapshot);
    setPending({ kind: "retry", attempt });
    void retryCommand({ environmentId, input: { ...retryTarget } }).then((result) => {
      if (result._tag !== "Success") setPending(clearPendingAction("retry", attempt));
    });
  }, [environmentId, retryCommand, retryTarget, snapshot]);

  return {
    snapshot,
    visible: resolveVisibleWorktreeSetup({
      live: snapshot,
      recorded: null,
      turnStarted: input.turnStarted,
      followUpSent: input.followUpSent,
    }),
    // Without the grant the stop is hidden, but a stop someone else requested still reads as pending.
    cancelStatus:
      actionState?.cancel === "available" && !canCancel ? null : (actionState?.cancel ?? null),
    retryStatus: actionState?.retry ?? null,
    cancel,
    retry,
  };
}
