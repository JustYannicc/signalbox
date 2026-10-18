import {
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import type { SignalboxAsk } from "@t3tools/contracts/signalboxAsks";

function upsertAsk(asks: readonly SignalboxAsk[] | undefined, ask: SignalboxAsk) {
  return asks?.some((entry) => entry.id === ask.id)
    ? asks.map((entry) => (entry.id === ask.id ? ask : entry))
    : [...(asks ?? []), ask];
}

export function threadWithAsk(
  thread: OrchestrationV2AppThread,
  event: Extract<OrchestrationV2DomainEvent, { type: "thread.ask-updated" }>,
) {
  return { ...thread, asks: upsertAsk(thread.asks, event.payload), updatedAt: event.occurredAt };
}

/** Metadata snapshots omit history. Ask changes journal only the record that changed. */
export function compactAskEvents(
  threadId: ThreadId,
  asks: readonly SignalboxAsk[] | undefined,
  events: readonly OrchestrationV2DomainEvent[],
): readonly OrchestrationV2DomainEvent[] {
  const previous = new Map(asks?.map((ask) => [ask.id, ask]));
  return events.flatMap((event): OrchestrationV2DomainEvent[] => {
    if (event.threadId !== threadId) return [event];
    if (event.type === "thread.created") {
      for (const ask of event.payload.asks ?? []) previous.set(ask.id, ask);
      return [event];
    }
    if (event.type === "thread.ask-updated") {
      previous.set(event.payload.id, event.payload);
      return [event];
    }
    if (
      !("archivedAt" in event.payload && "modelSelection" in event.payload) ||
      event.payload.asks === undefined
    )
      return [event];
    const { asks: current, ...payload } = event.payload;
    const changed = current.filter((ask) => {
      const old = previous.get(ask.id);
      previous.set(ask.id, ask);
      return old !== ask && JSON.stringify(old) !== JSON.stringify(ask);
    });
    return [
      // Every member with a thread payload shares this optional history field.
      { ...event, payload } as OrchestrationV2DomainEvent,
      ...changed.map((ask): OrchestrationV2DomainEvent => ({
        type: "thread.ask-updated",
        id: EventId.make(`${event.id}:ask:${ask.id}`),
        threadId,
        occurredAt: event.occurredAt,
        payload: ask,
      })),
    ];
  });
}
