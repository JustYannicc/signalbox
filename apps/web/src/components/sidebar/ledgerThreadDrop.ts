import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import type { SidebarThreadDropPlan } from "../Sidebar.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type Result = AtomCommandResult<unknown, unknown>;

interface LedgerDropActions {
  pinThread(ref: ScopedThreadRef, opts: { readonly orderKey?: string }): Promise<Result>;
  unpinThread(ref: ScopedThreadRef): Promise<Result>;
  unsettleThread(ref: ScopedThreadRef): Promise<Result>;
  unsnoozeThread(ref: ScopedThreadRef): Promise<Result>;
  reorderPinnedThread(ref: ScopedThreadRef, orderKey: string): Promise<Result>;
  reorderActiveThread(ref: ScopedThreadRef, orderKey: string): Promise<Result>;
}

type Intent = readonly [Promise<Result>, string];

/**
 * The optimistic ledger owns placement for pin drops, so these bypass the
 * sidebar's local drop hold. Returns false for drops it still holds.
 */
export function beginLedgerThreadDrop(input: {
  readonly plan: SidebarThreadDropPlan;
  readonly threadRef: ScopedThreadRef;
  readonly threadByKey: ReadonlyMap<
    string,
    { readonly environmentId: EnvironmentId; readonly id: ThreadId }
  >;
  readonly actions: LedgerDropActions;
}): boolean {
  const { plan, threadRef, threadByKey, actions } = input;
  const keyWrites = (
    assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>,
    write: (ref: ScopedThreadRef, orderKey: string) => Intent[0],
    title: string,
  ) =>
    assignments.flatMap((assignment): Intent[] => {
      const thread = threadByKey.get(assignment.id);
      return thread === undefined
        ? []
        : [[write(scopeThreadRef(thread.environmentId, thread.id), assignment.orderKey), title]];
    });
  const intents: Intent[] = [];
  switch (plan.kind) {
    case "pin":
      intents.push([
        actions.pinThread(
          threadRef,
          plan.orderKey === undefined ? {} : { orderKey: plan.orderKey },
        ),
        "Failed to pin thread",
      ]);
      intents.push(
        ...keyWrites(
          plan.extraAssignments,
          actions.reorderPinnedThread,
          "Failed to reorder pinned threads",
        ),
      );
      break;
    case "reorder-pinned":
      intents.push(
        ...keyWrites(
          plan.assignments,
          actions.reorderPinnedThread,
          "Failed to reorder pinned threads",
        ),
      );
      break;
    case "move-active":
      if (!plan.unpin) return false;
      intents.push([actions.unpinThread(threadRef), "Failed to unpin thread"]);
      if (plan.unsettle) {
        intents.push([actions.unsettleThread(threadRef), "Failed to un-settle thread"]);
      }
      if (plan.unsnooze) intents.push([actions.unsnoozeThread(threadRef), "Failed to wake thread"]);
      intents.push(
        ...keyWrites(
          plan.assignments,
          actions.reorderActiveThread,
          "Failed to reorder active threads",
        ),
      );
      break;
    default:
      return false;
  }
  void toastFirstFailure(intents);
  return true;
}

// One toast for the first failure; a dropped connection fails them all.
async function toastFirstFailure(intents: readonly Intent[]) {
  for (const [operation, title] of intents) {
    const result = await operation;
    if (result._tag === "Success") continue;
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return;
  }
}
