import type { OrchestrationV2Command, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as MachineBackend from "./runner/MachineBackend.ts";
import * as Option from "effect/Option";

import * as DriveDirectory from "../drive/DriveDirectory.ts";
import { canWrite } from "../drive/driveAccess.ts";
import { parseCheckpointRange } from "./driveEvents.ts";
import { isLiveRun } from "./runLifecycle.ts";
import type { RollbackOperation } from "./rollbackState.ts";
import { ThreadCommandRejectedError } from "./ThreadAccess.ts";
import type { ThreadOwner } from "./ThreadStore.ts";

type Command = Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>;

export class RollbackRestoreRejectedError extends Schema.TaggedError<RollbackRestoreRejectedError>()(
  "RollbackRestoreRejectedError",
  { category: Schema.Literals(["conflict", "refused"]) },
) {
  override get message() {
    return this.category === "conflict"
      ? "Files changed before undo could restore them. Try undo again."
      : "The drive refused undo. Check your access and checkpoint, then try again.";
  }
}

export class RollbackRuntime extends Context.Service<
  RollbackRuntime,
  {
    readonly arm: Effect.Effect<void>;
    readonly endRunners: (generation: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/CheckpointRollback/RollbackRuntime") {}

export class CheckpointRollback extends Context.Service<
  CheckpointRollback,
  {
    readonly prepare: (
      projection: OrchestrationV2ThreadProjection,
      owner: ThreadOwner,
      command: Command,
      generation: number,
    ) => Effect.Effect<RollbackOperation, ThreadCommandRejectedError>;
    readonly restore: (
      operation: RollbackOperation,
    ) => Effect.Effect<void, RollbackRestoreRejectedError>;
    readonly arm: Effect.Effect<void>;
  }
>()("@signalbox/cloud/thread/CheckpointRollback") {}

const make = Effect.gen(function* () {
  // Engine-only tests have no drive binding; rollback still fails explicitly.
  const backends = yield* MachineBackend.MachineBackend;
  const runtime = Option.getOrUndefined(yield* Effect.serviceOption(RollbackRuntime));
  const directory = yield* Effect.serviceOption(DriveDirectory.DriveDirectory);
  const prepare: CheckpointRollback["Service"]["prepare"] = Effect.fn("CheckpointRollback.prepare")(
    function* (projection, owner, command, generation) {
      const reject = (reason: string) =>
        ThreadCommandRejectedError.forCommand(
          { id: command.commandId, type: command.type },
          reason,
        );
      if (projection.thread.deletedAt !== null) return yield* reject("This thread was deleted.");
      if (projection.runs.some((run) => isLiveRun(run) || run.status === "queued")) {
        return yield* reject("Stop active runs and clear the queue before undoing.");
      }
      const checkpoint = projection.checkpoints.find((item) => item.id === command.checkpointId);
      const scope = projection.checkpointScopes.find((item) => item.id === command.scopeId);
      const run = projection.runs.find((item) => item.id === checkpoint?.runId);
      const baseline = checkpoint?.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null;
      const range = checkpoint === undefined ? null : parseCheckpointRange(checkpoint.ref);
      if (
        checkpoint === undefined ||
        scope === undefined ||
        run === undefined ||
        (!baseline && range === null) ||
        checkpoint.status !== "ready" ||
        checkpoint.scopeId !== scope.id ||
        checkpoint.threadId !== projection.thread.id ||
        scope.threadId !== projection.thread.id ||
        scope.runId !== run.id ||
        scope.kind !== "root_run" ||
        (!baseline && run.status === "rolled_back") ||
        (baseline ? run.ordinal !== 1 : checkpoint.appRunOrdinal !== run.ordinal)
      ) {
        return yield* reject("That checkpoint is no longer available.");
      }
      const common = {
        version: 1 as const,
        commandId: command.commandId,
        threadId: projection.thread.id,
        userId: owner.userId,
        driveId: owner.driveId,
        restoreFiles: command.restoreFiles !== false,
        scopeId: scope.id,
        checkpointId: checkpoint.id,
        runId: run.id,
        targetOrdinal: baseline ? 0 : run.ordinal,
        boundary: baseline ? ("start" as const) : ("end" as const),
        generation,
        stage: "prepared" as const,
      };
      if (!common.restoreFiles) return { ...common, expectedThread: null, expectedWip: null };
      if (owner.driveId === null || Option.isNone(directory)) {
        return yield* reject("This cloud has no drive for this thread.");
      }
      const drive = directory.value.forDrive(owner.driveId);
      if (!canWrite(yield* Effect.orDie(drive.role(owner.userId)))) {
        return yield* reject("You can no longer change this drive.");
      }
      const stored = yield* Effect.orDie(drive.checkpoint(projection.thread.id, run.id));
      if (
        stored === null ||
        (baseline
          ? stored.start === null
            ? checkpoint.ref !== "empty"
            : checkpoint.ref !== `${stored.start}..${stored.start}`
          : range?.start !== stored.start || range.commit !== stored.commit)
      ) {
        return yield* reject("That checkpoint no longer matches the saved files.");
      }
      const refs = yield* Effect.orDie(drive.refs(projection.thread.id));
      return { ...common, expectedThread: refs.thread, expectedWip: refs.wip };
    },
  );

  const restore: CheckpointRollback["Service"]["restore"] = Effect.fn("CheckpointRollback.restore")(
    function* (operation) {
      yield* runtime?.arm ?? Effect.void;
      yield* runtime?.endRunners(operation.generation) ?? Effect.void;
      // Undo retains the drive's saved refs; unflushed machine files are outside that recovery boundary.
      for (const backend of MachineBackend.distinctBackends(backends)) {
        yield* Effect.orDie(backend.stop(operation.threadId));
        const stopped = yield* Effect.orDie(backend.inspect(operation.threadId));
        if (stopped.actual !== "none" && stopped.actual !== "stopped") {
          return yield* Effect.die("Undo is waiting for the old machine to stop.");
        }
      }
      if (operation.driveId === null || Option.isNone(directory)) {
        if (!operation.restoreFiles) return;
        return yield* Effect.die("Rollback drive binding is missing.");
      }
      const drive = directory.value.forDrive(operation.driveId);
      const retireLease = Effect.orDie(
        drive.advanceThreadFence(operation.threadId, operation.generation + 1),
      );
      if (!operation.restoreFiles) {
        yield* retireLease;
        return;
      }
      const request = {
        threadId: operation.threadId,
        runId: operation.runId,
        boundary: operation.boundary,
        operationId: `thread-rollback:${operation.commandId}`,
        expectedThread: operation.expectedThread,
        expectedWip: operation.expectedWip,
        generation: operation.generation,
      };
      // A committed restore must finish its conversation even if its requester lost drive access.
      if (
        (yield* Effect.orDie(drive.restoreCheckpointStatus(operation.userId, request))) ===
        "committed"
      )
        return;
      yield* Effect.orDie(drive.advanceThreadFence(operation.threadId, operation.generation));
      const result = yield* Effect.orDie(drive.restoreCheckpoint(operation.userId, request));
      if (result._tag === "ok") return;
      // Fence delayed requests before deciding whether this operation ever committed.
      yield* retireLease;
      const status = yield* Effect.orDie(drive.restoreCheckpointStatus(operation.userId, request));
      if (status === "committed") return;
      if (status === "unverified") {
        return yield* Effect.die(
          "The restore's original requester could not be verified; recovery remains pending.",
        );
      }
      return yield* new RollbackRestoreRejectedError({ category: result._tag });
    },
  );
  return CheckpointRollback.of({ prepare, restore, arm: runtime?.arm ?? Effect.void });
});

export const layer = Layer.effect(CheckpointRollback, make);
