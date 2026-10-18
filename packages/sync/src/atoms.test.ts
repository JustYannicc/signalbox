import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { makeSyncViewAtom, type SyncViewState } from "@signalbox/sync/atoms";
import {
  defineHome,
  SyncCursor,
  type SyncViewSource,
  type ViewFrame,
} from "@signalbox/sync/definition";

const home = defineHome(
  { actor: Schema.Struct({ id: Schema.String }), home: Schema.String, tables: {} },
  ({ view }) => ({
    views: {
      count: view({
        input: Schema.Number,
        output: Schema.Number,
        failure: Schema.Never,
        run: () => Effect.succeed(0),
      }),
    },
    changes: {},
    projections: {},
  }),
);

type State = SyncViewState<number>;

type ObservedAtom = Atom.Atom<AsyncResult.AsyncResult<State, unknown>>;

function observe(registry: AtomRegistry.AtomRegistry, atom: ObservedAtom) {
  return Effect.gen(function* () {
    const states = yield* Queue.unbounded<State | null>();
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(AtomRegistry.toStream(registry, atom), (result) =>
        Queue.offer(states, Option.getOrNull(AsyncResult.value(result))),
      ),
    );
    return { states, fiber };
  });
}

function viewHarness(unsubscribed: Queue.Queue<void>) {
  const listeners = new Set<(frame: ViewFrame<number>) => void>();
  let opened = 0;
  let active = 0;
  let closed = 0;

  const source: SyncViewSource<typeof home.views> = {
    view: () =>
      Stream.callback<ViewFrame<number>, never>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              active += 1;
              const listener = (frame: ViewFrame<number>) => {
                Queue.offerUnsafe(queue, frame);
                if (frame._tag === "Revoked") Queue.endUnsafe(queue);
              };
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
                active -= 1;
                closed += 1;
                Queue.offerUnsafe(unsubscribed, undefined);
              };
            }),
            (release) => Effect.sync(release),
          ),
        { bufferSize: 1, strategy: "sliding" },
      ),
  };

  return {
    source,
    get opened() {
      return opened;
    },
    get active() {
      return active;
    },
    get closed() {
      return closed;
    },
    emit(frame: ViewFrame<number>) {
      for (const listener of listeners) listener(frame);
    },
  };
}

const decodeCursor = Schema.decodeSync(SyncCursor);
const cursor = (value: string) => decodeCursor(value);

const snapshot = (value: number, id: string): ViewFrame<number> => ({
  _tag: "Snapshot",
  value,
  cursor: cursor(id),
});

const update = (value: number, id: string): ViewFrame<number> => ({
  _tag: "Update",
  value,
  cursor: cursor(id),
});

const reset = (value: number, id: string): ViewFrame<number> => ({
  _tag: "Reset",
  value,
  cursor: cursor(id),
});

describe("makeSyncViewAtom public export", () => {
  it.effect(
    "subscribes lazily and exposes replacement frames until revocation clears the value",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const unsubscribed = yield* Queue.unbounded<void>();
          const view = viewHarness(unsubscribed);
          const atom = makeSyncViewAtom(view.source, "count", 1);

          expect(view.opened).toBe(0);
          expect(view.active).toBe(0);

          const observed = yield* observe(registry, atom);
          expect(yield* Queue.take(observed.states)).toEqual({ _tag: "Pending" });
          expect(view.opened).toBe(1);
          expect(view.active).toBe(1);

          view.emit(snapshot(1, "snapshot-1"));
          expect(yield* Queue.take(observed.states)).toEqual({
            _tag: "Value",
            frame: "Snapshot",
            value: 1,
            cursor: cursor("snapshot-1"),
          });
          view.emit(update(2, "update-2"));
          expect(yield* Queue.take(observed.states)).toEqual({
            _tag: "Value",
            frame: "Update",
            value: 2,
            cursor: cursor("update-2"),
          });
          view.emit(reset(3, "reset-3"));
          expect(yield* Queue.take(observed.states)).toEqual({
            _tag: "Value",
            frame: "Reset",
            value: 3,
            cursor: cursor("reset-3"),
          });

          view.emit({ _tag: "Revoked" });
          const revoked = yield* Queue.take(observed.states);
          expect(revoked).toEqual({ _tag: "Revoked" });
          expect(revoked).not.toHaveProperty("value");
          yield* Queue.take(unsubscribed);
          expect(view.active).toBe(0);
          expect(view.closed).toBe(1);

          view.emit(update(4, "late-after-revoke"));
          const afterRevocation = yield* Queue.takeAll(observed.states);
          expect(
            Array.from(afterRevocation).every(
              (state) => state === null || state._tag === "Revoked",
            ),
          ).toBe(true);
          yield* Fiber.interrupt(observed.fiber);
        }),
      ),
  );

  it.effect(
    "releases the native subscription and ignores late frames when its consumer unmounts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const unsubscribed = yield* Queue.unbounded<void>();
          const view = viewHarness(unsubscribed);
          const observed = yield* observe(registry, makeSyncViewAtom(view.source, "count", 1));
          expect(yield* Queue.take(observed.states)).toEqual({ _tag: "Pending" });
          expect(view.active).toBe(1);

          yield* Fiber.interrupt(observed.fiber);
          yield* Queue.take(unsubscribed);
          expect(view.active).toBe(0);
          expect(view.closed).toBe(1);

          view.emit(snapshot(5, "late-after-unmount"));
          expect(Option.isNone(yield* Queue.poll(observed.states))).toBe(true);
        }),
      ),
  );

  it.effect(
    "releases the native subscription and ignores late frames when the registry is disposed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const unsubscribed = yield* Queue.unbounded<void>();
          const view = viewHarness(unsubscribed);
          const observed = yield* observe(registry, makeSyncViewAtom(view.source, "count", 1));
          expect(yield* Queue.take(observed.states)).toEqual({ _tag: "Pending" });
          expect(view.active).toBe(1);

          registry.dispose();
          yield* Queue.take(unsubscribed);
          expect(view.active).toBe(0);
          expect(view.closed).toBe(1);

          view.emit(update(6, "late-after-dispose"));
          expect(Option.isNone(yield* Queue.poll(observed.states))).toBe(true);
          yield* Fiber.interrupt(observed.fiber);
        }),
      ),
  );
});
