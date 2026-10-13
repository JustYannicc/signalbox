/**
 * Signalbox's product analytics RPCs: the Settings opt-out that stops every
 * destination, and the fork's client-side events. Part of `WsRpcGroup`.
 *
 * Client events are a closed union with no free-form fields, so a client can
 * never put prompts or other content into an event.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";

export const SIGNALBOX_ANALYTICS_WS_METHODS = {
  getSettings: "signalbox.analytics.getSettings",
  setEnabled: "signalbox.analytics.setEnabled",
  recordClientEvent: "signalbox.analytics.recordClientEvent",
} as const;

export const ProductAnalyticsSettings = Schema.Struct({
  /** False once the user opts out. Every destination stops. */
  enabled: Schema.Boolean,
  /** The server's environment (`T3CODE_TELEMETRY_ENABLED=false`) turned analytics off. */
  disabledByServer: Schema.Boolean,
});
export type ProductAnalyticsSettings = typeof ProductAnalyticsSettings.Type;

export class ProductAnalyticsSettingsError extends Schema.TaggedError<ProductAnalyticsSettingsError>()(
  "ProductAnalyticsSettingsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Couldn't save the analytics setting: ${this.detail}`;
  }
}

export const ProductAnalyticsClientEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("feedback.sent"),
    screenshotAttached: Schema.Boolean,
    serverLogsAttached: Schema.Boolean,
  }),
  // Sent by the capture bar (#24).
  Schema.Struct({ event: Schema.Literal("capture.used") }),
]);
export type ProductAnalyticsClientEvent = typeof ProductAnalyticsClientEvent.Type;

const GetSettingsRpc = Rpc.make(SIGNALBOX_ANALYTICS_WS_METHODS.getSettings, {
  payload: Schema.Struct({}),
  success: ProductAnalyticsSettings,
  error: EnvironmentAuthorizationError,
});

const SetEnabledRpc = Rpc.make(SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled, {
  payload: Schema.Struct({ enabled: Schema.Boolean }),
  success: ProductAnalyticsSettings,
  error: Schema.Union([ProductAnalyticsSettingsError, EnvironmentAuthorizationError]),
});

const RecordClientEventRpc = Rpc.make(SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent, {
  payload: ProductAnalyticsClientEvent,
  error: EnvironmentAuthorizationError,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_ANALYTICS_RPCS = [
  GetSettingsRpc,
  SetEnabledRpc,
  RecordClientEventRpc,
] as const;
