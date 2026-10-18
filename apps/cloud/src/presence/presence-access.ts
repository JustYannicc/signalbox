import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import type { PresenceDenied } from "./presence-denied.ts";
import type { PresenceUnavailable } from "./presence-unavailable.ts";

export { PresenceDenied } from "./presence-denied.ts";

export { PresenceUnavailable } from "./presence-unavailable.ts";

export type PresenceError = PresenceDenied | PresenceUnavailable;

export interface PresenceActor {
  readonly userId: string;
}

/** Catalog resolves this opaque reference server-side; possessing it grants no access. */
export type PresenceTarget = string;

type DeferredWork =
  | PromiseLike<unknown>
  | Effect.Effect<unknown, unknown, unknown>
  | ((...args: never[]) => void);

type Synchronous<A> = [Extract<A, DeferredWork>] extends [never] ? A : never;

export interface PresenceGuard {
  readonly target: PresenceTarget;
  /** Checks the installed fence and runs the callback synchronously, without an intervening await. */
  readonly withCurrent: <A>(use: () => A & Synchronous<A>) => Result.Result<A, PresenceError>;
  /** Sticky and synchronous; registration immediately reports an already-invalidated guard. */
  readonly onInvalidate: (
    invalidate: (result: Result.Result<"Reset" | "Revoked", PresenceError>) => void,
  ) => () => void;
}

/** Catalog owns canonicalization, authorization and the installed revocation fence. */
export class PresenceAccess extends Context.Service<
  PresenceAccess,
  {
    /** Missing and inaccessible targets both fail PresenceDenied; PresenceUnavailable is only dependency failure. */
    readonly open: (
      actor: PresenceActor,
      target: PresenceTarget,
      intent: "observe" | "publish",
    ) => Effect.Effect<PresenceGuard, PresenceError, Scope.Scope>;
  }
>()("@signalbox/cloud/presence/presence-access/PresenceAccess") {}
