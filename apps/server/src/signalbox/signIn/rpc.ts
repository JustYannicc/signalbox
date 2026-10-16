import { SignInGrantError, SIGNALBOX_SIGN_IN_WS_METHODS } from "@t3tools/contracts/signalboxSignIn";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Sign-in grants live in Signalbox Cloud, beside the login service that
 * checks them. A self-hosted server has none, and says so.
 */
const unavailable = new SignInGrantError({
  message: "Sign-in grants are part of Signalbox Cloud.",
});

export const signalboxSignInWsHandlers = {
  [SIGNALBOX_SIGN_IN_WS_METHODS.subscribe]: () => Stream.fail(unavailable),
  [SIGNALBOX_SIGN_IN_WS_METHODS.grant]: () => Effect.fail(unavailable),
  [SIGNALBOX_SIGN_IN_WS_METHODS.revoke]: () => Effect.fail(unavailable),
  [SIGNALBOX_SIGN_IN_WS_METHODS.check]: () => Effect.fail(unavailable),
  [SIGNALBOX_SIGN_IN_WS_METHODS.fill]: () => Effect.fail(unavailable),
};
