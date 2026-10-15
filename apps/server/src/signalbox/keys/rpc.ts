import { PersonalKeyError, SIGNALBOX_KEYS_WS_METHODS } from "@t3tools/contracts/signalboxKeys";
import * as Effect from "effect/Effect";

/**
 * Personal keys live in Signalbox Cloud, which signs and checks them. A
 * self-hosted server has none, and says so.
 */
const unavailable = () =>
  Effect.fail(new PersonalKeyError({ message: "Personal keys are part of Signalbox Cloud." }));

export const signalboxKeysWsHandlers = {
  [SIGNALBOX_KEYS_WS_METHODS.list]: unavailable,
  [SIGNALBOX_KEYS_WS_METHODS.create]: unavailable,
  [SIGNALBOX_KEYS_WS_METHODS.revoke]: unavailable,
};
