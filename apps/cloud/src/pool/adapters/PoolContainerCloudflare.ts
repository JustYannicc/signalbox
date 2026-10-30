import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { CLI_PROXY_API_PORT } from "../cliProxyApi.ts";
import { makeActivity } from "./poolContainerActivity.ts";
import { waitForModels } from "./poolContainerModelReadiness.ts";
import { withSignal } from "./poolContainerRequest.ts";
import {
  IDLE_TIMEOUT_MS,
  PoolContainer,
  PoolContainerAsleepError,
  PoolContainerOperationError,
  PoolContainerStoppedError,
  PoolContainerUnavailableError,
  READY_TIMEOUT_MS,
  STORE_HOST,
  type PoolContainerError,
  type StoreCredentials,
  waitUntilReady,
} from "../PoolContainer.ts";
import { makeReleaseObserver, unknownRelease } from "../CliProxyApiRuntime.ts";
import { POOL_STORE_BUCKET } from "../poolStore.ts";

/** Keeps a lost object from leaving its container alive forever. */
const BACKSTOP_TIMEOUT_MS = IDLE_TIMEOUT_MS + 60_000;

const containerEnv = (store: StoreCredentials): Record<string, string> => ({
  OBJECTSTORE_ENDPOINT: `http://${STORE_HOST}`,
  OBJECTSTORE_BUCKET: POOL_STORE_BUCKET,
  OBJECTSTORE_ACCESS_KEY: store.accessKey,
  OBJECTSTORE_SECRET_KEY: store.secretKey,
  OBJECTSTORE_LOCAL_PATH: "/tmp/cliproxyapi",
});

/**
 * The real container, through the Durable Object's `ctx.container`.
 * `storeGateway` routes the container's store calls back to this object.
 */
export const layerCloudflare = (input: {
  readonly container: Container;
  readonly storeGateway: Fetcher;
  /** Sets the object's alarm, which calls `sleepIfIdle`, to `at`. */
  readonly wakeAt: (at: number) => void;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}) =>
  Layer.effect(
    PoolContainer,
    Effect.gen(function* () {
      const { container, storeGateway, wakeAt, log } = input;
      const clock = yield* Clock.Clock;
      const startLock = yield* Semaphore.make(1);
      const stopLock = yield* Semaphore.make(1);
      const destroyLock = yield* Semaphore.make(1);
      let starting:
        | {
            readonly effect: Effect.Effect<void, PoolContainerError>;
            readonly stopSignal: Deferred.Deferred<void>;
          }
        | undefined;
      let stopping = false;
      let activeStopSignal = yield* Deferred.make<void>();
      const release = makeReleaseObserver((cliProxyApi) =>
        log("pool.container.release_observed", { cliProxyApi }),
      );
      const currentRelease = () =>
        container.running && starting === undefined && !stopping
          ? release.current()
          : unknownRelease;
      const activity = makeActivity({
        now: () => clock.currentTimeMillisUnsafe(),
        onIdleFrom: (at) => wakeAt(at + IDLE_TIMEOUT_MS),
      });

      const containerPromise = <A>(operation: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) => new PoolContainerOperationError({ operation, cause }),
        });
      let modelClientKey = "";
      let modelsReady = container.running;

      const [modelsReadyEffect, invalidateModelsReady] = yield* Effect.cachedInvalidateWithTTL(
        Effect.suspend(() =>
          waitForModels({
            container,
            clientKey: modelClientKey,
            stopSignal: activeStopSignal,
            isStopping: () => stopping,
            release: currentRelease,
            log,
          }),
        ),
        (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      );

      const start = (store: StoreCredentials) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.monotonicTimeNanos;
          release.reset();
          modelsReady = false;
          yield* invalidateModelsReady;
          // Intercepts last until the container stops, so every start sets them again.
          yield* containerPromise("intercept outbound HTTP", () =>
            container.interceptOutboundHttp(STORE_HOST, storeGateway),
          );
          yield* Effect.try({
            try: () => container.start({ enableInternet: true, env: containerEnv(store) }),
            catch: (cause) => new PoolContainerOperationError({ operation: "start", cause }),
          });
          yield* containerPromise("set inactivity timeout", () =>
            container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS),
          );
          const elapsed = Number(((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000n);
          yield* waitUntilReady(container, Math.max(0, READY_TIMEOUT_MS - elapsed));
          log("pool.container.started", {
            cliProxyApi: unknownRelease,
            readyMs: Number(((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000n),
          });
        });

      const startFor = (store: StoreCredentials) =>
        startLock.withPermits(1)(
          Effect.gen(function* () {
            yield* destroyLock.withPermits(1)(Effect.void);
            if (starting !== undefined) return starting.effect;
            if (container.running && !stopping) return Effect.void;
            const stopSignal = yield* Deferred.make<void>();
            activeStopSignal = stopSignal;
            const shared = yield* Effect.cachedWithTTL(
              Effect.raceFirst(
                start(store),
                Deferred.await(stopSignal).pipe(
                  Effect.andThen(Effect.fail(new PoolContainerStoppedError())),
                ),
              ).pipe(
                Effect.onExit(() =>
                  Effect.sync(() => {
                    starting = undefined;
                  }),
                ),
              ),
              (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
            );
            const task = { effect: shared, stopSignal };
            starting = task;
            return task.effect;
          }),
        );

      const ensure = (store: StoreCredentials) =>
        Effect.gen(function* () {
          yield* stopLock.withPermits(1)(Effect.void);
          yield* destroyLock.withPermits(1)(Effect.void);
          const startTask = yield* startFor(store);
          yield* startTask;
        });

      const destroy = destroyLock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!container.running) return;
            stopping = true;
            release.reset();
            yield* containerPromise("stop", () => container.destroy()).pipe(Effect.ignore);
          }).pipe(Effect.ensuring(Effect.sync(() => (stopping = false)))),
        ),
      );

      // A container that outlived its object's restart has lost its timeout.
      if (container.running) {
        yield* containerPromise("set inactivity timeout", () =>
          container.setInactivityTimeout(BACKSTOP_TIMEOUT_MS),
        ).pipe(Effect.ignore);
      }

      const fetch: PoolContainer["Service"]["fetch"] = (request, { store, models, onSend }) =>
        activity.track(() =>
          Effect.gen(function* () {
            yield* ensure(store);
            // Every model request waits, so pinning an account finds its credentials loaded.
            if (models !== undefined && !modelsReady) {
              modelClientKey = models.clientKey;
              yield* modelsReadyEffect;
              modelsReady = true;
            }
            onSend?.();
            const port = yield* Effect.try({
              try: () => container.getTcpPort(CLI_PROXY_API_PORT),
              catch: (cause) =>
                new PoolContainerOperationError({ operation: "send request", cause }),
            });
            return yield* release.observeEffect(request, () =>
              Effect.tryPromise({
                try: (signal) => port.fetch(withSignal(request, signal)),
                catch: (cause) =>
                  new PoolContainerOperationError({ operation: "send request", cause }),
              }),
            );
          }),
        );

      const peek: PoolContainer["Service"]["peek"] = (request) =>
        Effect.gen(function* () {
          if (starting !== undefined || stopping || !container.running) {
            return yield* new PoolContainerAsleepError();
          }
          const port = yield* Effect.try({
            try: () => container.getTcpPort(CLI_PROXY_API_PORT),
            catch: (cause) => new PoolContainerOperationError({ operation: "send request", cause }),
          });
          return yield* release.observeEffect(request, () =>
            Effect.tryPromise({
              try: (signal) => port.fetch(withSignal(request, signal)),
              catch: (cause) =>
                new PoolContainerOperationError({ operation: "send request", cause }),
            }),
          );
        });

      const stop = stopLock.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            stopping = true;
            yield* Deferred.succeed(activeStopSignal, undefined);
            const current = starting;
            if (current !== undefined) yield* current.effect.pipe(Effect.exit, Effect.asVoid);
            yield* destroy;
            modelsReady = false;
          }).pipe(Effect.ensuring(Effect.sync(() => (stopping = false)))),
        ),
      );

      return PoolContainer.of({
        fetch,
        peek,
        release: currentRelease,
        running: Effect.sync(() => container.running && !stopping),
        stop,
        sleepIfIdle: (now) =>
          Effect.gen(function* () {
            if (starting !== undefined) return now + READY_TIMEOUT_MS;
            if (!container.running) return null;
            const at = activity.sleepAt();
            if (at === null) return now + IDLE_TIMEOUT_MS;
            if (at > now) return at;
            // CLIProxyAPI has written every change to the store already.
            const cliProxyApi = currentRelease();
            yield* destroy;
            log("pool.container.slept", { cliProxyApi });
            return null;
          }),
      });
    }),
  );

/**
 * A container that is never there: what a pool object gets where containers
 * are not available. Managed pools then fail to reach their CLIProxyAPI with
 * a clear message; external ones work.
 */
export const layerUnavailable = Layer.succeed(
  PoolContainer,
  PoolContainer.of({
    fetch: () => Effect.fail(new PoolContainerUnavailableError()),
    peek: () => Effect.fail(new PoolContainerUnavailableError()),
    release: () => unknownRelease,
    running: Effect.succeed(false),
    stop: Effect.void,
    sleepIfIdle: () => Effect.succeed(null),
  }),
);
