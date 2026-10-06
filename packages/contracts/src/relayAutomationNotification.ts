import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One-shot phone alerts from Signalbox automations, sent through the relay.
 * Unlike agent activity they hold no state: the relay delivers and forgets,
 * so Live Activities, widgets and the Android ongoing card never list them.
 * relay.ts mounts the endpoint; this file only imports base schemas so the
 * two modules don't import each other.
 */

/** JWT `typ` of the environment-signed proof, so activity proofs can't be replayed here. */
export const RELAY_AUTOMATION_NOTIFICATION_TYP = "t3-env-automation-notification+jwt";

export const RelayAutomationNotification = Schema.Struct({
  /** Stable per step (`<runId>/<stepKey>`); phones drop a second alert with the same id. */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  /** `ask` waits on the user; `notify` only tells them something. */
  kind: Schema.Literals(["ask", "notify"]),
  title: TrimmedNonEmptyString,
  body: Schema.String,
  /** App route the tap opens, e.g. `/automations/<environmentId>/runs/<runId>`. */
  deepLink: TrimmedNonEmptyString,
});
export type RelayAutomationNotification = typeof RelayAutomationNotification.Type;

export const RelayAutomationNotificationProofPayload = Schema.Struct({
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
  environmentId: EnvironmentId,
  notification: RelayAutomationNotification,
});
export type RelayAutomationNotificationProofPayload =
  typeof RelayAutomationNotificationProofPayload.Type;

export const RelayAutomationNotificationPublishRequest = Schema.Struct({
  notification: RelayAutomationNotification,
  proof: TrimmedNonEmptyString.annotate({
    description: "Environment-signed JWT covering this notification.",
  }),
}).annotate({ description: "Sends an automation alert to the environment's linked phones." });
export type RelayAutomationNotificationPublishRequest =
  typeof RelayAutomationNotificationPublishRequest.Type;

/** The app route an alert opens: one run. Mobile links it as `automations/:environmentId/runs/:runId`. */
export function automationRunDeepLink(environmentId: string, runId: string): string {
  return `/automations/${encodeURIComponent(environmentId)}/runs/${encodeURIComponent(runId)}`;
}

/** The run a deep link names, or null for any other path, so an alert can't open somewhere arbitrary. */
export function parseAutomationRunDeepLink(
  value: string,
): { readonly environmentId: string; readonly runId: string } | null {
  if (value.trim() !== value || value.includes("?") || value.includes("#")) return null;
  const parts = value.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "automations" || parts[3] !== "runs") {
    return null;
  }
  try {
    const environmentId = decodeURIComponent(parts[2] ?? "");
    const runId = decodeURIComponent(parts[4] ?? "");
    return environmentId && runId ? { environmentId, runId } : null;
  } catch {
    return null;
  }
}

/** A run deep link re-encoded the way {@link automationRunDeepLink} builds it, or null. */
export function normalizeAutomationRunDeepLink(value: string): string | null {
  const run = parseAutomationRunDeepLink(value);
  return run ? automationRunDeepLink(run.environmentId, run.runId) : null;
}
