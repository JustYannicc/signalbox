import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderDriverError } from "../provider/Errors.ts";
import * as AccountHub from "./AccountHub.ts";
import * as AccountPools from "./AccountPools.ts";

/**
 * Builds a hub instance on the hub of its pool. Drivers call this from their
 * `setupMode: "hub"` branch, so upstream driver tests that never provide the
 * hub keep compiling and running.
 */
export const withAccountHub = <A, E, R>(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  poolId: string | undefined,
  make: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderDriverError, Exclude<R, AccountHub.AccountHub>> =>
  Effect.gen(function* () {
    const unavailable = (detail: string) => new ProviderDriverError({ driver, instanceId, detail });
    const pools = yield* Effect.serviceOption(AccountPools.AccountPools);
    const hub = Option.isSome(pools)
      ? yield* pools.value
          .hub(poolId ?? PERSONAL_POOL_ID)
          .pipe(Effect.mapError((error) => unavailable(error.detail)))
      : Option.getOrUndefined(yield* Effect.serviceOption(AccountHub.AccountHub));
    if (!hub) return yield* unavailable("The account hub is not available in this environment.");
    return yield* make.pipe(Effect.provideService(AccountHub.AccountHub, hub));
  });
