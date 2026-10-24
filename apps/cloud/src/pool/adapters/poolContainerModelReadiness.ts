import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CLI_PROXY_API_PORT, effectEndpoint, listModels } from "../cliProxyApi.ts";
import {
  CONTAINER_ORIGIN,
  MODELS_READY_MS,
  PoolContainerOperationError,
  PoolContainerStoppedError,
  READY_POLL_MS,
} from "../PoolContainer.ts";
import type { CliProxyApiRelease } from "../CliProxyApiRuntime.ts";
import { withSignal } from "./poolContainerRequest.ts";

export const waitForModels = (input: {
  readonly container: Container;
  readonly clientKey: string;
  readonly stopSignal: Deferred.Deferred<void>;
  readonly isStopping: () => boolean;
  readonly release: () => CliProxyApiRelease;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}) =>
  Effect.gen(function* () {
    const { container, clientKey, stopSignal, isStopping, release, log } = input;
    const startedAt = yield* Clock.monotonicTimeNanos;
    const port = yield* Effect.try({
      try: () => container.getTcpPort(CLI_PROXY_API_PORT),
      catch: (cause) => new PoolContainerOperationError({ operation: "read models", cause }),
    });
    // Straight to the port: through the PoolObject's endpoint it would wait on itself.
    const endpoint = effectEndpoint(
      { baseUrl: CONTAINER_ORIGIN, managementKey: "", clientKey, link: false },
      (request) =>
        Effect.tryPromise({
          try: (signal) => port.fetch(withSignal(request, signal)),
          catch: (cause) => new PoolContainerOperationError({ operation: "read models", cause }),
        }),
    );
    const poll: Effect.Effect<boolean> = Effect.suspend(() =>
      Effect.gen(function* () {
        if (!container.running) return false;
        const listed = yield* listModels(endpoint).pipe(Effect.catch(() => Effect.succeed([])));
        if (listed.length > 0) return true;
        yield* Effect.sleep(Duration.millis(READY_POLL_MS));
        return yield* poll;
      }),
    );
    const ready = yield* Effect.raceFirst(
      poll.pipe(
        Effect.timeoutOption(Duration.millis(MODELS_READY_MS)),
        Effect.map(Option.getOrNull),
      ),
      Deferred.await(stopSignal).pipe(Effect.andThen(Effect.fail(new PoolContainerStoppedError()))),
    );
    if (ready) return;
    log("pool.container.models_not_ready", {
      cliProxyApi: release(),
      waitedMs: Number(((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000n),
      stopped: !container.running || isStopping(),
    });
  });
