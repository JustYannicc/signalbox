import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderDriverError } from "../provider/Errors.ts";
import * as AccountHub from "./AccountHub.ts";

/**
 * Builds a hub instance when this environment runs the account hub. Drivers
 * call this from their `setupMode: "hub"` branch, so upstream driver tests
 * that never provide the hub keep compiling and running.
 */
export const withAccountHub = <A, E, R>(
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
  make: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderDriverError, Exclude<R, AccountHub.AccountHub>> =>
  Effect.gen(function* () {
    const hub = yield* Effect.serviceOption(AccountHub.AccountHub);
    if (Option.isNone(hub)) {
      return yield* new ProviderDriverError({
        driver,
        instanceId,
        detail: "The account hub is not available in this environment.",
      });
    }
    return yield* make.pipe(Effect.provideService(AccountHub.AccountHub, hub.value));
  });
