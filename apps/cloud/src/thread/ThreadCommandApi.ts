import type {
  OrchestrationV2DispatchCommandResult,
  WorktreeSetupCancelInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Actor } from "./ThreadAccess.ts";
import * as ThreadEngine from "./ThreadEngine.ts";
import type { ThreadCreation } from "./ThreadEngine.ts";
import { encodeBatchLine, jsonLine, type ThreadObjectReply, wire } from "./threadWire.ts";

/** The thread operations a user-domain service can route to its thread object. */
export interface ThreadCommandObjectApi {
  readonly launch: (
    actor: Actor,
    input: unknown,
    creation: ThreadCreation,
  ) => Promise<ThreadObjectReply<unknown>>;
  readonly dispatch: (
    actor: Actor,
    command: unknown,
    creation: ThreadCreation,
  ) => Promise<ThreadObjectReply<OrchestrationV2DispatchCommandResult>>;
  readonly snapshot: (actor: Actor) => Promise<ThreadObjectReply<unknown>>;
  readonly subscribe: (actor: Actor, input: unknown) => Promise<ReadableStream<Uint8Array> | null>;
  readonly workspace: (actor: Actor) => Promise<ThreadObjectReply<unknown>>;
  readonly commandOutput: (
    actor: Actor,
    input: unknown,
  ) => Promise<ReadableStream<Uint8Array> | null>;
  readonly summary: (actor: Actor) => Promise<unknown>;
  readonly subscribePreparation: (actor: Actor) => Promise<ReadableStream<Uint8Array> | null>;
  readonly cancelPreparation: (
    actor: Actor,
    input: WorktreeSetupCancelInput,
  ) => Promise<ThreadObjectReply<{ readonly cancelled: boolean }>>;
}

/** Builds the command-facing subset shared by the production and local hosts. */
export const makeThreadCommandObjectApi = (
  run: <A, E>(effect: Effect.Effect<A, E, ThreadEngine.ThreadEngine>) => Promise<A>,
  afterChange: () => Promise<void>,
): ThreadCommandObjectApi => {
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
    subscribePreparation: (actor) =>
      run(
        engine.use((service) =>
          service.subscribePreparation(actor).pipe(
            Effect.map((stream) =>
              stream.pipe(
                Stream.map((snapshot) =>
                  new TextEncoder().encode(
                    `${JSON.stringify(wire.preparation.encode(snapshot))}\n`,
                  ),
                ),
                Stream.toReadableStream(),
              ),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
      ),
    cancelPreparation: (actor, input) =>
      reply(
        engine.use((service) =>
          service.cancelPreparation(actor, input, Effect.promise(afterChange)).pipe(
            Effect.catchTags({
              WorktreeSetupError: (error) =>
                Effect.fail(
                  ThreadEngine.ThreadCommandRejectedError.forCommand(
                    {
                      id: `preparation:${input.runId}:${input.preparationGeneration}`,
                      type: "worktreeSetup.cancel",
                    },
                    error.message,
                  ),
                ),
            }),
          ),
        ),
      ),
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
    workspace: (actor) =>
      reply(engine.use((service) => Effect.map(service.workspace(actor), wire.workspace.encode))),
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
    commandOutput: (actor, input) =>
      run(
        engine.use((service) =>
          service.commandOutput(actor, wire.commandOutputInput.decode(input)).pipe(
            Effect.map((stream) =>
              stream.pipe(Stream.map(jsonLine(wire.commandOutputFrame)), Stream.toReadableStream()),
            ),
            Effect.catchTags({ ThreadNotFoundError: () => Effect.succeed(null) }),
          ),
        ),
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
