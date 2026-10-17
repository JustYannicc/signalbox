import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadStore from "../ThreadStore.ts";
import { DRAIN_TIMEOUT_MS } from "./ThreadRunner.ts";
import { connect, freshDatabase, launch, owner, withObject } from "./runnerTestKit.ts";

const trash = { trashId: "trash-machine", deletedAt: 0, purgeAfter: 30 * 86400_000 };

describe("ThreadRunner trash", () => {
  it.effect(
    "drains immediately despite an open preview and persists readiness across eviction",
    () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        yield* withObject(
          filename,
          (engine, runner) =>
            Effect.gen(function* () {
              yield* launch(engine);
              const machine = yield* connect(runner);
              expect((yield* engine.trash(owner, trash)).ready).toBe(false);
              expect((yield* runner.work).needsUpkeep).toBe(true);
              const asked = yield* runner.reconcile;
              expect(asked).toMatchObject({
                drain: { generation: machine.generation },
                release: null,
                stop: false,
              });
              expect((yield* engine.reconcileTrash)?.ready).toBe(false);
              yield* runner.batch({
                generation: machine.generation,
                sequence: 1,
                items: [{ kind: "machine.drained", id: asked.drain!.id, unsaved: [] }],
              });
              expect((yield* engine.reconcileTrash)?.ready).toBe(false);
              expect(yield* runner.reconcile).toMatchObject({
                release: machine.generation,
                stop: true,
              });
              expect((yield* engine.reconcileTrash)?.ready).toBe(true);
            }),
          { previews: { held: true, lastActiveAt: 0 } },
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect((yield* engine.reconcileTrash)?.ready).toBe(true);
          }),
        );
      }),
  );

  for (const failure of ["unsaved", "timeout", "lost"] as const) {
    it.effect(`does not make a ${failure} machine eligible for purge`, () =>
      Effect.gen(function* () {
        const filename = freshDatabase();
        yield* withObject(filename, (engine, runner) =>
          Effect.gen(function* () {
            yield* launch(engine);
            const machine = yield* connect(runner);
            yield* engine.trash(owner, trash);
            const asked = yield* runner.reconcile;
            if (failure === "unsaved") {
              yield* runner.batch({
                generation: machine.generation,
                sequence: 1,
                items: [
                  {
                    kind: "machine.drained",
                    id: asked.drain!.id,
                    unsaved: ["The drive upload failed."],
                  },
                ],
              });
            } else if (failure === "timeout") {
              yield* TestClock.adjust(DRAIN_TIMEOUT_MS);
            } else {
              yield* runner.ended(machine.generation, "machine vanished");
            }
            yield* runner.reconcile;
            if (failure === "lost") {
              expect(yield* runner.leaseToken(machine.generation)).toBeNull();
            } else {
              expect(yield* runner.leaseToken(machine.generation)).toBe(machine.token);
            }
            expect((yield* engine.reconcileTrash)?.ready).toBe(false);
            expect(
              yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true }),
            ).toMatchObject({ state: "trashed", ready: false, purging: false });
            expect((yield* engine.projection)?.messages).not.toHaveLength(0);
          }),
        );
        yield* withObject(filename, (engine) =>
          Effect.gen(function* () {
            expect((yield* engine.reconcileTrash)?.ready).toBe(false);
          }),
        );
      }),
    );
  }

  it.effect("recovers an older released lease to save without starting a provider turn", () =>
    withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const old = yield* connect(runner);
          const store = Context.get(context, ThreadStore.ThreadStore);
          yield* store.saveMachine({
            ...ThreadStore.NO_MACHINE,
            generation: old.generation,
            machineClass: old.machineClass,
          });
          expect((yield* engine.trash(owner, trash)).ready).toBe(false);
          const recovery = yield* connect(runner);
          expect(recovery.generation).toBe(old.generation + 1);
          const draining = yield* runner.reconcile;
          expect(draining.drain).not.toBeNull();
          const work = yield* runner.work;
          expect(work).toMatchObject({ turn: null, modelToken: null, activeRunId: null });
          expect(work.drainRecovery?.drive).toMatchObject({
            driveId: "my/personal/user_1",
            remoteToken: null,
          });
          expect(yield* runner.authorizeSession(work.drainRecovery!.sessions.token)).toMatchObject({
            _tag: "granted",
            generation: recovery.generation,
          });
          yield* runner.batch({
            generation: recovery.generation,
            sequence: 1,
            items: [{ kind: "machine.drained", id: draining.drain!.id, unsaved: [] }],
          });
          yield* runner.reconcile;
          expect((yield* engine.reconcileTrash)?.ready).toBe(true);
        }),
      { drives: true },
    ),
  );

  it.effect("ignores an old drain answer after restore starts new work", () =>
    withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* launch(engine);
          const machine = yield* connect(runner);
          yield* engine.trash(owner, trash);
          const old = yield* runner.reconcile;
          yield* engine.restoreTrash(owner, trash.trashId);
          // A restored preview keeps the machine alive and cancels the old drain.
          yield* runner.reconcile;
          const next = { ...trash, trashId: "trash-again" };
          expect((yield* engine.trash(owner, next)).ready).toBe(false);
          const fresh = yield* runner.reconcile;
          expect(fresh).toMatchObject({ release: null, stop: false });
          expect(fresh.drain!.id).not.toBe(old.drain!.id);
          yield* runner.batch({
            generation: machine.generation,
            sequence: 1,
            items: [{ kind: "machine.drained", id: old.drain!.id, unsaved: [] }],
          });
          expect(yield* runner.reconcile).toMatchObject({ release: null, stop: false });
          expect((yield* engine.reconcileTrash)?.ready).toBe(false);
        }),
      { previews: { held: true, lastActiveAt: 0 } },
    ),
  );
});
