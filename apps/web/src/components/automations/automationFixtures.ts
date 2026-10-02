/**
 * PLACEHOLDER DATA. Automations do not exist yet: nothing here is persisted,
 * scheduled, or executed. These records let the sidebar panel and workflow
 * page be judged for look and feel, and get replaced by server state once
 * automations land. Each automation lives in its own file under `fixtures/`.
 */
import type { Automation } from "./automationModel";
import { CAPTURE_ROUTING } from "./fixtures/captureRouting";
import { RECONCILE_CARD_BILL } from "./fixtures/cardBill";
import { CUSTOMER_REPLIES } from "./fixtures/customerReplies";
import { DANGER_CHECK } from "./fixtures/dangerCheck";
import { INTEGRATION_HEALTH } from "./fixtures/integrationHealth";
import { MONTHLY_EXPENSES } from "./fixtures/monthlyExpenses";
import { NO_FORCE_PUSH } from "./fixtures/noForcePush";
import { NOTION_DIGEST } from "./fixtures/notionDigest";
import { REVIEW_PRS } from "./fixtures/reviewPrs";
import { SENTRY_FEEDBACK } from "./fixtures/sentryFeedback";
import { SHIP_CHANGE } from "./fixtures/shipChange";
import { SPEC_TO_PR } from "./fixtures/specToPr";
import { SYNC_UPSTREAM } from "./fixtures/syncUpstream";
import { TRIAGE_SENTRY } from "./fixtures/triageSentry";
import { WATER_PLANTS } from "./fixtures/waterPlants";
import { WORK_OUT_OF_SIGHT } from "./fixtures/workOutOfSight";

export const AUTOMATIONS: readonly Automation[] = [
  CAPTURE_ROUTING,
  SHIP_CHANGE,
  SPEC_TO_PR,
  DANGER_CHECK,
  NO_FORCE_PUSH,
  SYNC_UPSTREAM,
  TRIAGE_SENTRY,
  SENTRY_FEEDBACK,
  INTEGRATION_HEALTH,
  CUSTOMER_REPLIES,
  RECONCILE_CARD_BILL,
  MONTHLY_EXPENSES,
  WORK_OUT_OF_SIGHT,
  WATER_PLANTS,
  REVIEW_PRS,
  NOTION_DIGEST,
];

export function findAutomation(automationId: string) {
  return AUTOMATIONS.find((automation) => automation.id === automationId) ?? null;
}
