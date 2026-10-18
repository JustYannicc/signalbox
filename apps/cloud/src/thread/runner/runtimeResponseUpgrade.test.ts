import { CommandId } from "@t3tools/contracts";
import { RUNNER_PROTOCOL_VERSION } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { ThreadStore } from "../ThreadStore.ts";
import {
  freshDatabase,
  hello,
  launch,
  owner,
  personal,
  snapshot,
  threadId,
  withObject,
} from "../runnerTesting.ts";

describe("native answer Runner upgrades", () => {
  it.effect.each(["approval", "plan"] as const)(
    "keeps preparation cancellable until an upgraded Runner takes a %s turn",
    (mode) =>
      withObject(freshDatabase(), (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.dispatch(
            owner,
            mode === "approval"
              ? {
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("supervised-preparation"),
                  threadId,
                  runtimeMode: "approval-required",
                }
              : {
                  type: "thread.interaction-mode.set",
                  commandId: CommandId.make("plan-preparation"),
                  threadId,
                  interactionMode: "plan",
                },
            personal,
          );
          const first = (yield* runner.reconcile).ensure!;
          const oldHello = {
            ...hello(first.generation, first.token),
            protocolVersion: 6,
            runtimeResponses: false,
            takenRunIds: [],
          };
          yield* runner.hello(oldHello);
          expect(yield* runner.work).toMatchObject({ needsUpkeep: true, turn: null });
          const initial = yield* engine.preparation;
          expect(initial).toMatchObject({
            status: "preparing",
            machineGeneration: 0,
            snapshot: { turnStarted: false },
          });
          const drain = yield* runner.reconcile;
          yield* runner.batch({
            generation: first.generation,
            sequence: 1,
            items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
          });
          const upgraded = (yield* runner.reconcile).ensure!;
          expect(upgraded.generation).toBe(first.generation + 1);
          yield* runner.hello({
            ...oldHello,
            generation: upgraded.generation,
            token: upgraded.token,
          });
          expect((yield* runner.work).turn).toBeNull();
          expect(yield* engine.preparation).toEqual(initial);
          yield* runner.reconcile;
          expect((yield* runner.work).turn).toBeNull();
          expect(yield* engine.preparation).toEqual(initial);

          yield* runner.hello({
            ...hello(upgraded.generation, upgraded.token),
            protocolVersion: RUNNER_PROTOCOL_VERSION,
            runtimeResponses: true,
            takenRunIds: [],
          });
          const work = yield* runner.work;
          expect(work.turn?.preparationGeneration).toBe(initial!.generation);
          expect(yield* engine.preparation).toMatchObject({
            generation: initial!.generation,
            machineGeneration: upgraded.generation,
            status: "preparing",
            snapshot: { turnStarted: false },
          });
          const target = {
            threadId,
            runId: initial!.runId,
            preparationGeneration: initial!.generation,
          };
          expect(
            yield* engine.cancelPreparation(
              owner,
              target,
              runner
                .batch({
                  generation: upgraded.generation,
                  sequence: 1,
                  items: [{ kind: "preparation.cancelled", ...target }],
                })
                .pipe(Effect.asVoid),
            ),
          ).toEqual({ cancelled: true });
          expect((yield* engine.preparation)?.status).toBe("cancelled");
        }),
      ),
  );

  it.effect.each(["light", "heavy"] as const)(
    "updates an old %s Runner once, saving before its generation changes",
    (machineClass) =>
      withObject(freshDatabase(), (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          yield* engine.dispatch(
            owner,
            {
              type: "thread.runtime-mode.set",
              commandId: CommandId.make("supervised"),
              threadId,
              runtimeMode: "approval-required",
            },
            personal,
          );
          const first = (yield* runner.reconcile).ensure!;
          const store = Context.get(context, ThreadStore);
          const secretUpgradeRunId = (yield* snapshot(engine)).projection.runs[0]!.id;
          yield* store.saveMachine({
            ...(yield* store.machine),
            machineClass,
            secretUpgradeRunId,
          });
          const oldHello = {
            ...hello(first.generation, first.token),
            runtimeResponses: false,
            takenRunIds: [],
          };
          yield* runner.hello(oldHello);
          expect(yield* runner.work).toMatchObject({ needsUpkeep: true, turn: null });
          const drain = yield* runner.reconcile;
          expect(drain.drain?.generation).toBe(first.generation);
          expect(drain.ensure).toBeNull();
          expect((yield* runner.reconcile).ensure).toBeNull();
          yield* runner.batch({
            generation: first.generation,
            sequence: 1,
            items: [{ kind: "machine.drained", id: drain.drain!.id, unsaved: [] }],
          });
          const upgraded = yield* runner.reconcile;
          expect(upgraded.ensure?.generation).toBe(first.generation + 1);
          expect(upgraded.release).toBe(first.generation);
          expect(upgraded.machineClass).toBe(machineClass);
          expect((yield* store.machine).secretUpgradeRunId).toBe(secretUpgradeRunId);
          const next = upgraded.ensure!;
          // An old image even after the update stays visible, rather than bumping forever.
          yield* runner.hello({ ...oldHello, generation: next.generation, token: next.token });
          expect((yield* runner.work).needsUpkeep).toBe(true);
          expect((yield* runner.reconcile).ensure).toBeNull();
          expect((yield* runner.work).needsUpkeep).toBe(false);
          expect((yield* store.machine).generation).toBe(next.generation);
          expect((yield* runner.work).turn).toBeNull();
          expect((yield* snapshot(engine)).projection.turnItems).toContainEqual(
            expect.objectContaining({
              type: "system_notice",
              runId: (yield* snapshot(engine)).projection.runs[0]!.id,
              message:
                "This machine couldn't update to support questions and approvals. Stop this turn and wait for the machine to shut down before retrying.",
            }),
          );
          const blockedHead = (yield* snapshot(engine)).head;
          yield* runner.reconcile;
          expect((yield* snapshot(engine)).head).toBe(blockedHead);
          // The upgraded process may reconnect after its new image is available.
          yield* runner.hello({ ...hello(next.generation, next.token), takenRunIds: [] });
          expect((yield* runner.work).turn).not.toBeNull();
          expect((yield* runner.reconcile).ensure).toBeNull();
          expect((yield* store.machine).generation).toBe(next.generation);
          expect(yield* runner.hello(oldHello)).toMatchObject({ reason: "stale_generation" });
        }),
      ),
  );
});
