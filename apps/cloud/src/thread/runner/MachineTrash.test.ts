import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadStore from "../ThreadStore.ts";
import {
  MachineBackend,
  MachineBackendError,
  type MachineBackendShape,
  type MachineStatus,
} from "./MachineBackend.ts";
import { connect, freshDatabase, launch, owner, withObject } from "./runnerTestKit.ts";

const trash = { trashId: "trash-vm", deletedAt: 0, purgeAfter: 30 * 86400_000 };

const machines = () => {
  let machineId: string | null = "retained-vm";
  let pending = false;
  let destroys = 0;
  let stops = 0;
  let lostReply = false;
  let destroyPending = false;
  const status = (actual: MachineStatus["actual"]): MachineStatus => ({
    desired: "destroyed",
    actual,
    machineId,
  });
  const backend: MachineBackendShape = {
    kind: "boat",
    shape: null,
    image: null,
    connectTimeoutMs: 60_000,
    idleTailMs: 600_000,
    ensure: () => Effect.succeed(status("running")),
    inspect: () => Effect.sync(() => status(machineId === null ? "none" : "stopped")),
    stop: () =>
      Effect.sync(() => {
        stops++;
        machineId ??= "late-create-vm";
        return status("stopped");
      }),
    destroy: () =>
      Effect.gen(function* () {
        destroys++;
        machineId = null;
        pending = destroyPending;
        if (lostReply) {
          lostReply = false;
          return yield* new MachineBackendError({
            message: "Delete succeeded but the reply was lost.",
          });
        }
        return status("none");
      }),
    pending: Effect.sync(() => pending),
    refresh: () => Effect.void,
    refreshEveryMs: null,
  };
  return {
    layer: Layer.succeed(MachineBackend, { light: backend, heavy: backend }),
    loseReply: () => {
      lostReply = true;
    },
    delayDestroy: (value: boolean) => {
      destroyPending = value;
    },
    pendingCreate: () => {
      machineId = null;
    },
    get destroys() {
      return destroys;
    },
    get stops() {
      return stops;
    },
  };
};

const prepare = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine);
    const machine = yield* connect(runner);
    yield* engine.trash(owner, trash);
    const asked = yield* runner.reconcile;
    yield* runner.batch({
      generation: machine.generation,
      sequence: 1,
      items: [{ kind: "machine.drained", id: asked.drain!.id, unsaved: [] }],
    });
    yield* runner.reconcile;
    expect((yield* engine.reconcileTrash)?.ready).toBe(true);
  });

describe("machine purge", () => {
  it.effect("keeps the exact VM id when a destroy reply is lost across eviction", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const remote = machines();
      yield* withObject(
        filename,
        (engine, runner) =>
          Effect.gen(function* () {
            yield* prepare(engine, runner);
            remote.loseReply();
            expect(
              yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true }),
            ).toMatchObject({ state: "trashed", purging: true, removals: [] });
            expect((yield* engine.restoreTrash(owner, trash.trashId)).state).toBe("trashed");
          }),
        { machines: remote.layer },
      );
      yield* withObject(
        filename,
        (engine) =>
          Effect.gen(function* () {
            const receipt = yield* engine.purgeTrash(owner, {
              trashId: trash.trashId,
              empty: true,
            });
            expect(receipt).toMatchObject({
              state: "purged",
              removals: [{ kind: "machine", id: "boat:retained-vm" }],
            });
            expect(
              yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true }),
            ).toEqual(receipt);
            expect(remote.destroys).toBe(2);
          }),
        { machines: remote.layer },
      );
    }),
  );

  it.effect("does not finish while the backend still has a pending destroy", () => {
    const remote = machines();
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* prepare(engine, runner);
          remote.delayDestroy(true);
          expect(
            (yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true })).state,
          ).toBe("trashed");
          remote.delayDestroy(false);
          expect(
            (yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true })).state,
          ).toBe("purged");
          expect(remote.destroys).toBe(2);
        }),
      { machines: remote.layer },
    );
  });

  it.effect("resolves a lost create response before recording and removing its disk", () => {
    const remote = machines();
    return withObject(
      freshDatabase(),
      (engine, runner, context) =>
        Effect.gen(function* () {
          yield* prepare(engine, runner);
          const store = Context.get(context, ThreadStore.ThreadStore);
          yield* store.saveMachineRecord({
            machineId: null,
            createKey: "pending-create",
            desired: "running",
            settled: false,
          });
          remote.pendingCreate();
          expect(
            yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true }),
          ).toMatchObject({
            state: "purged",
            removals: [{ kind: "machine", id: "boat:late-create-vm" }],
          });
          expect(remote.stops).toBe(1);
        }),
      { machines: remote.layer },
    );
  });

  it.effect("cannot destroy the machine of a restored or newer trash entry", () => {
    const remote = machines();
    return withObject(
      freshDatabase(),
      (engine, runner) =>
        Effect.gen(function* () {
          yield* prepare(engine, runner);
          yield* engine.restoreTrash(owner, trash.trashId);
          yield* engine.trash(owner, { ...trash, trashId: "new-trash" });
          expect(
            (yield* engine.purgeTrash(owner, { trashId: trash.trashId, empty: true })).state,
          ).toBe("restored");
          expect(remote.destroys).toBe(0);
        }),
      { machines: remote.layer },
    );
  });
});
