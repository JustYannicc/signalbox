import { CommandId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { HarnessError } from "../harness/Harness.ts";
import type {
  HarnessContinuation,
  HarnessContinuationPublisher,
} from "../harness/HarnessContinuations.ts";
import type { Actor } from "./ThreadAccess.ts";
import * as Threads from "./Threads.ts";

export const createHarnessContinuationPublisher = (options: {
  readonly authorize: (request: HarnessContinuation) => Effect.Effect<Actor, HarnessError>;
}): Effect.Effect<HarnessContinuationPublisher, never, Threads.Threads> =>
  Effect.gen(function* () {
    const threads = yield* Threads.Threads;

    return {
      publish: (request) =>
        Effect.flatMap(options.authorize(request), (actor) =>
          threads
            .dispatch(actor, {
              type: "message.dispatch",
              commandId: CommandId.make(`provider-continuation:${request.messageId}`),
              threadId: request.threadId,
              messageId: request.messageId,
              text: request.detail ?? "Background task completed.",
              notification: request.notification ?? {
                source: { kind: "background_task" },
                outcome: "updated",
                summary: "Background activity updated",
              },
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: request.delivery === "message_text" ? "server" : "provider",
              providerContinuation: {
                sourceRunId: request.sourceRunId,
                providerThreadId: request.providerThreadId,
                driver: request.driver,
              },
            } satisfies Extract<OrchestrationV2Command, { type: "message.dispatch" }>)
            .pipe(
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new HarnessError({
                    operation: "events",
                    message: "Harness continuation could not be dispatched.",
                    cause,
                  }),
              ),
            ),
        ),
    };
  });
