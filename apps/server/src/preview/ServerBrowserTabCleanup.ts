import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

const IDLE_MS = 30 * 60 * 1000;
const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type ThreadLifecycle = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "settledAt"
  | "settledOverride"
  | "status"
  | "activeRunId"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
>;

export interface ServerBrowserTabCleanupState {
  readonly agentOwned: boolean;
  readonly humanControlled: boolean;
  readonly visible: boolean;
  readonly activeOperation: boolean;
  readonly loading: boolean;
  readonly pendingInteraction: boolean;
  readonly recording: boolean;
  readonly usedAt: number;
  readonly now: number;
  /** `undefined` means the lifecycle read failed; `null` means the thread is gone. */
  readonly thread: ThreadLifecycle | null | undefined;
}

export type ServerBrowserTabCleanupReason = "archived" | "settled" | "idle";
export type ServerBrowserTabCleanupBlockReason =
  | "human-controlled"
  | "visible"
  | "active-operation"
  | "loading"
  | "pending-interaction"
  | "recording"
  | "lifecycle-unavailable"
  | "active-thread"
  | "idle-window";

export interface ServerBrowserTabCleanupAssessment {
  readonly cleanupReason: ServerBrowserTabCleanupReason | null;
  readonly blockedBy: ServerBrowserTabCleanupBlockReason | null;
}

const threadHasActiveWork = (thread: ThreadLifecycle | null) =>
  thread !== null &&
  (ACTIVE_RUN_STATUSES.has(thread.status) ||
    thread.activeRunId !== null ||
    thread.activityRunStatus != null ||
    thread.pendingRuntimeRequest !== null ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0);

export const assessTab = (
  state: ServerBrowserTabCleanupState,
): ServerBrowserTabCleanupAssessment => {
  if (!state.agentOwned) return { cleanupReason: null, blockedBy: null };
  if (state.humanControlled) return { cleanupReason: null, blockedBy: "human-controlled" };
  if (state.visible) return { cleanupReason: null, blockedBy: "visible" };
  if (state.activeOperation) return { cleanupReason: null, blockedBy: "active-operation" };
  if (state.loading) return { cleanupReason: null, blockedBy: "loading" };
  if (state.pendingInteraction) return { cleanupReason: null, blockedBy: "pending-interaction" };
  if (state.recording) return { cleanupReason: null, blockedBy: "recording" };
  if (state.thread === undefined)
    return { cleanupReason: null, blockedBy: "lifecycle-unavailable" };
  if (threadHasActiveWork(state.thread)) return { cleanupReason: null, blockedBy: "active-thread" };
  if (state.thread?.archivedAt != null) return { cleanupReason: "archived", blockedBy: null };
  if (state.thread?.settledAt != null || state.thread?.settledOverride === "settled")
    return { cleanupReason: "settled", blockedBy: null };
  if (state.now - state.usedAt > IDLE_MS) return { cleanupReason: "idle", blockedBy: null };
  return { cleanupReason: null, blockedBy: "idle-window" };
};
