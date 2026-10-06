import {
  RelayAutomationNotification,
  type RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as Schema from "effect/Schema";

import { alertAllowedForPhase } from "./agentActivityAlerts.ts";

/**
 * Signalbox automations: what the relay's push paths share about automation
 * alerts. Kept apart from AutomationNotifications.ts so FcmDeliveries can use
 * it without importing the service that depends on it.
 */

/**
 * Whether a phone's preferences let an automation alert through. An ask waits
 * on the user like a thread's input request, so it also follows "needs input".
 */
export function automationAlertAllowed(
  kind: RelayAutomationNotification["kind"],
  preferences: RelayAgentAwarenessPreferences | null,
): boolean {
  return (
    preferences?.notificationsEnabled === true &&
    (kind !== "ask" || alertAllowedForPhase(preferences, "waiting_for_input"))
  );
}

/** The alert fields the Android native handler renders, same as agent-activity alerts. */
export const AutomationAndroidAlert = Schema.Struct({
  alert_id: Schema.String,
  alert_group: Schema.String,
  alert_title: Schema.String,
  alert_body: Schema.String,
  alert_path: Schema.String,
});
export type AutomationAndroidAlert = typeof AutomationAndroidAlert.Type;

/**
 * An automation alert carried by an FCM job. FcmDeliveries sends it in place of
 * an alert derived from agent-activity rows, if the phone's preferences still
 * allow its kind when the job runs.
 */
export const AutomationAndroidJob = Schema.Struct({
  kind: RelayAutomationNotification.fields.kind,
  alert: AutomationAndroidAlert,
});
export type AutomationAndroidJob = typeof AutomationAndroidJob.Type;
