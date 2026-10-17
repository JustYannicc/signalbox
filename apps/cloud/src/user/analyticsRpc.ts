import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  ProductAnalyticsSettingsError,
  SIGNALBOX_ANALYTICS_WS_METHODS,
} from "@t3tools/contracts/signalboxAnalytics";
import * as Effect from "effect/Effect";

import * as UserAnalyticsPreference from "./UserAnalyticsPreference.ts";

export const ANALYTICS_METHODS = Object.values(SIGNALBOX_ANALYTICS_WS_METHODS);
export const ANALYTICS_REQUIRED_SCOPES = {
  [SIGNALBOX_ANALYTICS_WS_METHODS.getSettings]: AuthOrchestrationReadScope,
  [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: AuthSettingsWriteScope,
  [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: AuthOrchestrationReadScope,
} as const;

export const makeAnalyticsHandlers = Effect.gen(function* () {
  const preference = yield* UserAnalyticsPreference.UserAnalyticsPreference;
  return {
    [SIGNALBOX_ANALYTICS_WS_METHODS.getSettings]: () => preference.settings.pipe(Effect.orDie),
    [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: ({ enabled }: { readonly enabled: boolean }) =>
      preference.setEnabled(enabled).pipe(
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.logError("cloud analytics preference save failed", { cause }).pipe(
              Effect.andThen(
                Effect.fail(new ProductAnalyticsSettingsError({ detail: "Try again." })),
              ),
            ),
        }),
      ),
    // The protocol accepts bounded events, but delivery stays off until #358.
    [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: () => Effect.void,
  };
});
