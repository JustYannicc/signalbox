import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import {
  grantedWorktreeSetupActions,
  pendingWorktreeSetupAction,
  resolveVisibleWorktreeSetup,
  resolveWorktreeSetupActions,
  runAwaitsSetup,
  worktreeSetupAttemptKey,
  worktreeSetupCancelOutcome,
  worktreeSetupRetryTarget,
  type WorktreeSetupCancelOutcome,
  type WorktreeSetupPendingRequest,
} from "@t3tools/client-runtime/worktree-setup";
import { useCallback, useEffect, useState } from "react";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { resolveWorktreeSetupSnapshot } from "./worktree-setup-state";

const settledRequest =
  (action: WorktreeSetupPendingRequest["action"], outcome: "landed" | "failed") =>
  (current: WorktreeSetupPendingRequest | null) =>
    current?.action !== action
      ? current
      : outcome === "failed"
        ? null
        : { ...current, settled: true };

export function useWorktreeSetup(input: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  preparing: boolean;
  run: { readonly status: string; readonly startedAt?: string | null } | null;
  turnStarted: boolean;
  followUpSent: boolean;
}) {
  const key = JSON.stringify([input.environmentId, input.threadId]);
  const [held, setHeld] = useState<{ key: string; snapshot: WorktreeSetupSnapshot } | null>(null);
  const live = held?.key === key ? held.snapshot : null;
  // Cloud keeps every attempt's snapshot, failed and cancelled ones included,
  // so any device opening the thread reads it. A self-hosted server only has
  // one while a worktree is being set up.
  const durableSetup =
    useEnvironmentServerConfig(input.environmentId)?.environment.capabilities.signalboxCloud ===
    true;
  const runSettingUp = runAwaitsSetup(input.run, durableSetup);
  const subscribed =
    input.environmentId !== null &&
    input.threadId !== null &&
    (durableSetup ||
      live?.phase === "running" ||
      // A retryable ending stays subscribed so the retried attempt replaces it.
      (live !== null && worktreeSetupRetryTarget(live) !== null) ||
      (!live && (input.preparing || runSettingUp)));
  const query = useEnvironmentQuery(
    subscribed && input.environmentId && input.threadId
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
  // Setup is under way but the stream has not answered yet. A null answer
  // means no setup, and a failed stream must not strand the thread.
  const awaitingSnapshot =
    subscribed &&
    (input.preparing || runSettingUp) &&
    snapshot === null &&
    !query.isSuccess &&
    query.error === null;

  const cancelCommand = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const retryCommand = useAtomCommand(threadEnvironment.retryWorkspacePreparation, "retry setup");
  const canCancel = useAtomValue(
    vcsEnvironment.cancelWorktreeSetup.permissionAtom(input.environmentId),
  );
  // Retry dispatches an orchestration command, which needs the operate grant.
  const canRetry = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const [pending, setPending] = useState<WorktreeSetupPendingRequest | null>(null);
  const actionState = snapshot
    ? resolveWorktreeSetupActions(snapshot, pendingWorktreeSetupAction(pending, snapshot))
    : null;

  const granted = grantedWorktreeSetupActions(actionState, { cancel: canCancel, retry: canRetry });
  const environmentId = input.environmentId;
  const cancelInput = actionState?.cancelInput ?? null;
  /**
   * Asks the server to stop the shown attempt. Resolves "stopped" only once the
   * server confirms the attempt has stopped. Without a snapshot there is no
   * attempt to address: Cloud rejects an unguarded stop.
   */
  const cancel = useCallback(async (): Promise<WorktreeSetupCancelOutcome> => {
    if (!environmentId || !canCancel || !snapshot || !cancelInput) return "not-stopped";
    const action = { kind: "cancel", attempt: worktreeSetupAttemptKey(snapshot) } as const;
    setPending({ action, sentWith: snapshot, settled: false });
    const outcome = worktreeSetupCancelOutcome(
      await cancelCommand({ environmentId, input: cancelInput }),
    );
    // Not stopped: the button comes back unless the snapshot still says a stop is under way.
    setPending(settledRequest(action, outcome === "not-stopped" ? "failed" : "landed"));
    return outcome;
  }, [canCancel, cancelCommand, cancelInput, environmentId, snapshot]);

  const retryTarget =
    canRetry && actionState?.retry === "available" ? actionState.retryTarget : null;
  const retry = useCallback(() => {
    if (!environmentId || !snapshot || !retryTarget) return;
    const action = { kind: "retry", attempt: worktreeSetupAttemptKey(snapshot) } as const;
    setPending({ action, sentWith: snapshot, settled: false });
    void retryCommand({ environmentId, input: { ...retryTarget } }).then((result) =>
      setPending(settledRequest(action, result._tag === "Success" ? "landed" : "failed")),
    );
  }, [environmentId, retryCommand, retryTarget, snapshot]);

  return {
    snapshot,
    visible: resolveVisibleWorktreeSetup({
      live: snapshot,
      recorded: null,
      turnStarted: input.turnStarted,
      // A cloud snapshot is always the latest run's, so a follow-up never makes it stale.
      followUpSent: input.followUpSent && !durableSetup,
    }),
    awaitingSnapshot,
    cancelStatus: granted.cancel,
    retryStatus: granted.retry,
    cancel,
    retry,
  };
}
