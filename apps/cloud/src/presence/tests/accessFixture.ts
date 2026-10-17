import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as PresenceAccess from "../PresenceAccess.ts";

export const makeAccess = () => {
  let invalidateNext: "Reset" | "Revoked" | undefined;
  const permissions = new Map<string, Set<PresenceAccess.PresenceGuard>>();
  const invalidators = new Map<
    PresenceAccess.PresenceGuard,
    (reason: "Reset" | "Revoked" | "dependency") => void
  >();
  const encodeKey = Schema.encodeSync(
    Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
  );
  const keyOf = (userId: string, target: string) => encodeKey([userId, target]);
  const allow = (userId: string, target: string) => {
    permissions.set(keyOf(userId, target), new Set());
  };
  const invalidate = (
    userId: string,
    target: string,
    reason: "Reset" | "Revoked" | "dependency",
  ) => {
    const key = keyOf(userId, target);
    const guards = permissions.get(key);
    permissions.delete(key);
    for (const guard of guards ?? []) invalidators.get(guard)?.(reason);
  };
  const access = PresenceAccess.PresenceAccess.of({
    open: (actor, target) =>
      Effect.gen(function* () {
        const guards = permissions.get(keyOf(actor.userId, target));
        if (guards === undefined) return yield* new PresenceAccess.PresenceDenied();
        let terminal: Result.Result<"Reset" | "Revoked", PresenceAccess.PresenceError> | undefined;
        const callbacks = new Set<Parameters<PresenceAccess.PresenceGuard["onInvalidate"]>[0]>();
        const guard: PresenceAccess.PresenceGuard = {
          target,
          withCurrent: (use) =>
            terminal === undefined
              ? Result.succeed(use())
              : Result.fail(
                  Result.isFailure(terminal)
                    ? new PresenceAccess.PresenceUnavailable()
                    : new PresenceAccess.PresenceDenied(),
                ),
          onInvalidate: (callback) => {
            callbacks.add(callback);
            if (terminal !== undefined) callback(terminal);
            return () => {
              callbacks.delete(callback);
            };
          },
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            guards.add(guard);
            invalidators.set(guard, (reason) => {
              if (terminal !== undefined) return;
              terminal =
                reason === "dependency"
                  ? Result.fail(new PresenceAccess.PresenceUnavailable())
                  : Result.succeed(reason);
              for (const callback of callbacks) callback(terminal);
            });
          }),
          () =>
            Effect.sync(() => {
              guards.delete(guard);
              invalidators.delete(guard);
            }),
        );
        if (invalidateNext !== undefined) {
          const reason = invalidateNext;
          invalidateNext = undefined;
          invalidate(actor.userId, target, reason);
        }
        return guard;
      }),
  });
  return {
    allow,
    invalidate,
    invalidateNextOpen: (reason: "Reset" | "Revoked") => {
      invalidateNext = reason;
    },
    layer: Layer.succeed(PresenceAccess.PresenceAccess, access),
  };
};
