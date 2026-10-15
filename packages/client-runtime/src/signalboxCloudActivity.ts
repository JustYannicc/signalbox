import { getInitialServerConfig } from "./rpc/client.ts";
import * as Effect from "effect/Effect";

type ConfigRead = ReturnType<typeof getInitialServerConfig>;

/**
 * Runs `report` unless the connected environment is Signalbox Cloud, which
 * keeps nothing alive for active clients and ignores activity reports. One
 * would only wake the user's hibernating object every 25 seconds.
 */
export const unlessSignalboxCloud = <A, E, R>(
  report: Effect.Effect<A, E, R>,
): Effect.Effect<void, E | Effect.Error<ConfigRead>, R | Effect.Services<ConfigRead>> =>
  Effect.flatMap(getInitialServerConfig(), (config) =>
    config.environment.capabilities.signalboxCloud === true ? Effect.void : Effect.asVoid(report),
  );
