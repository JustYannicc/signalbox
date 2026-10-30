import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  PoolContainer,
  PoolContainerAsleepError,
  PoolContainerOperationError,
  type StoreCredentials,
} from "../PoolContainer.ts";
import { makeReleaseObserver, unknownRelease } from "../CliProxyApiRuntime.ts";
import { withSignal } from "./poolContainerRequest.ts";

/** A container that serves requests in process, for tests that need a pool runtime. */
export const makeFake = (
  serve: (request: Request, store: StoreCredentials) => Promise<Response>,
) => {
  let running = false;
  const release = makeReleaseObserver();
  const state = { starts: 0 };
  const layer = Layer.succeed(
    PoolContainer,
    PoolContainer.of({
      fetch: (request, { store, onSend }) =>
        Effect.gen(function* () {
          if (!running) {
            release.reset();
            running = true;
            state.starts += 1;
          }
          onSend?.();
          return yield* release.observeEffect(request, () =>
            Effect.tryPromise({
              try: (signal) => serve(withSignal(request, signal), store),
              catch: (cause) =>
                new PoolContainerOperationError({ operation: "send request", cause }),
            }),
          );
        }),
      peek: (request) =>
        Effect.gen(function* () {
          if (!running) return yield* new PoolContainerAsleepError();
          return yield* release.observeEffect(request, () =>
            Effect.tryPromise({
              try: (signal) => serve(withSignal(request, signal), { accessKey: "", secretKey: "" }),
              catch: (cause) =>
                new PoolContainerOperationError({ operation: "send request", cause }),
            }),
          );
        }),
      release: () => (running ? release.current() : unknownRelease),
      running: Effect.sync(() => running),
      stop: Effect.sync(() => {
        release.reset();
        running = false;
      }),
      sleepIfIdle: () => Effect.succeed(null),
    }),
  );
  return { layer, state };
};
