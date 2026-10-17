import {
  SIGNALBOX_PERSON_BROWSER_WS_METHODS,
  SignalboxPersonBrowserError,
} from "@t3tools/contracts/signalboxPersonBrowser";
import * as Effect from "effect/Effect";

export const signalboxPersonBrowserWsHandlers = {
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]: () => Effect.succeed({ available: false }),
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]: () =>
    Effect.fail(
      new SignalboxPersonBrowserError({
        message: "The cloud browser profile is part of Signalbox Cloud.",
      }),
    ),
};
