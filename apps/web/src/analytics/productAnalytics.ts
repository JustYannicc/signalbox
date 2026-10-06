/**
 * Signalbox's product analytics from the client: the per-environment Settings
 * opt-out, and fork events that only a client sees. The server owns delivery,
 * so these are plain RPCs; no analytics SDK loads in the client.
 */
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { SIGNALBOX_ANALYTICS_WS_METHODS } from "@t3tools/contracts/signalboxAnalytics";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

export const productAnalyticsSettings = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "signalbox:analytics:settings",
  tag: SIGNALBOX_ANALYTICS_WS_METHODS.getSettings,
});

export const setProductAnalyticsEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "signalbox:analytics:set-enabled",
  tag: SIGNALBOX_ANALYTICS_WS_METHODS.setEnabled,
  onSettled: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(productAnalyticsSettings({ environmentId, input: {} }))),
});

/** Best effort: callers ignore failures, an event is never worth an error. */
export const recordProductAnalyticsEvent = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "signalbox:analytics:record-client-event",
  tag: SIGNALBOX_ANALYTICS_WS_METHODS.recordClientEvent,
});
