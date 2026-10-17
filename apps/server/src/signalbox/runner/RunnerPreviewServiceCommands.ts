import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as RunnerPreviewServices from "./RunnerPreviewServices.ts";
import type { RunnerConnectionError } from "./RunnerSession.ts";

export class RunnerPreviewServiceCommands extends Context.Service<
  RunnerPreviewServiceCommands,
  {
    readonly start: (
      service: PreviewService,
    ) => Effect.Effect<void, RunnerPreviewServices.PreviewServiceError | RunnerConnectionError>;
    readonly stop: (port: number) => Effect.Effect<void, RunnerConnectionError>;
  }
>()("t3/signalbox/runner/RunnerPreviewServiceCommands") {}

const make = (input: {
  readonly persist: (
    services: ReadonlyArray<PreviewService>,
  ) => Effect.Effect<void, RunnerConnectionError>;
  readonly ready?: Effect.Effect<void, RunnerConnectionError>;
}) =>
  Effect.gen(function* () {
    const services = yield* RunnerPreviewServices.RunnerPreviewServices;
    const lock = yield* Semaphore.make(1);
    const ready = input.ready ?? Effect.void;
    const start = (service: PreviewService) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* ready;
          yield* services.start(service);
          yield* input.persist(yield* services.list);
        }),
      );
    const stop = (port: number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* ready;
          // A failed save leaves the local declaration absent. Retrying must save its deletion again.
          yield* services.stop(port);
          yield* input.persist(yield* services.list);
        }),
      );
    return RunnerPreviewServiceCommands.of({ start, stop });
  });

export const layer = (input: Parameters<typeof make>[0]) =>
  Layer.effect(RunnerPreviewServiceCommands, make(input));
