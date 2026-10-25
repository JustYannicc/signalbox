import type { SignalboxAsk, SignalboxAskAnswerCommand } from "@t3tools/contracts/signalboxAsks";
import type {
  OrchestrationV2Command,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadCommandRejectedError } from "../thread/ThreadAccess.ts";
import { CloudAutomations } from "./CloudAutomations.ts";

/** Read at the operation boundary: the engine itself depends on the thread service. */
export const answerAutomationAsk = (
  command: typeof SignalboxAskAnswerCommand.Type,
  ask: SignalboxAsk,
) =>
  Effect.gen(function* () {
    const automations = yield* Effect.serviceOption(CloudAutomations);
    const rejected = (reason: string) =>
      ThreadCommandRejectedError.forCommand({ id: command.commandId, type: command.type }, reason);
    if (Option.isNone(automations))
      return yield* rejected("The automation engine isn't available to answer this ask.");
    yield* automations.value
      .answerAsk(command, ask)
      .pipe(Effect.mapError((cause) => rejected(cause.message)));
  });

export const dispatchAutomationAskAnswer = <Actor, E>(
  actor: Actor,
  command: OrchestrationV2Command,
  threads: {
    readonly threadSnapshot: (
      actor: Actor,
      threadId: ThreadId,
    ) => Effect.Effect<
      { readonly projection: OrchestrationV2ThreadProjection; readonly snapshotSequence: number },
      E
    >;
  },
): Effect.Effect<{ readonly sequence: number } | null, E | ThreadCommandRejectedError> =>
  Effect.gen(function* () {
    if (command.type !== "thread.ask.answer") return null;
    const snapshot = yield* threads.threadSnapshot(actor, command.threadId);
    const ask = snapshot.projection.thread.asks?.find(
      (candidate) => candidate.id === command.askId,
    );
    if (ask?.source.kind !== "automation") return null;
    yield* answerAutomationAsk(command, ask);
    const latest = yield* threads.threadSnapshot(actor, command.threadId);
    return { sequence: latest.snapshotSequence };
  });
