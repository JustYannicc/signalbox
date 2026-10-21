import { Effect } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ChildWorkerCapacity,
  isChildWorkerReservation,
  type ChildWorkerReservation,
} from "../ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { childBusyboxFixture, exited } from "./ChildBusyboxFixture.ts";

type Fixture = ReturnType<typeof childBusyboxFixture>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const fixture = childBusyboxFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

const fixtures: Fixture[] = [];
function requester() {
  const fixture = childBusyboxFixture();
  fixtures.push(fixture);
  return { processes: fixture.context.processes, process: fixture.context.identity.handle };
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

describe("ChildWorkerReservation", () => {
  it("is capacity-owned, shares queued admission, and cancels once", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const reservation = await capacity.reserve(signal, requester());
    expect(isChildWorkerReservation(reservation)).toBe(true);
    expect(capacity.active).toBe(1);

    const forged = { run: vi.fn(async () => undefined), cancel: vi.fn() };
    expect(isChildWorkerReservation(forged)).toBe(false);
    const permitLike = { release: vi.fn() };
    const implementation = Object.getPrototypeOf(reservation).constructor;
    expect(() => Reflect.construct(implementation, [permitLike])).toThrow("issued by capacity");
    const queued = capacity.reserve(signal, requester());
    reservation.cancel();
    reservation.cancel();
    expect(capacity.active).toBe(1);
    const nextReservation = await queued;
    expect(capacity.active).toBe(1);
    nextReservation.cancel();
    expect(capacity.active).toBe(0);
  });

  it("consumes synchronously, ignores cancel after handoff, and releases on settlement", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const reservation = await capacity.reserve(signal, requester());
    const started = deferred<void>();
    const finished = deferred<number>();
    let starts = 0;
    const work = vi.fn(async () => {
      starts++;
      started.resolve(undefined);
      return finished.promise;
    });

    const running = reservation.run(signal, work, requester());
    await expect(reservation.run(signal, work, requester())).rejects.toThrow("no longer available");
    expect(starts).toBe(1);
    await started.promise;
    reservation.cancel();
    expect(capacity.active).toBe(1);

    finished.resolve(17);
    await expect(running).resolves.toBe(17);
    expect(capacity.active).toBe(0);
    expect(work).toHaveBeenCalledOnce();
  });

  it("releases an unconsumed reservation when run observes an aborted signal", async () => {
    const capacity = new ChildWorkerCapacity(1);
    const controller = new AbortController();
    const reservation = await capacity.reserve(controller.signal, requester());
    const reason = new Error("cancelled before dispatch");
    const work = vi.fn(async () => undefined);

    controller.abort(reason);
    await expect(reservation.run(controller.signal, work, requester())).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(capacity.active).toBe(0);
  });

  it("dispatches with its reserved slot at full capacity without reacquiring", () =>
    withFixture(async (fixture) => {
      const capacity = new ChildWorkerCapacity(1);
      const reservation = await capacity.reserve(fixture.context.signal, {
        processes: fixture.context.processes,
        process: fixture.context.identity.handle,
      });
      const capacityRun = vi.spyOn(capacity, "run");
      const modules = vi.fn(() => ({ "entry.js": "export default 0" }));
      const dispatch = vi.fn(async () => {
        expect(capacity.active).toBe(1);
        return exited(17);
      });
      const createHost = vi.fn(() => ({ host: {}, close() {} }));
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules },
        capacity,
        reservationFor: (context) => {
          expect(context).toBe(fixture.context);
          return reservation;
        },
        dispatch: { run: dispatch },
        createHost,
      });

      expect(capacity.active).toBe(1);
      await expect(program.run(fixture.context)).resolves.toEqual(exited(17));
      expect(capacityRun).not.toHaveBeenCalled();
      expect(modules).toHaveBeenCalledOnce();
      expect(createHost).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
    }));

  it("rejects cancelled and duplicate tokens before modules, host creation, or dispatch", () =>
    withFixture(async (fixture) => {
      const capacity = new ChildWorkerCapacity(1);
      const capacityRun = vi.spyOn(capacity, "run");
      const modules = vi.fn(() => ({ "entry.js": "export default 0" }));
      const dispatch = vi.fn(async () => exited());
      const createHost = vi.fn(() => ({ host: {}, close() {} }));
      let reservation = await capacity.reserve(fixture.context.signal, {
        processes: fixture.context.processes,
        process: fixture.context.identity.handle,
      });
      reservation.cancel();
      reservation.cancel();
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules },
        capacity,
        reservationFor: () => reservation,
        dispatch: { run: dispatch },
        createHost,
      });

      await expect(program.run(fixture.context)).rejects.toThrow("no longer available");
      reservation = await capacity.reserve(fixture.context.signal, {
        processes: fixture.context.processes,
        process: fixture.context.identity.handle,
      });
      await expect(program.run(fixture.context)).resolves.toEqual(exited());
      await expect(program.run(fixture.context)).rejects.toThrow("no longer available");

      expect(capacityRun).not.toHaveBeenCalled();
      expect(modules).toHaveBeenCalledOnce();
      expect(createHost).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(capacity.active).toBe(0);
    }));

  it("rejects resolver failures and forged or missing reservations without fallback", () =>
    withFixture(async (fixture) => {
      const forged = {
        run: vi.fn(async () => exited()),
        cancel: vi.fn(),
      } as unknown as ChildWorkerReservation;
      const resolverFailure = new Error("admission mapping failed");
      const cases: ReadonlyArray<{
        readonly reservationFor: () => ChildWorkerReservation;
        readonly expected: unknown;
      }> = [
        {
          reservationFor: () => {
            throw resolverFailure;
          },
          expected: resolverFailure,
        },
        {
          reservationFor: () => undefined as unknown as ChildWorkerReservation,
          expected: TypeError,
        },
        { reservationFor: () => forged, expected: TypeError },
      ];

      for (const { reservationFor, expected } of cases) {
        const capacity = new ChildWorkerCapacity(1);
        const capacityRun = vi.spyOn(capacity, "run");
        const modules = vi.fn(() => ({ "entry.js": "export default 0" }));
        const dispatch = vi.fn(async () => exited());
        const createHost = vi.fn(() => ({ host: {}, close() {} }));
        const program = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules },
          capacity,
          reservationFor,
          dispatch: { run: dispatch },
          createHost,
        });

        if (expected === TypeError) {
          await expect(program.run(fixture.context)).rejects.toBeInstanceOf(TypeError);
        } else {
          await expect(program.run(fixture.context)).rejects.toBe(expected);
        }
        expect(capacityRun).not.toHaveBeenCalled();
        expect(modules).not.toHaveBeenCalled();
        expect(createHost).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(forged.run).not.toHaveBeenCalled();
      }
    }));

  it("releases after module loading fails before host creation", () =>
    withFixture(async (fixture) => {
      const capacity = new ChildWorkerCapacity(1);
      const reservation = await capacity.reserve(fixture.context.signal, {
        processes: fixture.context.processes,
        process: fixture.context.identity.handle,
      });
      const failure = new Error("module source unavailable");
      const modules = vi.fn(async () => {
        throw failure;
      });
      const dispatch = vi.fn(async () => exited());
      const createHost = vi.fn(() => ({ host: {}, close() {} }));
      const program = createChildWorkerProgram({
        executable: "/bin/tool",
        code: { mainModule: "entry.js", modules },
        capacity,
        reservationFor: () => reservation,
        dispatch: { run: dispatch },
        createHost,
      });

      await expect(program.run(fixture.context)).rejects.toBe(failure);
      expect(modules).toHaveBeenCalledOnce();
      expect(createHost).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(capacity.active).toBe(0);
    }));

  it.effect("holds the reservation through descendants, host close, and unconfirmed stop ACK", () =>
    Effect.gen(function* () {
      const fixture = childBusyboxFixture();
      try {
        const capacity = new ChildWorkerCapacity(1);
        const reservation = yield* Effect.promise(() =>
          capacity.reserve(fixture.context.signal, {
            processes: fixture.context.processes,
            process: fixture.context.identity.handle,
          }),
        );
        const descendant = Promise.withResolvers<ReturnType<typeof exited>>();
        const exitedEarly = deferred<ReturnType<typeof exited>>();
        const closeStarted = deferred<void>();
        const closeGate = deferred<void>();
        const closeFinished = deferred<void>();
        const stopWaitStarted = deferred<void>();
        const stopped = deferred<void>();
        // The termination read marks the point after host.close and before the stop ACK wait.
        class ObservedDispatchError extends ChildWorkerDispatchError {
          override get termination() {
            const termination = super.termination;
            if (termination.kind === "unconfirmed") stopWaitStarted.resolve(undefined);
            return termination;
          }
        }
        const failure = new ObservedDispatchError("RPC disconnected", {
          kind: "unconfirmed",
          stopped: stopped.promise,
        });
        const program = createChildWorkerProgram({
          executable: "/bin/tool",
          code: { mainModule: "entry.js", modules: {} },
          capacity,
          reservationFor: () => reservation,
          dispatch: { run: () => descendant.promise },
          createHost: () => ({
            host: {},
            exited: exitedEarly.promise,
            async close() {
              closeStarted.resolve(undefined);
              await closeGate.promise;
              closeFinished.resolve(undefined);
            },
          }),
        });

        const result = program.run(fixture.context);
        const status = exited(17);
        exitedEarly.resolve(status);
        yield* Effect.promise(() => expect(result).resolves.toEqual(status));
        expect(capacity.active).toBe(1);

        const draining = expect(program.drain()).rejects.toBe(failure);
        descendant.reject(failure);
        yield* Effect.promise(() => closeStarted.promise);
        expect(capacity.active).toBe(capacity.limit);
        closeGate.resolve(undefined);
        yield* Effect.promise(() => closeFinished.promise);
        yield* Effect.promise(() => stopWaitStarted.promise);
        // Let an early release's promise-finally chain run before probing capacity.
        yield* Effect.yieldNow;
        expect(capacity.active).toBe(capacity.limit);

        stopped.resolve(undefined);
        const next = capacity.acquire(fixture.context.signal, undefined);
        const permit = yield* Effect.promise(() => next);
        permit.release();
        yield* Effect.promise(() => draining);
        expect(capacity.active).toBe(0);
        expect(yield* Effect.promise(() => result)).toEqual(status);
      } finally {
        yield* Effect.promise(() => fixture.close());
      }
    }),
  );
});
