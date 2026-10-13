import { AUTOMATION_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

/** Automation runs attached to a thread, as the server lists them among the thread's background tasks. */
const ATTACHED_TASK_PREFIX = "automation-run:";

/**
 * The attached automation runs among a thread shell's background tasks. Only
 * the shell carries them (the server keeps them outside the projection), so a
 * view deriving its tasks from the projection adds these.
 */
export const attachedAutomationTasks = <Task extends { readonly taskId: string }>(
  tasks: ReadonlyArray<Task> | undefined,
): ReadonlyArray<Task> =>
  (tasks ?? []).filter((task) => task.taskId.startsWith(ATTACHED_TASK_PREFIX));

/**
 * Stop on a thread also cancels the automation runs attached to it. Best
 * effort: a server without automations never answers, so this gives up after
 * a moment and never fails the Stop it rides along with.
 */
export const stopAttachedAutomations = Effect.fn("Automations.stopAttached")(function* (
  threadId: ThreadId,
) {
  yield* request(AUTOMATION_WS_METHODS.automationsStopAttached, { threadId }).pipe(
    Effect.timeout("3 seconds"),
    Effect.ignoreCause,
  );
});
