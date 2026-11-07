import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { CLI_PROXY_API_PORT } from "./cliProxyApi.ts";
import type { CliProxyApiRelease } from "./CliProxyApiRuntime.ts";

/**
 * A managed pool's CLIProxyAPI: a Cloudflare Container bound to the pool's
 * object (`containers` in `wrangler.jsonc`). It starts on the first request,
 * stops once no request has reached it for `IDLE_TIMEOUT_MS` (the object's
 * alarm calls `sleepIfIdle`), and starts with a fresh disk every time; its credentials live in the object's store, which
 * the container reaches as `STORE_HOST`. That host is intercepted to this
 * pool's own object, so a container can only ever reach its own pool's
 * credentials.
 *
 * Tests use `makeFake`; vitest cannot run containers.
 */

/** Where the container's CLIProxyAPI answers, as the pool object addresses it. */
export const CONTAINER_ORIGIN = "http://cliproxyapi";

/** The made-up host the container's object store calls go to. */
export const STORE_HOST = "store.pool.internal";

/** How long the container outlives the last request the pool sent it. */
export const IDLE_TIMEOUT_MS = 2 * 60_000;

/** How long a cold start may take before a request fails. */
export const READY_TIMEOUT_MS = 30_000;
export const READY_POLL_MS = 100;

/**
 * How long a model request waits after a cold start for CLIProxyAPI to load
 * its accounts. It listens before it has: until then it answers
 * `unknown provider for model` (#563). After this the request goes in anyway.
 */
export const MODELS_READY_MS = 10_000;

/** The store credentials the container is configured with. */
export interface StoreCredentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

/**
 * What sending a request needs. `models`: the request runs a model on a pool
 * with accounts, so it waits until CLIProxyAPI serves them; `onSend` runs
 * once the container is up, as the request goes in.
 */
export interface SendOptions {
  readonly store: StoreCredentials;
  readonly models?: { readonly clientKey: string };
  readonly onSend?: () => void;
}

export class PoolContainerOperationError extends Schema.TaggedError<PoolContainerOperationError>()(
  "PoolContainerOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `The pool's container failed to ${this.operation}.`;
  }
}

export class PoolContainerStoppedError extends Schema.TaggedError<PoolContainerStoppedError>()(
  "PoolContainerStoppedError",
  {},
) {
  override get message() {
    return "The pool's container stopped while starting.";
  }
}

export class PoolContainerAsleepError extends Schema.TaggedError<PoolContainerAsleepError>()(
  "PoolContainerAsleepError",
  {},
) {
  override get message() {
    return "The pool's container is asleep.";
  }
}

export class PoolContainerUnavailableError extends Schema.TaggedError<PoolContainerUnavailableError>()(
  "PoolContainerUnavailableError",
  {},
) {
  override get message() {
    return "Pool containers are not available here.";
  }
}

export type PoolContainerError =
  | PoolContainerOperationError
  | PoolContainerStoppedError
  | PoolContainerAsleepError
  | PoolContainerUnavailableError
  | PoolContainerReadinessProbeError
  | PoolContainerExitedDuringStartError
  | PoolContainerReadinessTimeoutError;

export class PoolContainer extends Context.Service<
  PoolContainer,
  {
    /** Sends a request to the CLIProxyAPI, starting the container first if it sleeps. */
    readonly fetch: (
      request: Request,
      options: SendOptions,
    ) => Effect.Effect<Response, PoolContainerError>;
    /**
     * Sends a request only if the container is already up, without keeping
     * it up: for reads that must never wake it or delay its sleep.
     */
    readonly peek: (request: Request) => Effect.Effect<Response, PoolContainerError>;
    /** Evidence from this running container, or unknown until a management reply identifies it. */
    readonly release: () => CliProxyApiRelease;
    readonly running: Effect.Effect<boolean>;
    readonly stop: Effect.Effect<void>;
    /**
     * Stops the container once it has been idle for `IDLE_TIMEOUT_MS`.
     * Returns when to look again, or null when it is not running.
     */
    readonly sleepIfIdle: (now: number) => Effect.Effect<number | null>;
  }
>()("@signalbox/cloud/pool/PoolContainer") {}

export class PoolContainerReadinessProbeError extends Schema.TaggedError<PoolContainerReadinessProbeError>()(
  "PoolContainerReadinessProbeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The pool's container is not ready yet.";
  }
}

export class PoolContainerExitedDuringStartError extends Schema.TaggedError<PoolContainerExitedDuringStartError>()(
  "PoolContainerExitedDuringStartError",
  {},
) {
  override get message() {
    return "The pool's container exited while starting.";
  }
}

export class PoolContainerReadinessTimeoutError extends Schema.TaggedError<PoolContainerReadinessTimeoutError>()(
  "PoolContainerReadinessTimeoutError",
  {},
) {
  override get message() {
    return "The pool's container did not start in time.";
  }
}

/** A failed startup probe retries on the Effect clock and keeps its failure typed. */
export const waitUntilReady = (container: Container, timeoutMs = READY_TIMEOUT_MS) =>
  Effect.gen(function* () {
    if (timeoutMs <= 0) return yield* new PoolContainerReadinessTimeoutError();

    const probe = Effect.gen(function* () {
      if (!container.running) return yield* new PoolContainerExitedDuringStartError();
      const port = yield* Effect.try({
        try: () => container.getTcpPort(CLI_PROXY_API_PORT),
        catch: (cause) => new PoolContainerReadinessProbeError({ cause }),
      });
      yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await port.fetch(new Request(`${CONTAINER_ORIGIN}/`, { signal }));
          await response.body?.cancel();
        },
        catch: (cause) => new PoolContainerReadinessProbeError({ cause }),
      });
    });

    const ready = yield* probe.pipe(
      Effect.retry({
        schedule: Schedule.spaced(Duration.millis(READY_POLL_MS)),
        while: Schema.is(PoolContainerReadinessProbeError),
      }),
      Effect.timeoutOption(Duration.millis(timeoutMs)),
    );
    if (Option.isNone(ready)) return yield* new PoolContainerReadinessTimeoutError();
  });
