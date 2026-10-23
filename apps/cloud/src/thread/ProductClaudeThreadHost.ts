import type { OrchestrationV2Command, OrchestrationV2ThreadLaunchInput } from "@t3tools/contracts";
import { OrchestrationV2CommandOutputError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";

import { HarnessError } from "../harness/Harness.ts";
import { ThreadObjectError, type Actor } from "./ThreadAccess.ts";
import { ThreadEngine, type ThreadSummary } from "./ThreadEngine.ts";
import { ThreadDirectory } from "./ThreadDirectory.ts";
import { Threads } from "./Threads.ts";
import * as StandaloneThread from "./StandaloneThread.ts";
import { MachineBackend } from "./runner/MachineBackend.ts";
import { ThreadRunner } from "./runner/ThreadRunner.ts";
import { createClaudeFacetHost, type ClaudeFacetHostOptions } from "./facet/ClaudeFacetHost.ts";
import { layerFacetMachineBackend, type FacetHostPort } from "./facet/FacetMachineBackend.ts";
import { makeThreadCommandObjectApi } from "./ThreadCommandApi.ts";

export type ProductClaudeThreadHostOptions<
  G,
  SqlError,
  SqlRequirements,
  PlatformError,
  PlatformRequirements,
> = ClaudeFacetHostOptions<G> & {
  readonly sql: Layer.Layer<SqlClient.SqlClient, SqlError, SqlRequirements>;
  readonly recordSummary?: (
    ownerId: string,
    summary: ThreadSummary,
  ) => Effect.Effect<void, HarnessError>;
} & (
    | {
        readonly platform: Layer.Layer<
          Exclude<StandaloneThread.PlatformServices, MachineBackend>,
          PlatformError,
          PlatformRequirements
        >;
        readonly continuationDispatch?: undefined;
      }
    | {
        readonly platform: Layer.Layer<
          Exclude<StandaloneThread.EnginePlatformServices, MachineBackend>,
          PlatformError,
          PlatformRequirements
        >;
        readonly continuationDispatch: Threads["Service"]["dispatch"];
      }
  );

export type ProductClaudeThreadMachine<G> = Pick<
  ClaudeFacetHostOptions<G>,
  "host" | "open" | "access"
>;

export type ProductClaudeThreadHostBinding<G> = Effect.Success<
  ReturnType<typeof createProductClaudeThreadHost<G, never, never, never, never>>
>;

const continuationThreads = (dispatch: Threads["Service"]["dispatch"]) => {
  const error = (operation: string) =>
    new ThreadObjectError({
      operation,
      cause: new Error("This local thread runtime only accepts user-routed continuations."),
    });
  const fail = <A>(operation: string): Effect.Effect<A, ThreadObjectError> =>
    Effect.fail(error(operation));
  const failStream = <A>(operation: string): Stream.Stream<A, ThreadObjectError> =>
    Stream.fail(error(operation));
  return Threads.of({
    syncAutomationAsk: () => fail("ask.syncAutomation"),
    answerAskAsAssistant: () => fail("ask.answerAsAssistant"),
    subscribePreparation: () => failStream("preparation.subscribe"),
    cancelPreparation: () => fail("preparation.cancel"),
    launch: () => fail("thread.launch"),
    dispatch,
    refreshRemoteWorkspace: () => fail("workspace.refreshRemote"),
    getWorkflowScript: () => fail("workflow.getScript"),
    stopWorkflow: () => fail("workflow.stop"),
    snapshot: () => fail("thread.snapshot"),
    history: () => fail("thread.history"),
    commandOutput: (_actor, input) =>
      Stream.fail(
        new OrchestrationV2CommandOutputError({
          threadId: input.threadId,
          message: "Command output is unavailable in the local thread runtime.",
        }),
      ),
    subscribe: () => failStream("thread.subscribe"),
  });
};

const failed = (message: string, cause?: unknown) =>
  new HarnessError({ operation: "events", message, ...(cause === undefined ? {} : { cause }) });

/** Owns a real Claude facet under the canonical Thread queue and generation lease. */
export const createProductClaudeThreadHost = <
  G,
  SqlError,
  SqlRequirements,
  PlatformError,
  PlatformRequirements,
>(
  options: ProductClaudeThreadHostOptions<
    G,
    SqlError,
    SqlRequirements,
    PlatformError,
    PlatformRequirements
  >,
) =>
  Effect.gen(function* () {
    const hostConsole = yield* Console.Console;
    const scope = yield* Scope.fork(yield* Scope.Scope);
    const broken = yield* Deferred.make<never, HarnessError>();
    const port = yield* Deferred.make<FacetHostPort>();
    const backend = layerFacetMachineBackend({
      ensure: (...args) => Effect.flatMap(Deferred.await(port), (host) => host.ensure(...args)),
      stop: (...args) => Effect.flatMap(Deferred.await(port), (host) => host.stop(...args)),
      inspect: (...args) => Effect.flatMap(Deferred.await(port), (host) => host.inspect(...args)),
    });
    const platform = Layer.mergeAll(
      options.platform,
      backend,
      Layer.succeed(Console.Console, hostConsole),
    );
    const runtimeLayer =
      options.continuationDispatch === undefined
        ? StandaloneThread.layer({
            threadId: options.threadId,
            sql: options.sql,
            platform,
          })
        : StandaloneThread.layerEngine({
            threadId: options.threadId,
            sql: options.sql,
            platform,
          }).pipe(
            Layer.provideMerge(
              Layer.succeed(Threads, continuationThreads(options.continuationDispatch)),
            ),
          );
    const runtime = yield* Layer.build(runtimeLayer).pipe(Scope.provide(scope));
    const threads = Context.get(runtime, Threads);
    const runner = Context.get(runtime, ThreadRunner);
    const engine = Context.get(runtime, ThreadEngine);
    const backends = Context.get(runtime, MachineBackend);
    let brokenError: HarnessError | undefined;
    const fail = (error: HarnessError) =>
      Effect.gen(function* () {
        brokenError ??= error;
        yield* Deferred.fail(broken, brokenError);
      });
    const host = yield* createClaudeFacetHost(options, fail).pipe(
      Effect.provide(runtime),
      Scope.provide(scope),
    );
    yield* Deferred.succeed(port, host);
    const lock = yield* Semaphore.make(1);
    let closed = false;
    let watching = false;
    const reconcile = lock.withPermits(1)(
      Effect.gen(function* () {
        if (closed) return;
        if (brokenError !== undefined) return yield* brokenError;
        const plan = yield* runner.reconcile;
        const backend = backends[plan.machineClass];
        if (plan.release !== null || plan.stop) yield* backend.stop(options.threadId);
        if (plan.ensure !== null) {
          const status = yield* backend.ensure({
            ...plan.ensure,
            threadId: options.threadId,
            machineClass: plan.machineClass,
          });
          yield* runner.machineReported({
            operation: "ensure",
            generation: plan.ensure.generation,
            runId: plan.runId,
            status,
          });
          if (status.actual === "running") yield* runner.ensured(plan.ensure.generation);
        }
        if (options.recordSummary !== undefined) {
          const pending = yield* engine.pendingSummary;
          if (pending !== null) {
            yield* options.recordSummary(pending.ownerUserId, pending.summary);
            yield* engine.acknowledgeSummary(pending.summary.revision);
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(failed("Could not reconcile the thread's facet.", cause)),
        ),
        Effect.tapError(fail),
      ),
    );
    const activate = Effect.gen(function* () {
      if (closed) return yield* failed("The product thread host is closed.");
      if (brokenError !== undefined) return yield* brokenError;
      if (!watching) {
        const actor = yield* options.actor;
        const changes = yield* engine
          .subscribe(actor, { threadId: options.threadId })
          .pipe(
            Effect.mapError((cause) => failed("Could not subscribe to the product thread.", cause)),
          );
        watching = true;
        yield* changes.pipe(
          Stream.runForEach(() => reconcile),
          Effect.catch(fail),
          Effect.forkIn(scope),
        );
      }
      yield* reconcile;
    });
    const check = Effect.suspend(() =>
      closed
        ? Effect.fail(failed("The product thread host is closed."))
        : brokenError !== undefined
          ? Effect.fail(brokenError)
          : Effect.void,
    );
    const launch = (actor: Actor, input: OrchestrationV2ThreadLaunchInput) =>
      check.pipe(
        Effect.andThen(threads.launch(actor, input)),
        Effect.tap(() => activate),
        Effect.provideService(Console.Console, hostConsole),
      );
    const dispatch = (actor: Actor, command: OrchestrationV2Command) =>
      check.pipe(
        Effect.andThen(threads.dispatch(actor, command)),
        Effect.tap(() => activate),
        Effect.provideService(Console.Console, hostConsole),
      );
    const afterChange = () => Effect.runPromise(activate.pipe(Effect.provide(runtime)));
    const api = makeThreadCommandObjectApi(
      <A, E>(effect: Effect.Effect<A, E, ThreadEngine>) =>
        Effect.runPromise(effect.pipe(Effect.provide(runtime))),
      afterChange,
    );
    const dispose = Effect.gen(function* () {
      closed = true;
      if (brokenError === undefined) {
        brokenError = failed("The product thread host is closed.");
        yield* Deferred.fail(broken, brokenError);
      }
      yield* host.dispose.pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
    });
    yield* Effect.addFinalizer(() => dispose.pipe(Effect.orDie));
    return {
      api,
      directory: Context.get(runtime, ThreadDirectory),
      engine,
      threads: {
        ...threads,
        launch,
        dispatch,
        // The native personality replaces realm globals; host logs cannot enter SDK stdout.
        subscribe: (...args: Parameters<typeof threads.subscribe>) =>
          threads.subscribe(...args).pipe(Stream.provideService(Console.Console, hostConsole)),
        commandOutput: (...args: Parameters<typeof threads.commandOutput>) =>
          threads.commandOutput(...args).pipe(Stream.provideService(Console.Console, hostConsole)),
      },
      afterChange,
      launch,
      dispatch,
      host: Effect.raceFirst(host.host, Deferred.await(broken)),
      failure: Deferred.await(broken),
      dispose,
    };
  });
