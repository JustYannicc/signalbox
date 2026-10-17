import { CommandId } from "@t3tools/contracts";
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
} from "./runnerTestKit.ts";

describe("native answer Runner upgrades", () => {
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
          yield* store.saveMachine({ ...(yield* store.machine), machineClass });
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
                "This machine couldn't update to support questions and approvals. Stop this turn before retrying.",
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
