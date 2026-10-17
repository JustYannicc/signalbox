import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadStore } from "../ThreadStore.ts";
import { distinctBackends, type MachineBackends } from "./MachineBackend.ts";

/** Called under the engine lock after the durable purge claim blocks restore. */
export const destroyTrashMachines = (
  store: ThreadStore["Service"],
  backends: MachineBackends,
  threadId: ThreadId,
  trashId: string,
) =>
  Effect.gen(function* () {
    const lease = yield* Effect.orDie(store.machine);
    const distinct = distinctBackends(backends);
    if (lease.generation > 0 && distinct.every((backend) => backend.kind === "none")) {
      return false;
    }

    let complete = true;
    for (const backend of distinct) {
      const removed = yield* Effect.gen(function* () {
        let before = yield* backend.inspect(threadId);
        if (
          backend.kind === "boat" &&
          before.machineId === null &&
          (yield* Effect.orDie(store.machineRecord)).createKey !== null
        ) {
          // Replaying a lost create response must name its VM before destroy
          // can erase the only record of which disk was removed.
          before = yield* backend.stop(threadId);
          if (yield* backend.pending) return false;
        }
        if (before.machineId !== null) {
          yield* Effect.orDie(
            store.queueTrashMachine({
              trashId,
              backend: backend.kind,
              machineId: before.machineId,
            }),
          );
        }
        const after = yield* backend.destroy(threadId);
        return after.actual === "none" && !(yield* backend.pending);
      }).pipe(
        Effect.catch((error) =>
          Effect.as(Effect.logError("destroying a trashed machine failed", error.message), false),
        ),
      );
      complete = complete && removed;
    }
    return complete;
  });
