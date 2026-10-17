import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  RunId,
  ScopedThreadRef,
  ThreadId,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { workspacePreparationRetryRunIds } from "@t3tools/client-runtime/state/turn-item-presentation";
import {
  resolveWorktreeSetupActions,
  worktreeSetupAttemptKey,
  type WorktreeSetupActionStatus,
  type WorktreeSetupPendingAction,
} from "@t3tools/client-runtime/worktree-setup";
import { useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import type { Thread } from "../../types";
import { resolveVisibleWorktreeSetup, resolveWorktreeSetupProgress } from "../ChatView.logic";
import { worktreeSetupAgentStarted } from "./MessagesTimeline.logic";

export interface WorktreeSetupActions {
  readonly cancel: WorktreeSetupActionStatus | null;
  readonly retry: WorktreeSetupActionStatus | null;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}

/** Runs with a workspace preparation retry in flight, across ChatView instances. */
const retryingWorkspacePreparationRunIds = new Set<RunId>();

/**
 * Progress of the worktree a send is preparing for this route: the live setup
 * snapshot, whether it holds the composer, and the actions on its card.
 */
export function useWorktreeSetup(input: {
  readonly routeThreadRef: ScopedThreadRef;
  // The draft id for a draft route, else the route's thread key. A bootstrap
  // rotates the thread id, so setup started from a draft stays keyed by it.
  readonly ownerKey: string;
  readonly activeThread:
    | { readonly id: ThreadId; readonly worktreePath: string | null }
    | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly serverProjection: OrchestrationV2ThreadProjection | null;
  readonly activityRun: Thread["latestRun"] | null;
  readonly localPreparing: boolean;
  // A send that the server queues behind the setup run is not held here.
  readonly sendQueuesBehindSetup: boolean;
  readonly followUpSent: boolean;
}) {
  const {
    routeThreadRef,
    ownerKey,
    activeThread,
    threadRef,
    serverProjection,
    activityRun,
    localPreparing,
    sendQueuesBehindSetup,
    followUpSent,
  } = input;
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup, {
    reportFailure: false,
  });
  const retryWorkspacePreparation = useAtomCommand(threadEnvironment.retryWorkspacePreparation);
  const [pendingAction, setPendingAction] = useState<WorktreeSetupPendingAction | null>(null);
  const storeEnsureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  // The thread a send is setting up, recorded by begin() before the server knows it.
  const [startedSetup, setStartedSetup] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly ownerKey: string;
  } | null>(null);
  // Last live snapshot from the setup stream. The server drops a finished
  // snapshot after a grace period and emits null; holding it here bridges the
  // gap until the settled activity arrives on the thread projection.
  const [heldSnapshot, setHeldSnapshot] = useState<WorktreeSetupSnapshot | null>(null);
  const started = startedSetup !== null && startedSetup.ownerKey === ownerKey;
  // Keep the sending environment during local draft setup; revisiting a
  // canonical thread subscribes by its durable identity.
  const target = started ? startedSetup : routeThreadRef;
  const runPreparing = activityRun?.status === "preparing";
  const subscribed =
    started ||
    (activeThread?.id === routeThreadRef.threadId &&
      (localPreparing || runPreparing || activeThread.worktreePath !== null));
  const snapshotQuery = useEnvironmentQuery(
    subscribed
      ? vcsEnvironment.worktreeSetup({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        })
      : null,
  );
  const latestSnapshot = snapshotQuery.data;
  // A newer snapshot replaces the held one; a late older one for the same
  // thread does not. Switching routes drops it.
  const [heldFor, setHeldFor] = useState<{
    readonly routeThreadRef: ScopedThreadRef;
    readonly latestSnapshot: WorktreeSetupSnapshot | null | undefined;
  }>({ routeThreadRef, latestSnapshot: null });
  if (heldFor.routeThreadRef !== routeThreadRef || heldFor.latestSnapshot !== latestSnapshot) {
    const routeChanged = heldFor.routeThreadRef !== routeThreadRef;
    setHeldFor({ routeThreadRef, latestSnapshot });
    if (routeChanged) {
      setHeldSnapshot(null);
    } else if (latestSnapshot) {
      setHeldSnapshot((current) =>
        current?.threadId === latestSnapshot.threadId && current.sequence > latestSnapshot.sequence
          ? current
          : latestSnapshot,
      );
    }
  }
  const { snapshot: liveSnapshot, isPreparingWorktree } = resolveWorktreeSetupProgress({
    threadId: target.threadId,
    localPreparing,
    runStatus: activityRun?.status,
    latest: latestSnapshot,
    held: heldSnapshot,
  });
  // Preparation is under way but the stream has not answered yet. A null
  // answer means no setup, and a failed stream must not strand the thread.
  const awaitingSnapshot =
    subscribed &&
    (localPreparing || runPreparing) &&
    liveSnapshot === null &&
    !snapshotQuery.isSuccess &&
    snapshotQuery.error === null;
  const worktreeSetup = resolveVisibleWorktreeSetup({
    live: liveSnapshot,
    recorded: null,
    turnStarted: activityRun?.startedAt != null,
    followUpSent,
  });
  // Sends wait for the agent handoff, not for the setup script: an async
  // script keeps the snapshot running while the agent already works, and a
  // follow-up must not be held behind a slow install. Before the first
  // snapshot arrives the starting session stands in for it. Once the server
  // has the thread, a send queues behind the setup run instead.
  const blocksSend =
    !sendQueuesBehindSetup &&
    (worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : isPreparingWorktree);

  // Keyed by content so the timeline context only changes when a retry appears or clears.
  const retryableRunIdsKey = [
    ...workspacePreparationRetryRunIds(
      serverProjection?.runs ?? [],
      serverProjection?.turnItems ?? [],
    ),
  ].join("\n");
  const [retryableRunIds, setRetryableRunIds] = useState({
    key: retryableRunIdsKey,
    ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
  });
  if (retryableRunIds.key !== retryableRunIdsKey) {
    setRetryableRunIds({
      key: retryableRunIdsKey,
      ids: new Set(retryableRunIdsKey === "" ? [] : (retryableRunIdsKey.split("\n") as RunId[])),
    });
  }

  /** Records the thread a send is about to set up; null when the send needs none. */
  const begin = useStableCallback(
    (thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null) =>
      setStartedSetup(thread === null ? null : { ...thread, ownerKey }),
  );
  const canCancel = useAtomValue(
    vcsEnvironment.cancelWorktreeSetup.permissionAtom(target.environmentId),
  );
  const actionState = worktreeSetup
    ? resolveWorktreeSetupActions(worktreeSetup, pendingAction)
    : null;
  /** Asks the server to stop the shown attempt. Resolves true once it accepted. */
  const cancel = useStableCallback(async () => {
    const cancelInput = actionState?.cancelInput;
    if (!worktreeSetup || !cancelInput || !canCancel) return false;
    const attempt = worktreeSetupAttemptKey(worktreeSetup);
    setPendingAction({ kind: "cancel", attempt });
    const result = await cancelWorktreeSetup({
      environmentId: target.environmentId,
      input: cancelInput,
    });
    const accepted = result._tag === "Success" && result.value.cancelled;
    // An accepted stop stays pending until the snapshot ends; a refused one
    // gives the button back.
    if (!accepted) {
      setPendingAction((current) =>
        current?.kind === "cancel" && current.attempt === attempt ? null : current,
      );
    }
    return accepted;
  });
  /** Retries the shown failed or cancelled attempt; the server starts the next one. */
  const retrySetup = useStableCallback(() => {
    const retryTarget = actionState?.retry === "available" ? actionState.retryTarget : null;
    if (!worktreeSetup || !retryTarget) return;
    const attempt = worktreeSetupAttemptKey(worktreeSetup);
    setPendingAction({ kind: "retry", attempt });
    void retryWorkspacePreparation({
      environmentId: target.environmentId,
      input: { ...retryTarget },
    }).then((result) => {
      if (result._tag === "Success") return;
      setPendingAction((current) =>
        current?.kind === "retry" && current.attempt === attempt ? null : current,
      );
    });
  });
  // Without the grant the stop button is hidden, but a stop already requested
  // by someone who has it still reads as pending.
  const cancelStatus =
    actionState?.cancel === "available" && !canCancel ? null : (actionState?.cancel ?? null);
  const retryStatus = actionState?.retry ?? null;
  const actions: WorktreeSetupActions | null =
    cancelStatus === null && retryStatus === null
      ? null
      : {
          cancel: cancelStatus,
          retry: retryStatus,
          onCancel: () => void cancel(),
          onRetry: retrySetup,
        };
  const retryPreparation = useStableCallback((runId: RunId) => {
    // One retry per failed run: a second click lands after the run is preparing again.
    if (!threadRef || retryingWorkspacePreparationRunIds.has(runId)) return;
    retryingWorkspacePreparationRunIds.add(runId);
    void retryWorkspacePreparation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, runId },
    }).finally(() => retryingWorkspacePreparationRunIds.delete(runId));
  });
  // The setup terminal belongs to the thread that was set up. A failed
  // bootstrap deletes that thread and closes its terminals, so only offer the
  // terminal while the setup thread is still the active one.
  const setupThreadRef =
    worktreeSetup && threadRef && worktreeSetup.threadId === threadRef.threadId ? threadRef : null;
  const openSetupTerminal = setupThreadRef
    ? (terminalId: string) => {
        storeEnsureTerminal(setupThreadRef, terminalId, { open: true, active: true });
      }
    : null;

  return {
    worktreeSetup,
    isPreparingWorktree,
    blocksSend,
    retryableRunIds: retryableRunIds.ids,
    actions,
    awaitingSnapshot,
    begin,
    cancel,
    retryPreparation,
    openSetupTerminal,
  };
}
