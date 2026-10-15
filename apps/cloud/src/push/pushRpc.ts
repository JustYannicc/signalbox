import {
  SIGNALBOX_PUSH_WS_METHODS,
  SignalboxPushError,
  type SignalboxPushDeviceRegistration,
  type SignalboxPushDeviceRemoval,
} from "@t3tools/contracts/signalboxPush";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

import * as PushDevices from "./PushDevices.ts";

/** A device change as an RPC answers it: storage failures logged, a plain message for the app. */
const deviceCall = (effect: Effect.Effect<void, SqlError>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: (cause) =>
        Effect.logError("cloud push devices storage failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(
              new SignalboxPushError({ message: "Couldn't update this phone. Try again." }),
            ),
          ),
        ),
    }),
  );

/** The push device RPCs of one socket, registering phones under its session `sid`. */
export const makePushHandlers = (sid: string) =>
  Effect.gen(function* () {
    const devices = yield* PushDevices.PushDevices;
    return {
      [SIGNALBOX_PUSH_WS_METHODS.registerDevice]: (registration: SignalboxPushDeviceRegistration) =>
        deviceCall(devices.register(sid, registration)),
      [SIGNALBOX_PUSH_WS_METHODS.unregisterDevice]: ({ deviceId }: SignalboxPushDeviceRemoval) =>
        deviceCall(devices.remove(deviceId)),
    };
  });
