import type { DriveCheckpointRecord } from "@signalbox/runner-protocol/DriveProtocol";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DriveDirectory from "../drive/DriveDirectory.ts";
import { makeMemoryDrives } from "../drive/driveTesting.ts";
import type { RestoreCheckpointRequest, ThreadRefs } from "../drive/DriveStore.ts";
import { threadId, owner, personal, liveTurn, turnReport } from "./runnerTesting.ts";
import type * as ThreadEngine from "./ThreadEngine.ts";
import type * as ThreadRunner from "./runner/ThreadRunner.ts";
import * as MachineBackend from "./runner/MachineBackend.ts";

export const firstCommit = "a".repeat(40);
export const secondCommit = "b".repeat(40);
export const thirdCommit = "c".repeat(40);

export const fixture = () => {
  const records = new Map<string, DriveCheckpointRecord>();
  const restored = new Set<string>();
  const calls: Array<RestoreCheckpointRequest> = [];
  const order: Array<string> = [];
  const state = {
    role: "contributor" as "contributor" | null,
    refusal: false,
    conflict: false,
    lostResponse: false,
    transient: false,
    stopping: false,
    creating: false,
  };
  let refs: ThreadRefs = {
    main: thirdCommit,
    thread: thirdCommit,
    wip: thirdCommit,
    machine: null,
    base: null,
    packs: [],
    remote: null,
    shallow: [],
  };
  const memory = makeMemoryDrives();
  const drives = Layer.effect(
    DriveDirectory.DriveDirectory,
    Effect.map(DriveDirectory.DriveDirectory, (base) => ({
      forDrive: (id: string) => ({
        ...base.forDrive(id),
        role: () => Effect.succeed(state.role),
        checkpoint: (_threadId: string, runId: string) =>
          Effect.succeed(records.get(runId) ?? null),
        refs: () => Effect.sync(() => refs),
        advanceThreadFence: (_threadId: string, generation: number) =>
          Effect.succeed({ _tag: "ok", generation } as const),
        restoreCheckpointStatus: (_userId: string, request: RestoreCheckpointRequest) =>
          Effect.sync(() =>
            restored.has(request.operationId) ? ("committed" as const) : ("not-committed" as const),
          ),
        restoreCheckpoint: (_userId: string, request: RestoreCheckpointRequest) =>
          Effect.gen(function* () {
            calls.push(request);
            order.push("restore");
            if (state.transient) return yield* Effect.die("drive transport unavailable");
            if (state.refusal) return { _tag: "refused", reason: "access revoked" } as const;
            if (state.conflict)
              return { _tag: "conflict", refs, generation: request.generation } as const;
            if (!restored.has(request.operationId)) {
              const record = records.get(request.runId)!;
              const target = request.boundary === "start" ? record.start : record.commit;
              refs = { ...refs, thread: target, wip: target };
              restored.add(request.operationId);
            }
            if (state.lostResponse) {
              state.lostResponse = false;
              return yield* Effect.die("drive response lost after commit");
            }
            return { _tag: "ok", refs, generation: request.generation + 1 } as const;
          }),
      }),
    })),
  ).pipe(Layer.provide(memory.layer));
  const backend: MachineBackend.MachineBackendShape = {
    kind: "local",
    shape: null,
    image: null,
    connectTimeoutMs: 60_000,
    idleTailMs: 60_000,
    ensure: () => Effect.succeed({ desired: "running", actual: "running", machineId: "test" }),
    stop: () =>
      Effect.sync(() => {
        const repeated = order.includes("stop");
        order.push("stop");
        return {
          desired: "stopped",
          actual: state.creating
            ? "starting"
            : state.stopping && !repeated
              ? "stopping"
              : "stopped",
          machineId: "test",
        } as const;
      }),
    destroy: () => Effect.succeed({ desired: "destroyed", actual: "none", machineId: null }),
    inspect: () =>
      Effect.sync(
        () =>
          ({
            desired: "stopped",
            actual: state.creating ? "none" : state.stopping ? "stopping" : "stopped",
            machineId: "test",
          }) as const,
      ),
    refresh: () => Effect.void,
    refreshEveryMs: null,
    pending: Effect.succeed(false),
  };
  return {
    calls,
    order,
    records,
    restored,
    state,
    refs: () => refs,
    options: {
      drives: true,
      rollbackDrives: drives,
      machines: Layer.succeed(MachineBackend.MachineBackend, { light: backend, heavy: backend }),
    },
  };
};

export const finish = (
  runner: ThreadRunner.ThreadRunner["Service"],
  generation: number,
  sequence: number,
  f: ReturnType<typeof fixture>,
  commit: string,
  start: string | null,
  reply: string,
) =>
  Effect.gen(function* () {
    const turn = yield* liveTurn(runner);
    const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread, {
      replyText: reply,
    });
    f.records.set(turn.runId, {
      runId: turn.runId,
      turnId: `turn-${turn.runId}`,
      commit,
      start,
      notes: commit,
      views: { shortcuts: [], context: null },
    });
    yield* runner.batch({
      generation,
      sequence,
      items: [
        report.started,
        report.full,
        { kind: "drive.checkpoint", runId: turn.runId, start, commit, files: [] },
        report.terminal,
      ],
    });
    return { turn, report };
  });

export const command = (runId: string, id = "undo", baseline = false, restoreFiles = true) =>
  ({
    type: "checkpoint.rollback",
    commandId: CommandId.make(id),
    threadId,
    scopeId: CheckpointScopeId.make(`checkpoint-scope:${runId}`),
    checkpointId: CheckpointId.make(`checkpoint:${runId}${baseline ? ":start" : ""}`),
    restoreFiles,
  }) satisfies OrchestrationV2Command;

export const undo = (
  engine: ThreadEngine.ThreadEngine["Service"],
  runId: string,
  id = "undo",
  baseline = false,
  restoreFiles = true,
) => engine.dispatch(owner, command(runId, id, baseline, restoreFiles), personal);
