import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "@t3tools/contracts";
import {
  SIGNALBOX_ANALYTICS_WS_METHODS,
  type ProductAnalyticsClientEvent,
} from "@t3tools/contracts/signalboxAnalytics";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { AnalyticsPreference } from "./ProductAnalytics.ts";

export const SIGNALBOX_ANALYTICS_RPC_REQUIRED_SCOPES = {
  [SIGNALBOX_ANALYTICS_WS_METHODS.getSettings]: AuthOrchestrationReadScope,
  [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: AuthSettingsWriteScope,
  // Read-only clients still use the app; counting that is not an operation.
  [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: AuthOrchestrationReadScope,
} as const;

/**
 * WebSocket handlers for `SignalboxAnalyticsRpcGroup`. Client events carry the
 * connection's client dimensions, like upstream's `client.*` events.
 */
export const makeSignalboxAnalyticsWsHandlers = Effect.fn("makeSignalboxAnalyticsWsHandlers")(
  function* (clientAnalyticsProps: Readonly<Record<string, unknown>>) {
    const analytics = yield* AnalyticsService.AnalyticsService;
    const preference = yield* AnalyticsPreference;
    return {
      [SIGNALBOX_ANALYTICS_WS_METHODS.getSettings]: (_input: {}) => preference.settings,
      [SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled]: (input: { readonly enabled: boolean }) =>
        preference.setEnabled(input.enabled),
      [SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent]: ({
        event,
        ...properties
      }: ProductAnalyticsClientEvent) =>
        analytics.record(`signalbox.${event}`, { ...clientAnalyticsProps, ...properties }),
    };
  },
);
