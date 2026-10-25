import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import type { ComputerBindings } from "../../computer/OpenComputer.ts";
import { fixture } from "../adapter/tests/fixture.ts";
import type { HarnessOpenInput } from "../Harness.ts";
import { type HarnessSessionFacetOptions } from "../HarnessSessionFacet.ts";

export const sessionFacetFixture = Effect.gen(function* () {
  const adapter = yield* fixture;
  const files = yield* Effect.acquireRelease(
    Effect.sync(() => new KernelFileSystem({ mounts: [] })),
    (files) => Effect.sync(() => files.dispose()),
  );
  const bindings: ComputerBindings = {
    files,
    exec: adapter.input.computer.exec,
    port: adapter.input.computer.port,
    save: adapter.input.computer.save,
  };
  const ownerSignals: AbortSignal[] = [];
  const sessionSignals: AbortSignal[] = [];
  const built: HarnessOpenInput[] = [];
  const cleaned: HarnessOpenInput[] = [];
  const buildRuntime: NonNullable<HarnessSessionFacetOptions["buildRuntime"]> = (input, signal) =>
    Effect.gen(function* () {
      built.push(input);
      sessionSignals.push(signal);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          cleaned.push(input);
        }),
      );
      return { open: () => Effect.succeed(adapter.runtime) };
    });
  const options: HarnessSessionFacetOptions = {
    threadId: adapter.input.session.threadId,
    release: adapter.input.release,
    computer: {
      bind: async (_thread, signal) => {
        ownerSignals.push(signal);
        return bindings;
      },
    },
    buildRuntime,
    modelTransport: adapter.input.modelTransport,
    hooks: adapter.input.hooks,
  };
  return { adapter, bindings, options, buildRuntime, built, cleaned, ownerSignals, sessionSignals };
});

/** The normal acquireRelease mask waits for native cancellation, with a rescue gate for red tests. */
export function nativeAcquisition(
  buildRuntime: NonNullable<HarnessSessionFacetOptions["buildRuntime"]>,
  release: Effect.Effect<void> = Effect.void,
) {
  const acquiring = Promise.withResolvers<AbortSignal>();
  const ready = Promise.withResolvers<void>();
  let released = 0;
  return {
    acquiring: Effect.promise(() => acquiring.promise),
    complete: Effect.sync(() => ready.resolve()),
    get released() {
      return released;
    },
    buildRuntime: (input: HarnessOpenInput, signal: AbortSignal) =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          const abort = () => ready.resolve();
          signal.addEventListener("abort", abort, { once: true });
          acquiring.resolve(signal);
          if (signal.aborted) abort();
          await ready.promise;
          return { abort };
        }),
        ({ abort }) =>
          Effect.sync(() => {
            signal.removeEventListener("abort", abort);
            released++;
          }).pipe(Effect.andThen(release)),
      ).pipe(Effect.andThen(buildRuntime(input, signal))),
  };
}

/** Interrupt exactly when the open worker is scheduled, before its caller can install a join. */
export function forkBoundaryScheduler() {
  const base = new Scheduler.MixedScheduler("sync");
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  let interrupted = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => base.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = base.makeDispatcher();
      return {
        scheduleTask: (task, priority) => {
          dispatcher.scheduleTask(task, priority);
          if (caller !== undefined && !interrupted) {
            interrupted = true;
            caller.interruptUnsafe();
          }
        },
        flush: () => dispatcher.flush(),
      };
    },
  };
  return {
    scheduler,
    arm: (fiber: Fiber.Fiber<unknown, unknown>) => {
      caller = fiber;
    },
    get interrupted() {
      return interrupted;
    },
  };
}

/** Interrupt a completed worker before its session reaches the caller. */
export function handoffBoundaryScheduler() {
  const base = new Scheduler.MixedScheduler("sync");
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  let worker: Fiber.Fiber<unknown, unknown> | undefined;
  let interrupted = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      const exit = worker?.pollUnsafe();
      // The scheduler API exposes the runtime fiber; its flag pins this otherwise invisible boundary.
      if (
        !interrupted &&
        fiber === caller &&
        exit !== undefined &&
        Exit.isSuccess(exit) &&
        "interruptible" in fiber &&
        (fiber.interruptible === false || runtimeStack(fiber).some(isAsyncFinalizer))
      ) {
        interrupted = true;
        fiber.interruptUnsafe();
        return true;
      }
      return base.shouldYield(fiber);
    },
    makeDispatcher: () => base.makeDispatcher(),
  };
  return {
    scheduler,
    get interrupted() {
      return interrupted;
    },
    arm: (fiber: Fiber.Fiber<unknown, unknown>) => {
      caller = fiber;
    },
    worker: (fiber: Fiber.Fiber<unknown, unknown>) => {
      worker = fiber;
    },
  };
}

/** Hold the caller's handoff while owner shutdown settles native acquisition. */
export function ownerForkBoundaryScheduler() {
  const base = new Scheduler.MixedScheduler("sync");
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  let dispatched = false;
  let forked = false;
  let paused = false;
  let resume: (() => void) | undefined;
  let current: Fiber.Fiber<unknown, unknown> | undefined;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      current = fiber;
      if (caller !== undefined && fiber !== caller) forked = true;
      if (fiber === caller && forked && !paused) {
        paused = true;
        return true;
      }
      return base.shouldYield(fiber);
    },
    makeDispatcher: () => {
      const dispatcher = base.makeDispatcher();
      const ownsCaller = current === caller && caller !== undefined && !dispatched;
      if (ownsCaller) dispatched = true;
      return {
        scheduleTask: (task, priority) => {
          if (ownsCaller && paused && resume === undefined) resume = task;
          else dispatcher.scheduleTask(task, priority);
        },
        flush: () => dispatcher.flush(),
      };
    },
  };
  return {
    scheduler,
    arm: (fiber: Fiber.Fiber<unknown, unknown>) => {
      caller = fiber;
    },
    resume: Effect.sync(() => {
      if (resume === undefined) throw new Error("Caller did not pause at fork");
      resume();
    }),
  };
}

function runtimeStack(fiber: Fiber.Fiber<unknown, unknown>): readonly unknown[] {
  if (!("_stack" in fiber) || !Array.isArray(fiber._stack))
    throw new Error("Effect runtime stack is unavailable");
  return fiber._stack;
}

function isAsyncFinalizer(frame: unknown): boolean {
  return (
    typeof frame === "object" &&
    frame !== null &&
    "~effect/Effect/identifier" in frame &&
    frame["~effect/Effect/identifier"] === "AsyncFinalizer"
  );
}

function isMaskObserver(frame: unknown): frame is { readonly effect: object } {
  if (
    typeof frame !== "object" ||
    frame === null ||
    !("~effect/Effect/identifier" in frame) ||
    frame["~effect/Effect/identifier"] !== "OnExit" ||
    !("effect" in frame)
  )
    return false;
  const effect = frame.effect;
  return (
    typeof effect === "object" &&
    effect !== null &&
    "~effect/Effect/identifier" in effect &&
    effect["~effect/Effect/identifier"] === "WithFiber"
  );
}

/** Detect a masked observer handoff, or cancel while callback registration still owns the worker. */
export function observerBoundaryScheduler(
  beforeBody: boolean,
  reached: () => void = () => undefined,
) {
  const base = new Scheduler.MixedScheduler("sync");
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  let worker: Fiber.Fiber<unknown, unknown> | undefined;
  let observer: unknown;
  let interrupted = false;
  let delivered = false;
  let current: Fiber.Fiber<unknown, unknown> | undefined;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      current = fiber;
      if (fiber !== caller || delivered || interrupted) return base.shouldYield(fiber);
      const stack = runtimeStack(fiber);
      const top = stack.at(-1);
      if (observer === undefined && (isMaskObserver(top) || isAsyncFinalizer(top))) observer = top;
      const exit = worker?.pollUnsafe();
      const interrupt = beforeBody
        ? observer !== undefined && "interruptible" in fiber && fiber.interruptible === true
        : observer !== undefined &&
          exit !== undefined &&
          Exit.isSuccess(exit) &&
          !stack.includes(observer) &&
          "interruptible" in fiber &&
          fiber.interruptible === false;
      if (interrupt) {
        interrupted = true;
        fiber.interruptUnsafe();
        reached();
        return true;
      }
      return base.shouldYield(fiber);
    },
    makeDispatcher: () => {
      const dispatcher = base.makeDispatcher();
      return {
        scheduleTask: (task, priority) => {
          // Registration schedules the worker before its native body can begin.
          if (beforeBody && caller !== undefined && current !== caller && !interrupted) {
            observer = task;
            interrupted = true;
            caller.interruptUnsafe();
            reached();
          }
          dispatcher.scheduleTask(task, priority);
        },
        flush: () => dispatcher.flush(),
      };
    },
  };
  return {
    scheduler,
    arm: (fiber: Fiber.Fiber<unknown, unknown>) => {
      caller = fiber;
    },
    worker: (fiber: Fiber.Fiber<unknown, unknown>) => {
      worker = fiber;
    },
    delivered: Effect.sync(() => {
      delivered = true;
    }),
    get captured() {
      return observer !== undefined;
    },
    get interrupted() {
      return interrupted;
    },
  };
}

/** Cancel the caller after the worker has consumed its successful construction cleanup handler. */
export function workerHandoffBoundaryScheduler() {
  const base = new Scheduler.MixedScheduler("sync");
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  let worker: Fiber.Fiber<unknown, unknown> | undefined;
  let observer: unknown;
  let interrupted = false;
  const scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    shouldYield: (fiber) => {
      if (
        !interrupted &&
        fiber === worker &&
        observer !== undefined &&
        !runtimeStack(fiber).includes(observer) &&
        "interruptible" in fiber &&
        fiber.interruptible === false &&
        caller !== undefined
      ) {
        interrupted = true;
        caller.interruptUnsafe();
        return true;
      }
      return base.shouldYield(fiber);
    },
    makeDispatcher: () => base.makeDispatcher(),
  };
  return {
    scheduler,
    arm: (fiber: Fiber.Fiber<unknown, unknown>) => {
      caller = fiber;
    },
    worker: (fiber: Fiber.Fiber<unknown, unknown>) => {
      worker = fiber;
      observer = runtimeStack(fiber).findLast(isMaskObserver);
      if (observer === undefined) throw new Error("Worker construction observer is unavailable");
    },
    get interrupted() {
      return interrupted;
    },
    get workerExit() {
      return worker?.pollUnsafe();
    },
  };
}
