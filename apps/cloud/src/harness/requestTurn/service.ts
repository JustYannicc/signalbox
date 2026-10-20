import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestRuntime,
  type HarnessRequestFacetOptions,
} from "../HarnessRequestFacet.ts";
import { createHarnessSessionHost } from "../HarnessSessionHost.ts";
import type { HarnessRequestTurnOptions, HarnessRequestTurnTerminal } from "./contracts.ts";
import { observeEvent, type RequestEvents } from "./events.ts";
import { createRequestGate, failure } from "./gate.ts";
import { gateHost } from "./host.ts";

const turnCodec = Schema.fromJsonString(Schema.toCodecJson(RunnerTurn));
const encodeTurn = Schema.encodeEffect(turnCodec);
const decodeTurn = Schema.decodeEffect(turnCodec);
const atStage = (message: string) => (cause: unknown) =>
  cause instanceof HarnessRequestFacetError ? cause : failure(message, cause);

export const createHarnessRequestTurn =
  <G>(options: HarnessRequestTurnOptions<G>): HarnessRequestFacetOptions["open"] =>
  (checkpoint, context) =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const gate = yield* createRequestGate;
      yield* Effect.try({
        try: () => gate.enter(context),
        catch: (cause) => failure("Harness opening request conflicts.", cause),
      });
      const session = yield* Effect.gen(function* () {
        yield* gate.admit(() => options.verify(checkpoint.native, "native"));
        yield* gate.admit(() => options.verify(checkpoint.filesystem, "filesystem"));
        const restored = yield* gate.admit(() => options.restore(checkpoint, gate));
        const host = yield* gate
          .admit(() => createHarnessSessionHost(gateHost(restored.host, gate)))
          .pipe(Effect.mapError(atStage("Canonical Harness host could not be constructed.")));
        // The canonical host verifies restored seed receipts before native ownership begins.
        yield* gate
          .admit(() => host.seed("assets"))
          .pipe(Effect.mapError(atStage("Canonical Harness asset seed verification failed.")));
        yield* gate
          .admit(() => host.seed("programs"))
          .pipe(Effect.mapError(atStage("Canonical Harness program seed verification failed.")));
        return yield* gate
          .admit(() => host.open(restored.open))
          .pipe(Effect.mapError(atStage("Canonical Harness native session open failed.")));
      }).pipe(
        (effect) => gate.withRequest(effect, context),
        Effect.ensuring(Effect.sync(() => gate.leave())),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.leave()));
      let active: RequestEvents | undefined;
      const broken = yield* Deferred.make<never, HarnessRequestFacetError>();
      yield* session.events.pipe(
        Stream.rechunk(1),
        Stream.runForEach((item) =>
          gate.admit((current) =>
            Effect.gen(function* () {
              const work = active;
              if (work === undefined)
                return yield* Effect.fail(failure("Harness emitted productive work while idle."));
              const terminal = yield* observeEvent(item, work);
              const reference = yield* gate.admit(() => options.onEvent(item, current));
              yield* gate.admit(() => options.verify(reference, "progress"));
              yield* gate.admit(() => current.progress("event", reference));
              if (terminal) yield* Deferred.succeed(work.done, work.terminal!);
            }),
          ),
        ),
        Effect.andThen(Effect.fail(failure("Canonical Harness event stream ended."))),
        Effect.catchCause((cause) =>
          Deferred.fail(broken, failure("Canonical Harness event publication failed.", cause)),
        ),
        Effect.forkIn(scope),
      );
      const runtime: HarnessFacetRequestRuntime = {
        run: (reference, current) =>
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => gate.enter(current),
              catch: (cause) => failure("Harness has an active request.", cause),
            });
            return yield* Effect.gen(function* () {
              yield* gate.admit(() => options.verify(reference, "input"));
              const supplied = yield* gate.admit(() => options.readInput(reference, current));
              const turn = yield* encodeTurn(supplied.turn).pipe(
                Effect.flatMap(decodeTurn),
                Effect.mapError((cause) => failure("Harness turn artifact is invalid.", cause)),
              );
              const done = yield* Deferred.make<
                HarnessRequestTurnTerminal,
                HarnessRequestFacetError
              >();
              active = { turn, done };
              yield* gate
                .admit(() =>
                  session.turn({
                    turn,
                    access: {
                      ...supplied.access,
                      signal: AbortSignal.any([
                        supplied.access.signal,
                        current.signal,
                        gate.signal(),
                      ]),
                    },
                  }),
                )
                .pipe(Effect.mapError(atStage("Canonical Harness turn failed to start.")));
              const terminal = yield* Deferred.await(done);
              gate.seal();
              yield* gate.drain;
              const saved = yield* gate
                .admit(() => session.export())
                .pipe(Effect.mapError(atStage("Canonical Harness checkpoint export failed.")));
              const committed = yield* gate.admit(() => options.writeCheckpoint(saved, current));
              yield* gate.admit(() => options.verify(committed.native, "native"));
              yield* gate.admit(() => options.verify(committed.filesystem, "filesystem"));
              const result = yield* gate.admit(() =>
                options.writeResult({ turn, terminal }, current),
              );
              yield* gate.admit(() => options.verify(result, "result"));
              yield* gate.drain;
              const status = terminal.event.status === "completed" ? "completed" : "failed";
              return { status, result, checkpoint: committed } as const;
            }).pipe(
              (effect) => gate.withRequest(effect, current),
              Effect.raceFirst(Deferred.await(broken)),
              Effect.ensuring(
                Effect.sync(() => {
                  active = undefined;
                  gate.leave();
                }),
              ),
            );
          }),
      };
      return runtime;
    });
