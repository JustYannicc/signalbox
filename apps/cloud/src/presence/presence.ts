import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as PresenceAccess from "./presence-access.ts";

export type PresenceFrame =
  | { readonly _tag: "Snapshot" | "Update"; readonly people: readonly string[] }
  | { readonly _tag: "Reset" | "Revoked" };

export class Presence extends Context.Service<
  Presence,
  {
    readonly view: (
      actor: PresenceAccess.PresenceActor,
      target: PresenceAccess.PresenceTarget,
    ) => Stream.Stream<PresenceFrame, PresenceAccess.PresenceError>;
    /** Explicit location only. Scope teardown leaves; connectionKey identifies the authenticated connection. */
    readonly join: (
      actor: PresenceAccess.PresenceActor,
      target: PresenceAccess.PresenceTarget,
      connectionKey: string,
    ) => Effect.Effect<void, PresenceAccess.PresenceError, Scope.Scope>;
  }
>()("@signalbox/cloud/presence/presence") {}

const encodeConnection = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

const make = Effect.gen(function* makePresence() {
  const access = yield* PresenceAccess.PresenceAccess;

  interface Join {
    readonly userId: string;
    readonly guard: PresenceAccess.PresenceGuard;
    failure?: PresenceAccess.PresenceError;
  }

  const targets = new Map<string, Map<string, Set<Join>>>();
  const observers = new Map<string, Set<() => void>>();

  const notify = (target: string) => {
    for (const changed of observers.get(target) ?? []) {
      changed();
    }
  };

  const remove = (target: string, key: string, entry: Join) => {
    const connections = targets.get(target);
    const joins = connections?.get(key);

    if (joins === undefined || !joins.delete(entry)) {
      return;
    }

    if (joins.size === 0) {
      connections?.delete(key);
    }

    if (connections?.size === 0) {
      targets.delete(target);
    }

    notify(target);
  };

  const join: Presence["Service"]["join"] = (actor, target, connectionKey) =>
    Effect.gen(function* addPresenceJoin() {
      const guard = yield* access.open(actor, target, "publish");
      const key = encodeConnection([actor.userId, connectionKey]);
      const entry: Join = { guard, userId: actor.userId };

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          guard.onInvalidate((result) => {
            if (Result.isSuccess(result) || result.failure._tag === "PresenceDenied") {
              remove(guard.target, key, entry);
            } else {
              // Losing the authority must not turn an unknown roster into an empty one.
              entry.failure = result.failure;
              notify(guard.target);
            }
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      yield* Effect.acquireRelease(
        Effect.suspend(() =>
          Effect.fromResult(
            guard.withCurrent(() => {
              const connections = targets.get(guard.target) ?? new Map<string, Set<Join>>();
              const joins = connections.get(key) ?? new Set<Join>();
              joins.add(entry);
              connections.set(key, joins);
              targets.set(guard.target, connections);
              notify(guard.target);
            }),
          ),
        ),
        () =>
          Effect.sync(() => {
            remove(guard.target, key, entry);
          }),
      );
    });

  const view: Presence["Service"]["view"] = (actor, target) =>
    Stream.unwrap(
      Effect.gen(function* openPresenceView() {
        const guard = yield* access.open(actor, target, "observe");
        // Queue dirtiness, never rosters: every pull computes under current publisher and reader fences.
        const dirty = yield* Queue.sliding<true>(1);

        const changed = () => {
          Queue.offerUnsafe(dirty, true);
        };

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const listeners = observers.get(guard.target) ?? new Set<() => void>();
            listeners.add(changed);
            observers.set(guard.target, listeners);
          }),
          () =>
            Effect.sync(() => {
              const listeners = observers.get(guard.target);
              listeners?.delete(changed);

              if (listeners?.size === 0) {
                observers.delete(guard.target);
              }

              Queue.shutdownUnsafe(dirty);
            }),
        );

        let terminal: Result.Result<"Reset" | "Revoked", PresenceAccess.PresenceError> | undefined;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            guard.onInvalidate((result) => {
              terminal = result;
              changed();
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );

        changed();
        let first = true;

        return Stream.fromEffectRepeat(
          Effect.gen(function* readPresenceFrame() {
            yield* Queue.take(dirty);

            if (terminal !== undefined) {
              return { _tag: yield* Effect.fromResult(terminal) } satisfies PresenceFrame;
            }

            const collected = guard.withCurrent(() => {
              const people = new Set<string>();

              for (const joins of targets.get(guard.target)?.values() ?? []) {
                for (const entry of joins) {
                  if (entry.failure !== undefined) {
                    return Result.fail(entry.failure);
                  }

                  const current = entry.guard.withCurrent(() => entry.userId);

                  if (Result.isFailure(current)) {
                    if (current.failure._tag === "PresenceUnavailable") {
                      return Result.fail(current.failure);
                    }
                  } else {
                    people.add(current.success);
                  }
                }
              }

              return Result.succeed([...people].toSorted());
            });

            if (Result.isFailure(collected) && collected.failure._tag === "PresenceDenied") {
              return { _tag: "Revoked" } satisfies PresenceFrame;
            }

            const people = yield* Effect.fromResult(collected).pipe(
              Effect.flatMap(Effect.fromResult),
            );

            const frame: PresenceFrame = { _tag: first ? "Snapshot" : "Update", people };
            first = false;

            return frame;
          }),
        ).pipe(Stream.takeUntil((frame) => frame._tag === "Reset" || frame._tag === "Revoked"));
      }),
    );

  return Presence.of({ join, view });
});

export const layer = Layer.effect(Presence, make);
