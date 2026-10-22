import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { Computer } from "../../computer/Computer.ts";
import type { ComputerBindings } from "../../computer/OpenComputer.ts";
import { HarnessError, type HarnessSession, type HarnessOpenInput } from "../Harness.ts";
import { validateOpen } from "../adapter/checkpoint.ts";
import { createHarnessSessionFacet } from "../HarnessSessionFacet.ts";
import type { LoadedHarnessRelease } from "../HarnessReleaseLoader.ts";
import { makeFacetLifetime } from "../facet/lifetime.ts";
import { createBootState, snapshotOpen } from "./boot.ts";
import type {
  HarnessHostOptions,
  HarnessHostSession,
  HarnessSessionHost,
  NativeHostBinding,
  TurnAccess,
} from "./contracts.ts";
import { createMcpRoutes, validateConnections } from "./mcp.ts";
import { fingerprint, type SeedCatalog } from "./seed.ts";
import { createHostSession, sameAccess, snapshotAccess } from "./session.ts";
import { closeFailedHostStart } from "./failure.ts";
import { createHostStorage } from "./storage.ts";

export const createHostLifecycle = <G>(
  options: Omit<HarnessHostOptions<G>, "release" | "programs">,
  loaded: LoadedHarnessRelease,
  catalog: SeedCatalog,
  closeOwner: Effect.Effect<void>,
): Effect.Effect<HarnessSessionHost<G>, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const owner = yield* makeFacetLifetime(yield* Scope.Scope);
    return yield* Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => createHostStorage(options.files, options.threadId),
          catch: () =>
            new HarnessError({
              operation: "open",
              message: "Canonical Harness storage could not be opened.",
            }),
        }),
        (value) =>
          Effect.sync(() => value.dispose()).pipe(
            Effect.catchCause((cause) =>
              Effect.die(
                new HarnessError({
                  operation: "dispose",
                  message: "Harness files cleanup failed.",
                  cause,
                }),
              ),
            ),
          ),
      );
      // Computer resources close after the facet, even though they are acquired lazily.
      let poisoned = false;
      const computerScope = yield* Scope.make();
      const acquisitionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() =>
        // Joining acquisitions keeps their late finalizers inside the live Computer/file scopes.
        Scope.close(acquisitionScope, Exit.void).pipe(
          Effect.ensuring(Scope.close(computerScope, Exit.void)),
          Effect.catchCause((cause) => {
            poisoned = true;
            return Effect.die(
              new HarnessError({
                operation: "dispose",
                message: "Harness Computer cleanup failed.",
                cause,
              }),
            );
          }),
        ),
      );
      const lock = yield* Semaphore.make(1);
      const boot = createBootState(storage, catalog, options.threadId);
      const routes = createMcpRoutes(options.executor, owner.signal);
      let ports: Omit<ComputerBindings, "files"> | undefined;
      const computer = Object.freeze<Computer>({
        threadId: options.threadId,
        files: storage.files,
        async exec(command, signal, requester) {
          if (ports === undefined)
            throw new HarnessError({
              operation: "open",
              message: "Computer ports are unavailable.",
            });
          return ports.exec(command, signal, requester);
        },
        async port(port, signal) {
          if (ports === undefined)
            throw new HarnessError({
              operation: "open",
              message: "Computer ports are unavailable.",
            });
          return ports.port(port, signal);
        },
        async save(signal) {
          if (ports === undefined)
            throw new HarnessError({
              operation: "open",
              message: "Computer ports are unavailable.",
            });
          return ports.save(signal);
        },
      });
      type Attempt = {
        readonly hash: string;
        readonly id: string;
        readonly initialAccess: TurnAccess<G> | undefined;
        session?: HarnessHostSession<G>;
        ended: boolean;
      };
      let occupied: Attempt | undefined;
      const attempts = new Map<string, Attempt>();
      let native:
        | {
            binding: NativeHostBinding;
            session: Effect.Success<ReturnType<typeof createHostSession<G>>>;
            signal: AbortSignal;
          }
        | undefined;
      const check = () => {
        if (owner.signal.aborted || poisoned)
          throw new Error("Harness host is closed or cleanup failed");
        boot.check();
      };
      const facet = yield* createHarnessSessionFacet({
        threadId: options.threadId,
        release: loaded.plan.release,
        modelTransport: (request) =>
          new URL(request.url).origin === routes.origin
            ? routes.fetch(request)
            : options.modelTransport(request),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
        computer: {
          open: () => ({
            open: async (threadId, signal) => {
              if (
                signal.aborted ||
                owner.signal.aborted ||
                ports === undefined ||
                threadId !== options.threadId
              )
                throw new HarnessError({
                  operation: "open",
                  message: "Harness Computer is unavailable.",
                });
              return computer;
            },
          }),
        },
        buildRuntime: (input, signal) =>
          Effect.gen(function* () {
            const attempt = occupied;
            if (attempt === undefined)
              return yield* Effect.fail(
                new HarnessError({
                  operation: "open",
                  message: "Harness boot attempt is unavailable.",
                }),
              );
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() =>
              Scope.close(scope, Exit.void).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) poisoned = true;
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.die(
                    new HarnessError({
                      operation: "dispose",
                      message: "Harness runtime cleanup failed.",
                      cause,
                    }),
                  ),
                ),
              ),
            );
            const sessionRoutes = routes.session(signal);
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => sessionRoutes.close()),
            );
            const session = yield* createHostSession(sessionRoutes);
            const binding = yield* Effect.suspend(() =>
              options.buildRuntime({
                harness: input,
                loaded,
                bootAttemptId: attempt.id,
                mcp: { origin: routes.origin, fetch: routes.fetch },
                signal,
              }),
            ).pipe(Scope.provide(scope));
            if (
              typeof binding.configureMcp !== "function" ||
              typeof binding.factory?.open !== "function"
            )
              return yield* Effect.fail(
                new HarnessError({
                  operation: "open",
                  message: "Required Harness runtime ports are unavailable.",
                }),
              );
            native = { binding, session, signal };
            return {
              open: (harness: HarnessOpenInput) =>
                Effect.gen(function* () {
                  const runtime = yield* binding.factory
                    .open({ ...harness, loadedRelease: loaded })
                    .pipe(Scope.provide(scope));
                  if (harness.checkpoint !== undefined) {
                    const access = attempt.initialAccess;
                    if (access === undefined)
                      return yield* Effect.fail(
                        new HarnessError({
                          operation: "open",
                          message: "Checkpoint access is unavailable.",
                        }),
                      );
                    yield* session.prepareInitial(binding, harness, access, signal);
                  }
                  return session.decorate(runtime);
                }),
            };
          }),
      });
      const dispose = yield* Effect.cached(
        owner.close.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new HarnessError({
                operation: "dispose",
                message: "Harness host cleanup failed.",
                cause,
              }),
            ),
          ),
          Effect.uninterruptible,
        ),
      );
      const failStart = (
        bootAttemptId: string,
        operation: "open" | "turn",
        cause: Cause.Cause<unknown>,
        cleanup: Effect.Effect<void, HarnessError>,
        runId?: string,
      ) =>
        closeFailedHostStart({
          database: storage.database,
          bootAttemptId,
          runId,
          operation,
          cause,
          startup: () => native?.binding.startup?.(),
          cleanup: cleanup.pipe(
            Effect.ensuring(Effect.orDie(dispose)),
            Effect.ensuring(closeOwner),
          ),
        });
      return {
        threadId: options.threadId,
        release: facet.release,
        dispose,
        seed: (stage) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              yield* Effect.try({
                try: check,
                catch: () =>
                  new HarnessError({
                    operation: "open",
                    message: "Harness host requires reconstruction.",
                  }),
              });
              if (occupied !== undefined)
                return yield* Effect.fail(
                  new HarnessError({
                    operation: "open",
                    message: "A Harness session owns these files.",
                  }),
                );
              yield* Effect.tryPromise({
                try: (signal) => boot.seed(stage, AbortSignal.any([signal, owner.signal])),
                catch: () =>
                  new HarnessError({
                    operation: "open",
                    message: "Harness seed failed; reconstruct before retrying.",
                  }),
              });
            }),
          ),
        open: (supplied) =>
          Effect.gen(function* () {
            const { input, initialAccess } = yield* Effect.try({
              try: () => {
                const { bootAttemptId, session, checkpoint, initialAccess: access } = supplied;
                if (
                  (checkpoint === undefined) !== (access === undefined) ||
                  (access !== undefined &&
                    (!(access.signal instanceof AbortSignal) || access.signal.aborted))
                )
                  throw new Error("Invalid checkpoint access");
                const initialAccess = access === undefined ? undefined : snapshotAccess(access);
                if (initialAccess !== undefined) validateConnections(initialAccess.connections);
                return {
                  input: snapshotOpen({
                    bootAttemptId,
                    session,
                    ...(checkpoint === undefined ? {} : { checkpoint }),
                  }),
                  initialAccess,
                };
              },
              catch: () =>
                new HarnessError({
                  operation: "open",
                  message: "Harness open input is invalid.",
                }),
            });
            const hash = yield* Effect.tryPromise({
              try: () => fingerprint({ session: input.session, checkpoint: input.checkpoint }),
              catch: () =>
                new HarnessError({
                  operation: "open",
                  message: "Harness open input is invalid.",
                }),
            });
            return yield* lock.withPermits(1)(
              Effect.gen(function* () {
                yield* Effect.try({
                  try: check,
                  catch: () =>
                    new HarnessError({
                      operation: "open",
                      message: "Harness host requires reconstruction.",
                    }),
                });
                const prior = attempts.get(input.bootAttemptId);
                if (initialAccess?.signal.aborted)
                  return yield* Effect.fail(
                    new HarnessError({ operation: "open", message: "Checkpoint access ended." }),
                  );
                if (prior !== undefined) {
                  if (
                    prior.hash === hash &&
                    sameAccess(prior.initialAccess, initialAccess) &&
                    !prior.ended &&
                    prior.session !== undefined
                  )
                    return prior.session;
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "open",
                      message: "Harness boot attempt was already consumed or conflicts.",
                    }),
                  );
                }
                if (occupied !== undefined || input.session.threadId !== options.threadId)
                  return yield* Effect.fail(
                    new HarnessError({
                      operation: "open",
                      message: "Harness session ownership conflicts.",
                    }),
                  );
                yield* validateOpen({
                  ...input,
                  computer,
                  release: facet.release,
                  modelTransport: options.modelTransport,
                }).pipe(
                  Effect.mapError(
                    () =>
                      new HarnessError({
                        operation: "open",
                        message: "Harness session or checkpoint identity is invalid.",
                      }),
                  ),
                );
                yield* Effect.tryPromise({
                  try: (signal) =>
                    boot.claim(
                      input.bootAttemptId,
                      hash,
                      AbortSignal.any([
                        signal,
                        owner.signal,
                        ...(initialAccess === undefined ? [] : [initialAccess.signal]),
                      ]),
                    ),
                  catch: () =>
                    new HarnessError({
                      operation: "open",
                      message: "Harness boot validation or admission failed.",
                    }),
                });
                const attempt: Attempt = {
                  hash,
                  id: input.bootAttemptId,
                  initialAccess,
                  ended: false,
                };
                attempts.set(attempt.id, attempt);
                occupied = attempt;
                let raw: HarnessSession | undefined;
                let startupFailure: HarnessError | undefined;
                return yield* Effect.gen(function* () {
                  if (initialAccess?.signal.aborted)
                    return yield* Effect.fail(
                      new HarnessError({ operation: "open", message: "Checkpoint access ended." }),
                    );
                  if (ports === undefined) {
                    yield* Effect.uninterruptibleMask((restore) =>
                      Effect.gen(function* () {
                        const binding = yield* makeFacetLifetime(computerScope);
                        // Keep cleanup failures observable at owner shutdown after caller cleanup.
                        yield* Scope.addFinalizer(computerScope, binding.close);
                        const acquisition = yield* Effect.suspend(() =>
                          options.bindComputer({
                            threadId: options.threadId,
                            files: storage.files,
                            persistence: storage.persistence,
                            signal: AbortSignal.any([owner.signal, binding.signal]),
                          }),
                        ).pipe(
                          Scope.provide(binding.scope),
                          Effect.forkIn(acquisitionScope, { uninterruptible: false }),
                        );
                        const acquired = yield* restore(Fiber.join(acquisition)).pipe(
                          Effect.onExit((exit) =>
                            Exit.isSuccess(exit)
                              ? Effect.void
                              : Effect.gen(function* () {
                                  poisoned = true;
                                  binding.abort();
                                  // Admission remains held until acquisition and partial resources drain.
                                  yield* Fiber.interrupt(acquisition).pipe(
                                    Effect.ensuring(binding.close),
                                  );
                                }),
                          ),
                        );
                        ports = acquired;
                      }),
                    );
                  }
                  if (initialAccess?.signal.aborted)
                    return yield* Effect.fail(
                      new HarnessError({ operation: "open", message: "Checkpoint access ended." }),
                    );
                  raw = yield* facet.open(input);
                  if (initialAccess?.signal.aborted)
                    return yield* Effect.fail(
                      new HarnessError({ operation: "open", message: "Checkpoint access ended." }),
                    );
                  const built = native;
                  if (built === undefined)
                    return yield* Effect.fail(
                      new HarnessError({
                        operation: "open",
                        message: "Harness session ports are unavailable.",
                      }),
                    );
                  attempt.session = built.session.wrap(
                    raw,
                    built.binding,
                    {
                      ...input,
                      release: facet.release,
                      computer,
                      modelTransport: options.modelTransport,
                    },
                    built.signal,
                    (ok) => {
                      attempt.ended = true;
                      delete attempt.session;
                      if (occupied === attempt) occupied = undefined;
                      if (!ok) poisoned = true;
                    },
                    (cause, runId, cleanup) => failStart(attempt.id, "turn", cause, cleanup, runId),
                  );
                  return attempt.session;
                }).pipe(
                  Effect.onExit((exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : Effect.gen(function* () {
                          attempt.ended = true;
                          if (occupied === attempt) occupied = undefined;
                          startupFailure = yield* failStart(
                            attempt.id,
                            "open",
                            exit.cause,
                            raw?.dispose ?? Effect.void,
                          );
                        }),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.fail(
                      startupFailure ??
                        new HarnessError({
                          operation: "open",
                          message: "Harness native acquisition failed.",
                          cause,
                        }),
                    ),
                  ),
                );
              }),
            );
          }),
      } satisfies HarnessSessionHost<G>;
    }).pipe(
      Scope.provide(owner.scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? owner.close : Effect.void)),
    );
  });
