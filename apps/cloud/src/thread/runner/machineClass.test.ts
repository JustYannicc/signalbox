import type { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  CONNECT_TIMEOUT_MS,
  IDLE_TAIL_MS,
  MachineBackend,
  type MachineBackendShape,
} from "./MachineBackend.ts";
import { CONTINUE_PROMPT } from "./runRecovery.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  personal,
  saveSession,
  snapshot,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";
import { remoteThreadWorktree } from "../../user/contextProjects.ts";
import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";
import * as ThreadStore from "../ThreadStore.ts";
import * as PreviewState from "../PreviewState.ts";

/** A backend that does nothing, with its class's idle tail. */
const fakeBackend = (kind: "cloudflare" | "boat", idleTailMs: number): MachineBackendShape => {
  const status = Effect.succeed({ desired: "stopped", actual: "none", machineId: null } as const);
  return {
    kind,
    shape: null,
    image: null,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    idleTailMs,
    ensure: () => Effect.succeed({ desired: "running", actual: "running", machineId: kind }),
    stop: () => status,
    destroy: () => status,
    inspect: () => status,
    refresh: () => Effect.void,
    refreshEveryMs: null,
    pending: Effect.succeed(false),
  };
};

const LIGHT_TAIL_MS = 30_000;

/** A thread created in a drive backed by a GitHub repo: it gets its own branch there. */
const remoteDrive = "shared/personal/github-acme-app";
const onRemote = {
  place: { ...personal.place, driveId: remoteDrive },
  worktree: remoteThreadWorktree(remoteDrive, threadId),
  pools: personal.pools,
};
const machines = Layer.succeed(MachineBackend, {
  light: fakeBackend("cloudflare", LIGHT_TAIL_MS),
  heavy: fakeBackend("boat", IDLE_TAIL_MS),
});
const options = { machines };

const outgrown = (runId: RunId) =>
  ({
    kind: "machine.outgrown",
    runId,
    reason: "It runs `npm build`, which needs a bigger machine.",
  }) as const;

describe("machine classes", () => {
  it.effect("restores an old light thread's saved preview on heavy without a live turn", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      yield* withObject(
        filename,
        (engine, runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started, report.full, report.terminal],
            });
            yield* Context.get(context, PreviewState.PreviewState).saveServices([
              { port: 5173, command: "npm run dev", cwd: "." },
            ]);
            yield* Context.get(context, ThreadStore.ThreadStore).saveMachine({
              ...ThreadStore.NO_MACHINE,
              generation: machine.generation,
              machineClass: "light",
            });
          }),
        options,
      );
      yield* withObject(
        filename,
        (_engine, runner) =>
          Effect.gen(function* () {
            expect(yield* runner.reconcile).toMatchObject({
              ensure: { generation: 2 },
              machineClass: "heavy",
            });
            expect((yield* runner.work).turn).toBeNull();
          }),
        { ...options, previews: { held: true, lastActiveAt: null } },
      );
    }),
  );

  it.effect("keeps a pre-upgrade heavy repo thread heavy after an eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      yield* withObject(
        filename,
        (engine, _runner, context) =>
          Effect.gen(function* () {
            yield* launch(engine, "launch-1", onRemote);
            // Repo threads used to be heavy without ever setting movedUp.
            yield* Context.get(context, ThreadStore.ThreadStore).saveMachine({
              ...ThreadStore.NO_MACHINE,
              generation: 3,
              machineClass: "heavy",
            });
          }),
        options,
      );
      const next = yield* withObject(filename, (_engine, runner) => runner.reconcile, options);
      expect(next).toMatchObject({ ensure: { generation: 4 }, machineClass: "heavy" });
    }),
  );

  it.effect("starts remote repo threads light until a command needs a heavy machine", () =>
    Effect.gen(function* () {
      const light = yield* withObject(
        freshDatabase(),
        (engine, runner) => Effect.andThen(launch(engine), runner.reconcile),
        options,
      );
      expect(light).toMatchObject({ ensure: { generation: 1 }, machineClass: "light" });
      const heavy = yield* withObject(
        freshDatabase(),
        (engine, runner) => Effect.andThen(launch(engine, "launch-1", onRemote), runner.reconcile),
        options,
      );
      expect(heavy).toMatchObject({ ensure: { generation: 1 }, machineClass: "light" });
    }),
  );

  it.effect("lets a light machine go after its own idle tail", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, report.full, report.terminal],
          });
          expect((yield* runner.reconcile).wakeAt).toBe(LIGHT_TAIL_MS);
          yield* TestClock.adjust(LIGHT_TAIL_MS);
          expect(yield* runner.reconcile).toMatchObject({
            drain: { generation: machine.generation },
          });
          yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
          expect(yield* runner.reconcile).toMatchObject({
            release: machine.generation,
            stop: true,
            machineClass: "light",
          });
        }),
      options,
    ),
  );

  it.effect("moves a light thread's build to a heavy machine mid-turn, losing nothing", () =>
    withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          expect(machine.machineClass).toBe("light");
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          // The reply so far, then the Runner saved everything and says the turn outgrew it.
          yield* saveSession(context, "claude-session-1");
          expect(
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started, report.partial, outgrown(turn.runId), report.full],
            }),
          ).toEqual({ _tag: "ack", sequence: 1 });

          const { projection } = yield* snapshot(engine);
          expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
          const [cut, continuation] = projection.runs;
          expect(continuation?.restartContinuationOfRunId).toBe(cut?.id);
          const items = projection.turnItems.filter((item) => item.runId === cut?.id);
          // Nothing the light machine said after the move counts.
          expect(items.find((item) => item.type === "assistant_message")).toMatchObject({
            status: "interrupted",
            text: "Hel",
          });
          expect(items.find((item) => item.type === "system_notice")).toMatchObject({
            message:
              "It runs `npm build`, which needs a bigger machine. This turn picks up on a bigger machine.",
          });

          // The light machine is done; the continuation gets a heavy one.
          expect(
            yield* runner.batch({ generation: machine.generation, sequence: 2, items: [] }),
          ).toEqual({ _tag: "stale" });
          const heavy = yield* connect(runner);
          expect(heavy).toMatchObject({
            generation: machine.generation + 1,
            machineClass: "heavy",
          });
          expect((yield* runner.work).turn).toMatchObject({
            runId: continuation?.id,
            restartContinuationOfRunId: cut?.id,
            message: { text: CONTINUE_PROMPT },
            providerThread: { nativeThreadRef: { nativeId: "claude-session-1" } },
          });
        }),
      options,
    ),
  );

  it.effect("moves a run up when its light machine runs out of memory, and stays heavy", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      yield* withObject(
        filename,
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started],
            });
            // An older machine's exit changes nothing; the lease's own moves the run up.
            yield* runner.machineExited(machine.generation - 1, {
              detail: "The machine ran out of memory (exit 137).",
              outOfMemory: true,
            });
            expect((yield* snapshot(engine)).projection.runs.map((run) => run.status)).toEqual([
              "running",
            ]);
            yield* runner.machineExited(machine.generation, {
              detail: "The machine ran out of memory (exit 137).",
              outOfMemory: true,
            });
            const { projection } = yield* snapshot(engine);
            expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
          }),
        options,
      );
      // After an eviction, every machine the thread asks for is still heavy.
      const next = yield* withObject(filename, (_engine, runner) => runner.reconcile, options);
      expect(next).toMatchObject({ ensure: { generation: 2 }, machineClass: "heavy" });
    }),
  );

  // #555: Cloudflare restarts a thread's container on every deploy.
  it.effect("continues a run whose light machine a rollout restarted on another light one", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      yield* withObject(
        filename,
        (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            const turn = yield* liveTurn(runner);
            const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
            yield* runner.batch({
              generation: machine.generation,
              sequence: 1,
              items: [report.started],
            });
            yield* runner.machineExited(machine.generation, {
              detail:
                "The machine stopped: Runtime signalled the container to exit due to a new version rollout: 130",
              outOfMemory: false,
            });
            const { projection } = yield* snapshot(engine);
            expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
            const notices = projection.turnItems.filter((item) => item.type === "system_notice");
            expect(JSON.stringify(notices)).not.toContain("bigger machine");
            expect(yield* connect(runner)).toMatchObject({
              generation: machine.generation + 1,
              machineClass: "light",
            });
          }),
        options,
      );
      const next = yield* withObject(filename, (_engine, runner) => runner.reconcile, options);
      expect(next).toMatchObject({ machineClass: "light" });
    }),
  );

  it.effect("continues a heavy machine's outgrown run on another heavy machine", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine, "launch-1", onRemote);
          const machine = yield* connect(runner);
          const turn = yield* liveTurn(runner);
          const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [report.started, outgrown(turn.runId)],
          });
          // Its Runner stopped reporting, so the run goes on rather than hang.
          const { projection } = yield* snapshot(engine);
          expect(projection.runs.map((run) => run.status)).toEqual(["interrupted", "starting"]);
          expect(yield* connect(runner)).toMatchObject({
            generation: machine.generation + 1,
            machineClass: "heavy",
          });
        }),
      options,
    ),
  );
});
