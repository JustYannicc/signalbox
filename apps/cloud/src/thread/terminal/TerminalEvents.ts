import {
  TerminalSessionLookupError,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalObserveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadEngine from "../ThreadEngine.ts";
import * as TerminalOutbox from "./TerminalOutbox.ts";
import * as TerminalStore from "./TerminalStore.ts";
import { snapshot } from "./terminalState.ts";

interface Notification {
  readonly generation: number;
  readonly event: TerminalEvent;
}

const PendingNotifications = Context.Reference<Array<Notification>>(
  "@signalbox/cloud/thread/terminal/PendingNotifications",
  { defaultValue: () => [] },
);

type Decision = Parameters<ThreadEngine.ThreadEngine["Service"]["apply"]>[0];

export class TerminalEvents extends Context.Service<
  TerminalEvents,
  {
    readonly apply: <A>(
      decide: (...args: Parameters<Decision>) => Effect.Effect<ThreadEngine.EngineDecision<A>>,
    ) => Effect.Effect<A>;
    readonly emit: (generation: number, event: TerminalEvent) => Effect.Effect<void>;
    readonly observe: (
      actor: ThreadEngine.Actor,
      input: TerminalObserveInput,
    ) => Stream.Stream<
      TerminalAttachStreamEvent,
      ThreadEngine.ThreadNotFoundError | TerminalSessionLookupError
    >;
  }
>()("@signalbox/cloud/thread/terminal/TerminalEvents") {}

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const records = yield* TerminalStore.TerminalStore;
  const outbox = yield* TerminalOutbox.TerminalOutbox;
  const published = yield* PubSub.sliding<Notification>(256);

  const apply: TerminalEvents["Service"]["apply"] = (decide) =>
    engine.apply((projection, context) =>
      Effect.gen(function* () {
        const notifications: Array<Notification> = [];
        const decision = yield* records
          .atomic(
            decide(projection, context).pipe(
              Effect.provideService(PendingNotifications, notifications),
            ),
          )
          .pipe(Effect.orDie);
        // Keep the thread lock until publication, so the next commit cannot overtake it.
        for (const notification of notifications) yield* PubSub.publish(published, notification);
        return decision;
      }).pipe(Effect.uninterruptible),
    );

  const emit: TerminalEvents["Service"]["emit"] = (generation, event) =>
    Effect.gen(function* () {
      const record = yield* Effect.orDie(records.get(event.terminalId));
      if (record === null) return;
      const next = { ...record, revision: record.revision + 1 };
      yield* Effect.orDie(records.save(next));
      const sequenced: TerminalEvent =
        event.type === "started" || event.type === "restarted"
          ? { ...event, sequence: next.revision, snapshot: snapshot(next) }
          : { ...event, sequence: next.revision };
      yield* Effect.orDie(outbox.append(sequenced, snapshot(next), next.hasRunningSubprocess));
      (yield* PendingNotifications).push({ generation, event: sequenced });
    });

  const observe: TerminalEvents["Service"]["observe"] = (actor, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { projection } = yield* engine.snapshot(actor);
        if (projection.thread.id !== input.threadId)
          return yield* new ThreadEngine.ThreadNotFoundError();
        // Stream.unwrap owns the subscription's scope, even if the reader stops at its snapshot.
        const subscription = yield* PubSub.subscribe(published);
        const record = yield* engine.apply(() =>
          Effect.map(Effect.orDie(records.get(input.terminalId)), (record) => ({
            events: [],
            result: record,
          })),
        );
        if (record === null || record.status === "closed") {
          return yield* new TerminalSessionLookupError(input);
        }
        const cursor = yield* Ref.make({
          generation: record.generation,
          sequence: record.revision,
        });
        const tail = Stream.fromSubscription(subscription).pipe(
          Stream.filter(({ event }) => event.terminalId === input.terminalId),
          Stream.mapEffect(({ generation, event }) =>
            Effect.gen(function* () {
              const seen = yield* Ref.get(cursor);
              if (
                generation < seen.generation ||
                (generation === seen.generation &&
                  event.sequence !== undefined &&
                  event.sequence <= seen.sequence)
              )
                return null;
              if (event.type === "started" || event.type === "restarted") {
                const sequence = event.snapshot.sequence ?? 0;
                if (generation === seen.generation && sequence < seen.sequence) return null;
                yield* Ref.set(cursor, { generation, sequence });
                return event.type === "started"
                  ? { type: "snapshot" as const, snapshot: event.snapshot }
                  : event;
              }
              if (
                generation > seen.generation ||
                (event.sequence !== undefined && event.sequence > seen.sequence + 1)
              ) {
                const latest = yield* Effect.orDie(records.get(input.terminalId));
                if (latest === null) return null;
                yield* Ref.set(cursor, {
                  generation: latest.generation,
                  sequence: latest.revision,
                });
                if (latest.status === "closed")
                  return {
                    type: "closed" as const,
                    threadId: input.threadId,
                    terminalId: input.terminalId,
                    sequence: latest.revision,
                  };
                return { type: "snapshot" as const, snapshot: snapshot(latest) };
              }
              if (event.sequence !== undefined && event.sequence > seen.sequence)
                yield* Ref.set(cursor, { generation, sequence: event.sequence });
              return event;
            }),
          ),
          Stream.filter((event): event is TerminalAttachStreamEvent => event !== null),
        );
        return Stream.concat(
          Stream.make({ type: "snapshot" as const, snapshot: snapshot(record) }),
          tail,
        );
      }),
    );

  return TerminalEvents.of({ apply, emit, observe });
});

export const layer = Layer.effect(TerminalEvents, make);
