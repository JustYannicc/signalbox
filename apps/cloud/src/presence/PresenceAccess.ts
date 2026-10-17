import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class PresenceUnavailable extends Schema.TaggedError<PresenceUnavailable>()(
  "PresenceUnavailable",
  { reason: Schema.Literals(["access", "dependency"]) },
) {
  override get message() {
    return "Presence is unavailable.";
  }
}

export interface PresenceActor {
  readonly userId: string;
}

/** Catalog resolves this opaque reference server-side; possessing it grants no access. */
export type PresenceTarget = string;

type DeferredWork =
  | PromiseLike<unknown>
  | Effect.Effect<unknown, unknown, unknown>
  | ((...args: never[]) => unknown);
type Synchronous<A> = [Extract<A, DeferredWork>] extends [never] ? unknown : never;

export interface PresenceGuard {
  readonly target: PresenceTarget;
  /** Checks the installed fence and runs the callback synchronously, without an intervening await. */
  readonly withCurrent: <A>(use: () => A & Synchronous<A>) => Result.Result<A, PresenceUnavailable>;
  /** Sticky and synchronous; registration immediately reports an already-invalidated guard. */
  readonly onInvalidate: (
    invalidate: (result: Result.Result<"Reset" | "Revoked", PresenceUnavailable>) => void,
  ) => () => void;
}

/** Catalog owns canonicalization, authorization and the installed revocation fence. */
export class PresenceAccess extends Context.Service<
  PresenceAccess,
  {
    readonly open: (
      actor: PresenceActor,
      target: PresenceTarget,
      intent: "observe" | "publish",
    ) => Effect.Effect<PresenceGuard, PresenceUnavailable, Scope.Scope>;
  }
>()("@signalbox/cloud/presence/PresenceAccess") {}
