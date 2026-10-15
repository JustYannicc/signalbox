import * as Effect from "effect/Effect";

import type { ModelUsage } from "../modelGateway/modelGatewayRecord.ts";
import { type ModelPoolRoute, poolObjectName } from "../pool/PoolDirectory.ts";
import { resolvePool } from "../user/poolChain.ts";
import { ResourceBindings } from "../user/ResourceBindings.ts";
import { UserStore } from "../user/UserStore.ts";
import { type LocalKey, LocalKeys } from "./LocalKeys.ts";

/**
 * The user object's side of a local key: what a key may use, and what it used.
 * A key runs on the pool the user's top level resolves to (`user/poolChain.ts`),
 * the same pool a thread at the top level runs on. Binding a key to a folder
 * would resolve from that folder instead.
 */

export type LocalModelAuthorization =
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "granted"; readonly keyId: string; readonly pool: ModelPoolRoute };

/** The user's keys, and the pool they run on now; null when the top level has none. */
export interface LocalKeysView {
  readonly keys: ReadonlyArray<LocalKey>;
  readonly poolId: string | null;
}

// Asked on every model request: the top level has nothing above it, so its
// bindings alone decide, without loading the folder tree.
const topLevelPool = Effect.gen(function* () {
  const bindings = yield* (yield* ResourceBindings).pools;
  return resolvePool({ parentOf: () => null, bindings }, { _tag: "top" })?.poolId ?? null;
});

export const localKeysView = Effect.gen(function* () {
  const keys = yield* (yield* LocalKeys).list;
  return { keys, poolId: yield* topLevelPool } satisfies LocalKeysView;
});

const denied = (reason: string): LocalModelAuthorization => ({ _tag: "denied", reason });

export const authorizeLocalModel = (secret: string) =>
  Effect.gen(function* () {
    const keyId = yield* (yield* LocalKeys).check(secret);
    if (keyId === null) {
      return denied(
        "This Signalbox key was revoked. Set this computer up again in Settings › Pools.",
      );
    }
    const profile = yield* (yield* UserStore).profile;
    if (profile === null) return denied("This Signalbox account no longer exists.");
    const poolId = yield* topLevelPool;
    if (poolId === null) {
      return denied("Your top level has no pool. Pick one for it in Signalbox.");
    }
    // The pool checks the user may still use it on every request (`PoolEngine.forwardModel`).
    return {
      _tag: "granted",
      keyId,
      pool: { objectName: poolObjectName(profile.id, poolId), userId: profile.id },
    } satisfies LocalModelAuthorization;
  });

export const recordLocalModelRequest = (input: {
  readonly keyId: string;
  readonly usage: ModelUsage | null;
}) => LocalKeys.use((keys) => keys.record(input.keyId, input.usage));
