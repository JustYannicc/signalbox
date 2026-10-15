import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { RelayAgentAwarenessPreferences } from "@t3tools/contracts/relay";
import { type AgentAwarenessPhase, projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as DateTime from "effect/DateTime";

/**
 * What earns a push. Attention is the scarce thing, so a phone hears only
 * about what someone has to act on or asked to be told about:
 *
 * - a thread waiting for an approval or an answer,
 * - a turn that failed,
 * - a turn that finished after running long enough that nobody sat watching it.
 *
 * Only transitions count. A thread already waiting on the same request doesn't
 * buzz again on every summary, and the first summary an index sees is a baseline, not news. A
 * finish or failure older than a couple of minutes (a backlog delivered late)
 * stays quiet.
 */

/** Shorter turns finished while the person was still looking. */
export const LONG_TURN_MS = 60_000;
/** A finish or failure delivered later than this is old news. */
export const FRESH_MS = 2 * 60_000;

export type PushPhase = Extract<
  AgentAwarenessPhase,
  "waiting_for_approval" | "waiting_for_input" | "failed" | "completed"
>;

export interface PushMessage {
  readonly phase: PushPhase;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly body: string;
  /** Where tapping it goes: the thread, on the phone. */
  readonly deepLink: string;
}

const BODY: Record<PushPhase, string> = {
  waiting_for_approval: "Waiting for your approval",
  waiting_for_input: "Has a question for you",
  failed: "Stopped with an error",
  completed: "Done",
};

const awareness = (environmentId: EnvironmentId, thread: OrchestrationV2ThreadShell) =>
  projectThreadAwarenessV2({ environmentId, project: { title: "" }, thread });

const millis = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

/** The push `next` earns over `previous`, or null. */
export function pushFor(input: {
  readonly environmentId: EnvironmentId;
  readonly previous: OrchestrationV2ThreadShell | null;
  readonly next: OrchestrationV2ThreadShell;
  readonly now: number;
}): PushMessage | null {
  const { previous, next } = input;
  if (previous === null || next.archivedAt !== null || next.deletedAt !== null) return null;
  const state = awareness(input.environmentId, next);
  if (state === null) return null;
  const before = awareness(input.environmentId, previous)?.phase ?? null;
  const message = (phase: PushPhase): PushMessage => ({
    phase,
    environmentId: input.environmentId,
    threadId: next.id,
    title: next.title,
    body: BODY[phase],
    deepLink: state.deepLink,
  });

  switch (state.phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      // Each new request counts, even when a summary skipped the answer to the last one.
      return before === state.phase &&
        previous.pendingRuntimeRequest?.id === next.pendingRuntimeRequest?.id
        ? null
        : message(state.phase);
    case "failed":
    case "completed": {
      const sameRun = before === state.phase && previous.latestRunId === next.latestRunId;
      const endedAt = millis(next.latestRunCompletedAt) ?? DateTime.toEpochMillis(next.updatedAt);
      if (sameRun || input.now - endedAt > FRESH_MS) return null;
      if (state.phase === "failed") return message("failed");
      const startedAt = millis(next.latestRunStartedAt);
      return startedAt !== null && endedAt - startedAt >= LONG_TURN_MS
        ? message("completed")
        : null;
    }
    default:
      return null;
  }
}

/** Whether a phone with `preferences` wants `phase`. */
export function wants(preferences: RelayAgentAwarenessPreferences, phase: PushPhase): boolean {
  if (!preferences.notificationsEnabled) return false;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "failed":
      return preferences.notifyOnFailure;
    case "completed":
      return preferences.notifyOnCompletion;
  }
}
