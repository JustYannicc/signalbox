import { CommandId, type OrchestrationV2Run, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { SqlError } from "effect/sql/SqlError";

import { isLiveRun } from "../thread/runLifecycle.ts";
import { collaborationFailure, type CollaborationAccess } from "./access.ts";
import type { TaskRecords } from "./taskRecords.ts";
import type { CollaborationError } from "./errors.ts";
import { stopRunCommand } from "./stopCommand.ts";
import { runContinuationChain } from "../thread/runContinuations.ts";

export const makeTaskStops = (deps: {
  readonly access: CollaborationAccess;
  readonly records: TaskRecords;
}) => {
  const stopRunTree = (
    parent: ThreadId,
    child: ThreadId,
    throughOrdinal: number,
    options: {
      readonly reason?: string | undefined;
      readonly clientRequestId?: string | undefined;
      readonly ownerStop?: boolean;
    } = {},
  ): Effect.Effect<void, CollaborationError | SqlError> =>
    Effect.gen(function* () {
      const found = yield* deps.access.read(parent, child).pipe(
        Effect.catchIf(
          (error) => error.code === "thread_not_found",
          () => Effect.succeed(null),
        ),
      );
      if (
        found === null ||
        found.projection.thread.lineage.relationshipToParent !== "subagent" ||
        found.projection.thread.lineage.parentThreadId !== parent
      )
        return;
      if (!options.ownerStop)
        yield* deps.access.writable(found.caller.projection, found.projection);
      // Fence late completions and delegations before issuing any interrupts.
      yield* deps.records.stop(child, throughOrdinal);
      const descendants = yield* deps.records.childrenThrough(child, throughOrdinal);
      const outcomes = yield* Effect.forEach(descendants, (descendant) =>
        Effect.exit(
          stopRunTree(child, descendant.childThreadId, descendant.throughOrdinal, options),
        ),
      );
      const stopRun = (run: OrchestrationV2Run): Effect.Effect<void, CollaborationError> => {
        const kind = run.status === "queued" ? "cancel" : "interrupt";
        const requestId =
          options.clientRequestId === undefined
            ? `cloud-task-stop:${child}:${throughOrdinal}:${run.id}:${kind}`
            : `${options.clientRequestId}:${child}:${run.id}:${kind}`;
        // Stop still revokes work after the parent changes its execution modes.
        return deps.access.threads
          .dispatchCommand(
            found.caller.actor,
            stopRunCommand(CommandId.make(requestId), run, options.reason),
          )
          .pipe(
            Effect.asVoid,
            Effect.catchTags({
              ThreadCommandRejectedError: (error) =>
                Effect.gen(function* () {
                  const updated = yield* deps.access.read(parent, child);
                  const current = updated.projection.runs.find(
                    (candidate) => candidate.id === run.id,
                  );
                  const continuation = runContinuationChain(updated.projection.runs, current).at(
                    -1,
                  );
                  if (
                    continuation !== undefined &&
                    continuation.id !== run.id &&
                    (isLiveRun(continuation) || continuation.status === "queued")
                  )
                    return yield* stopRun(continuation);
                  if (current === undefined || (!isLiveRun(current) && current.status !== "queued"))
                    return;
                  // A queued run may start after the snapshot. Its interrupt needs a fresh receipt.
                  if (run.status === "queued" && isLiveRun(current)) return yield* stopRun(current);
                  return yield* Effect.fail(collaborationFailure(error));
                }),
            }),
            Effect.mapError(collaborationFailure),
            Effect.catchIf(
              (error) => error.code === "thread_not_found",
              () => Effect.void,
            ),
          );
      };
      // Queued runs go first so interrupting the active run cannot start one of them.
      const runs = found.projection.runs
        .filter((run) => run.ordinal <= throughOrdinal)
        .flatMap((run) => runContinuationChain(found.projection.runs, run))
        .filter(
          (run, index, all) =>
            (run.status === "queued" || isLiveRun(run)) &&
            all.findIndex((candidate) => candidate.id === run.id) === index,
        )
        .toSorted(
          (a, b) =>
            Number(a.status !== "queued") - Number(b.status !== "queued") || a.ordinal - b.ordinal,
        );
      for (const run of runs) outcomes.push(yield* Effect.exit(stopRun(run)));
      const failure = outcomes.find(Exit.isFailure);
      if (failure !== undefined) return yield* Effect.failCause(failure.cause);
    });

  const stopDescendants = (parent: ThreadId, parentOrdinal: number) =>
    Effect.gen(function* () {
      const children = yield* deps.records.childrenThrough(parent, parentOrdinal);
      const outcomes = yield* Effect.forEach(children, (child) =>
        Effect.exit(
          stopRunTree(parent, child.childThreadId, child.throughOrdinal, { ownerStop: true }),
        ),
      );
      const failure = outcomes.find(Exit.isFailure);
      if (failure !== undefined) return yield* Effect.failCause(failure.cause);
    }).pipe(deps.records.lock.withPermits(1), Effect.mapError(collaborationFailure));

  return { stopRunTree, stopDescendants };
};
