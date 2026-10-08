import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { TurnReports } from "./diagnostics/TurnReports.ts";
import type { ThreadObjectApi } from "./ThreadDirectory.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import { encodeBatchLine, type ThreadObjectReply, wire } from "./threadWire.ts";

// Diagnostic records are plain JSON values already (ISO times, no class instances).
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A thread object's engine answers, given a way to run engine effects. The Durable
 * Object runs them on its own engine; tests run the same code in memory.
 * `afterChange` runs after anything that may have left work for the object
 * (a turn to drive, a summary to deliver).
 */
export const makeThreadObjectApi = (
  run: <A, E>(effect: Effect.Effect<A, E, ThreadEngine.ThreadEngine | TurnReports>) => Promise<A>,
  afterChange: () => Promise<void>,
): Omit<ThreadObjectApi, "previews" | "previewLink"> => {
  const reply = <A>(
    effect: Effect.Effect<
      A,
      ThreadEngine.ThreadNotFoundError | ThreadEngine.ThreadCommandRejectedError,
      ThreadEngine.ThreadEngine
    >,
  ): Promise<ThreadObjectReply<A>> =>
    run(
      effect.pipe(
        Effect.map((value): ThreadObjectReply<A> => ({ _tag: "ok", value })),
        Effect.catchTags({
          ThreadNotFoundError: () => Effect.succeed({ _tag: "not_found" } as const),
          ThreadCommandRejectedError: (error) =>
            Effect.succeed({
              _tag: "rejected",
              commandId: error.commandId,
              commandType: error.commandType,
              reason: error.reason,
            } as const),
        }),
      ),
    );
  const engine = ThreadEngine.ThreadEngine;
  return {
    dispatch: async (actor, command, creation) => {
      const result = await reply(
        engine.use((service) => service.dispatch(actor, wire.command.decode(command), creation)),
      );
      await afterChange();
      return result;
    },
    launch: async (actor, input, creation) => {
      const result = await reply(
        engine.use((service) =>
          Effect.map(
            service.launch(actor, wire.launchInput.decode(input), creation),
            wire.launchResult.encode,
          ),
        ),
      );
      await afterChange();
      return result;
    },
    snapshot: (actor) =>
      reply(engine.use((service) => Effect.map(service.snapshot(actor), wire.snapshot.encode))),
    subscribe: (actor, input) =>
      run(
        engine.use((service) =>
          service.subscribe(actor, wire.subscribeInput.decode(input)).pipe(
            Effect.map((stream) =>
              stream.pipe(Stream.map(encodeBatchLine), Stream.toReadableStream()),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    diagnostics: (actor, key) =>
      run(
        Effect.gen(function* () {
          const { projection } = yield* (yield* engine).snapshot(actor);
          const reports = yield* TurnReports;
          const found =
            key === null
              ? { turns: yield* reports.list(projection) }
              : yield* reports.turn(projection, key);
          return found === null ? null : encodeRecord(found);
        }).pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) })),
      ),
    summary: (actor) =>
      run(
        engine.use((service) =>
          Effect.map(service.summary(actor), (summary) =>
            summary === null ? null : wire.summary.encode(summary),
          ),
        ),
      ),
  };
};
