import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  ProductAnalyticsSettingsError,
  SIGNALBOX_ANALYTICS_WS_METHODS,
} from "@t3tools/contracts/signalboxAnalytics";
import type { ProductAnalyticsClientEvent } from "@t3tools/contracts/signalboxAnalytics";
import * as Effect from "effect/Effect";

import * as ClientActionTimings from "../observability/ClientActionTimings.ts";
import * as UserAnalyticsPreference from "./UserAnalyticsPreference.ts";

export const ANALYTICS_METHODS = Object.values(SIGNALBOX_ANALYTICS_WS_METHODS);
export const ANALYTICS_REQUIRED_SCOPES = {
  [SIGNALBOX_ANALYTICS_WS_METHODS.getSettings]: AuthOrchestrationReadScope,
  [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: AuthSettingsWriteScope,
  [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: AuthOrchestrationReadScope,
} as const;

export const makeAnalyticsHandlers = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const preference = yield* UserAnalyticsPreference.UserAnalyticsPreference;
    const timings = yield* ClientActionTimings.ClientActionTimings;
    const hasConsent = () =>
      preference.settings.pipe(
        Effect.map((settings) => settings.enabled && !settings.disabledByServer),
        Effect.catchCause(() => Effect.succeed(false)),
      );
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
      [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: (event: ProductAnalyticsClientEvent) => {
        if (event.event !== "interaction.timings") return Effect.void;
        return hasConsent().pipe(
          Effect.flatMap((enabled) =>
            enabled ? timings.record(userId, event.samples, hasConsent) : Effect.void,
          ),
          // Missing storage or telemetry must never turn an action into an RPC failure.
          Effect.catchCause(() => Effect.void),
        );
      },
    };
  });
