import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { Computer, ComputerOpenPort } from "../computer/Computer.ts";
import { createComputerFactory, type ComputerBindings } from "../computer/OpenComputer.ts";
import * as AdapterHarness from "./AdapterHarness.ts";
import {
  HarnessError,
  type HarnessOpenInput,
  type HarnessRelease,
  type HarnessSession,
} from "./Harness.ts";
import { validateOpen } from "./adapter/checkpoint.ts";
import { makeFacetLifetime } from "./facet/lifetime.ts";
import { makeFacetOpenings } from "./facet/opening.ts";

export type HarnessFacetComputer =
  | { readonly bind: (threadId: string, ownerSignal: AbortSignal) => Promise<ComputerBindings> }
  | { readonly open: (ownerSignal: AbortSignal) => ComputerOpenPort };

export interface HarnessSessionFacetOptions {
  readonly threadId: string;
  readonly release: HarnessRelease;
  readonly computer?: HarnessFacetComputer;
  /** The host supplies its verified native module builder and registers cleanup in this Scope. */
  readonly buildRuntime?: (
    input: HarnessOpenInput,
    signal: AbortSignal,
  ) => Effect.Effect<AdapterHarness.AdapterRuntimeFactory["Service"], HarnessError, Scope.Scope>;
  readonly modelTransport: HarnessOpenInput["modelTransport"];
  readonly hooks?: HarnessOpenInput["hooks"];
}

export interface HarnessSessionFacet {
  readonly threadId: string;
  readonly release: HarnessRelease;
  readonly open: (
    input: Pick<HarnessOpenInput, "session" | "checkpoint">,
  ) => Effect.Effect<HarnessSession, HarnessError>;
  readonly dispose: Effect.Effect<void, HarnessError>;
}

/** Retain one facet in the thread's session host, under that host's lifetime Scope. */
export const createHarnessSessionFacet = (
  options: HarnessSessionFacetOptions,
): Effect.Effect<HarnessSessionFacet, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const { computer: binding, buildRuntime } = options;
    if (!options.threadId)
      return yield* Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Harness facet requires a thread identity.",
        }),
      );
    if (binding === undefined)
      return yield* Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Harness Computer binding is unavailable.",
        }),
      );
    if (buildRuntime === undefined)
      return yield* Effect.fail(
        new HarnessError({
          operation: "open",
          message: "Harness native runtime builder is unavailable.",
        }),
      );
    const release = Object.freeze({
      ...options.release,
      modules: Object.freeze(
        Object.fromEntries(
          Object.entries(options.release.modules).map(([name, module]) => [
            name,
            Object.freeze({ ...module }),
          ]),
        ),
      ),
    });
    const openings = makeFacetOpenings();
    const owner = yield* makeFacetLifetime(yield* Scope.Scope, undefined, openings.close);
    const ownerScope = owner.scope;
    return yield* Effect.gen(function* () {
      const computerOpen = yield* Effect.try({
        try: () =>
          "bind" in binding
            ? createComputerFactory(binding.bind, owner.signal)
            : binding.open(owner.signal),
        catch: (cause) =>
          new HarnessError({
            operation: "open",
            message: "Harness Computer opener failed.",
            cause,
          }),
      });
      const lock = yield* Semaphore.make(1);
      let computer: Computer | undefined;
      let files: Computer["files"] | undefined;
      let occupied = false;
      let cleanupFailure: HarnessError | undefined;
      const closeOwner = yield* Effect.cached(
        owner.close.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new HarnessError({
                operation: "dispose",
                message: "Harness facet cleanup failed.",
                cause,
              }),
            ),
          ),
          Effect.uninterruptible,
        ),
      );
      const open: HarnessSessionFacet["open"] = (supplied) =>
        Effect.suspend(() => {
          if (owner.signal.aborted)
            return Effect.fail(
              new HarnessError({
                operation: "open",
                message: "Harness facet is disposed.",
              }),
            );
          return openings.open(owner, (register) =>
            lock.withPermits(1)(
              Effect.gen(function* () {
                if (owner.signal.aborted)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "open",
                      message: "Harness facet is disposed.",
                    }),
                  );
                if (supplied.session.threadId !== options.threadId)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "open",
                      message: "Harness facet belongs to another thread.",
                    }),
                  );
                if (cleanupFailure !== undefined) return yield* Effect.fail(cleanupFailure);
                if (occupied)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "open",
                      message: "Harness facet already owns a session.",
                    }),
                  );
                const lifetime = yield* makeFacetLifetime(ownerScope, (exit) =>
                  Effect.sync(() => {
                    if (Exit.isSuccess(exit)) occupied = false;
                    else
                      cleanupFailure ??= new HarnessError({
                        operation: "open",
                        message: "Harness session cleanup failed; facet cannot reopen.",
                        cause: exit.cause,
                      });
                  }),
                );
                register(lifetime);
                const sessionScope = lifetime.scope;
                return yield* Effect.gen(function* () {
                  occupied = true;
                  const opened = yield* Effect.tryPromise({
                    try: (signal) => computerOpen.open(options.threadId, signal),
                    catch: (cause) =>
                      new HarnessError({
                        operation: "open",
                        message: "Harness Computer could not be opened.",
                        cause,
                      }),
                  });
                  if (
                    opened.threadId !== options.threadId ||
                    (computer !== undefined && (opened !== computer || opened.files !== files))
                  )
                    return yield* Effect.fail(
                      new HarnessError({
                        operation: "open",
                        message: "Harness Computer identity changed.",
                      }),
                    );
                  computer = opened;
                  files = opened.files;
                  const input = yield* validateOpen({
                    ...supplied,
                    release,
                    computer,
                    modelTransport: options.modelTransport,
                    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
                  });
                  const factory = yield* buildRuntime(input, lifetime.signal);
                  if (typeof factory.open !== "function")
                    return yield* Effect.fail(
                      new HarnessError({
                        operation: "open",
                        message: "Harness runtime open capability is unavailable.",
                      }),
                    );
                  const harness = yield* AdapterHarness.AdapterHarness.pipe(
                    Effect.provide(
                      AdapterHarness.layer.pipe(
                        Layer.provide(Layer.succeed(AdapterHarness.AdapterRuntimeFactory, factory)),
                      ),
                    ),
                  );
                  const session = yield* harness.open(input);
                  const dispose = yield* Effect.cached(
                    lifetime.close.pipe(
                      Effect.catchCause((cause) =>
                        Effect.fail(
                          new HarnessError({
                            operation: "dispose",
                            message: "Harness session cleanup failed.",
                            cause,
                          }),
                        ),
                      ),
                      Effect.uninterruptible,
                    ),
                  );
                  return {
                    ...session,
                    get providerSession() {
                      return session.providerSession;
                    },
                    dispose,
                  };
                }).pipe(
                  Scope.provide(sessionScope),
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? lifetime.close : Effect.void)),
                );
              }),
            ),
          );
        });
      return { threadId: options.threadId, release, open, dispose: closeOwner };
    }).pipe(
      Scope.provide(ownerScope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? owner.close : Effect.void)),
    );
  });
