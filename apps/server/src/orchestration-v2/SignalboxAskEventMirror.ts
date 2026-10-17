import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import { mirrorNativeAskEvents } from "@t3tools/shared/signalboxAsks";
import type { SignalboxNativeAskRespondCommand } from "@t3tools/contracts/signalboxAsks";
import * as Effect from "effect/Effect";

type AskProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runtimeRequests" | "turnItems"
>;

export function mirrorSignalboxAskEvents<E>(
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  getThreadRecords: (threadId: ThreadId) => Effect.Effect<AskProjection, E>,
  response?: Pick<typeof SignalboxNativeAskRespondCommand.Type, "requestId" | "answeredBy">,
) {
  return Effect.gen(function* () {
    let result = events;
    const threadIds = new Set(
      events
        .filter(
          (event) =>
            (event.type === "runtime-request.updated" && event.payload.kind === "user_input") ||
            event.type === "thread.archived" ||
            (event.type === "turn-item.updated" && event.payload.type === "user_input_request"),
        )
        .map((event) => event.threadId),
    );
    for (const threadId of threadIds) {
      const created = events.find(
        (event) => event.type === "thread.created" && event.threadId === threadId,
      );
      const projection: AskProjection =
        created?.type === "thread.created"
          ? { thread: created.payload, runtimeRequests: [], turnItems: [] }
          : yield* getThreadRecords(threadId);
      result = mirrorNativeAskEvents(projection, result, response);
    }
    return result;
  });
}
