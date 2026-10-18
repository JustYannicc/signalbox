import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import * as Dialog from "../../components/ui/Dialog";
import { scopedThreadKey } from "../../lib/scopedEntities";

type Result = AtomCommandResult<unknown, unknown>;
type Target = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId };
};

interface LedgerMoveCommands {
  pin(value: Target & { readonly input: { readonly orderKey?: string } }): Promise<Result>;
  unpin(value: Target): Promise<Result>;
  reorder(value: Target & { readonly input: { readonly orderKey: string } }): Promise<Result>;
  unsettleThread(thread: EnvironmentThreadShell): Promise<boolean>;
  unsnoozeThread(thread: EnvironmentThreadShell): Promise<boolean>;
}

/**
 * The optimistic ledger owns placement for pin moves, so these bypass the
 * busy flag and pending order. Returns null for moves the list still holds.
 */
export function beginLedgerThreadMove(input: {
  readonly thread: EnvironmentThreadShell;
  readonly section: "pinned" | "active";
  readonly crossSection: boolean;
  readonly lifecycle: {
    readonly unpin: boolean;
    readonly unsettle: boolean;
    readonly unsnooze: boolean;
  };
  readonly assignments: readonly { readonly id: string; readonly orderKey: string }[];
  readonly shellByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly commands: LedgerMoveCommands;
}): Promise<boolean> | null {
  const { thread, section, crossSection, lifecycle, assignments, shellByKey, commands } = input;
  if (section !== "pinned" && !lifecycle.unpin) return null;
  const movedId = scopedThreadKey(thread.environmentId, thread.id);
  const target = { environmentId: thread.environmentId, input: { threadId: thread.id } };
  const intents: Promise<readonly [string, Result]>[] = [];
  const begin = (title: string, operation: Promise<Result>) =>
    intents.push(operation.then((result) => [title, result] as const));
  const writeKeys = () => {
    for (const assignment of assignments) {
      if (
        crossSection &&
        section === "pinned" &&
        thread.pinnedAt == null &&
        assignment.id === movedId
      )
        continue;
      const row = shellByKey.get(assignment.id);
      if (row === undefined) continue;
      begin(
        "Could not move thread",
        commands.reorder({
          environmentId: row.environmentId,
          input: { threadId: row.id, orderKey: assignment.orderKey },
        }),
      );
    }
  };
  if (crossSection && section === "pinned") {
    const orderKey = assignments.find(({ id }) => id === movedId)?.orderKey;
    begin(
      "Could not pin thread",
      commands.pin({
        ...target,
        input: { ...target.input, ...(orderKey === undefined ? {} : { orderKey }) },
      }),
    );
  } else if (crossSection) {
    begin("Could not unpin thread", commands.unpin(target));
  }
  return (async () => {
    if (crossSection && section === "active") {
      // These wait for row dismissal before starting; the moved row's key
      // write starts after them so the shared scheduler queues it behind them.
      // They alert on their own failure; the started unpin is still awaited,
      // without a second alert.
      const followed =
        (!lifecycle.unsettle || (await commands.unsettleThread(thread))) &&
        (!lifecycle.unsnooze || (await commands.unsnoozeThread(thread)));
      if (!followed) {
        await Promise.all(intents);
        return false;
      }
    }
    writeKeys();
    // One alert for the first failure; a dropped connection fails them all.
    for (const [title, result] of await Promise.all(intents)) {
      if (result._tag === "Success") continue;
      const error = Cause.squash(result.cause);
      Dialog.alert(
        title,
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The thread could not be moved.",
      );
      return false;
    }
    return true;
  })();
}
