import { AUTOMATION_WS_METHODS, AutomationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../signalbox/automationAvailability.ts";

const failed = () => Effect.fail(new AutomationError({ message: AUTOMATIONS_CLOUD_ONLY_MESSAGE }));
const failedStream = () =>
  Stream.fail(new AutomationError({ message: AUTOMATIONS_CLOUD_ONLY_MESSAGE }));

/** WebSocket contract remains stable while self-hosted servers direct users to Cloud. */
export const automationRpcHandlers = () => ({
  [AUTOMATION_WS_METHODS.automationsSubscribe]: failedStream,
  [AUTOMATION_WS_METHODS.automationsSubscribeNotices]: failedStream,
  [AUTOMATION_WS_METHODS.automationsSubscribeOne]: failedStream,
  [AUTOMATION_WS_METHODS.automationsSubscribeRun]: failedStream,
  [AUTOMATION_WS_METHODS.automationsListBlocks]: failed,
  [AUTOMATION_WS_METHODS.automationsSetEnabled]: failed,
  [AUTOMATION_WS_METHODS.automationsDelete]: failed,
  [AUTOMATION_WS_METHODS.automationsRotateWebhook]: failed,
  [AUTOMATION_WS_METHODS.automationsSetWebhookSecret]: failed,
  [AUTOMATION_WS_METHODS.automationsRunNow]: failed,
  [AUTOMATION_WS_METHODS.automationsValidate]: failed,
  [AUTOMATION_WS_METHODS.automationsSave]: failed,
  [AUTOMATION_WS_METHODS.automationsCustomize]: failed,
  [AUTOMATION_WS_METHODS.automationsStopAttached]: failed,
  [AUTOMATION_WS_METHODS.automationsCancelRun]: failed,
  [AUTOMATION_WS_METHODS.automationsRetryRun]: failed,
  [AUTOMATION_WS_METHODS.automationsPublish]: failed,
  [AUTOMATION_WS_METHODS.automationsDiscardDraft]: failed,
  [AUTOMATION_WS_METHODS.automationsAnswer]: failed,
  [AUTOMATION_WS_METHODS.automationsConnectionStatus]: failed,
  [AUTOMATION_WS_METHODS.automationsGitHubSubscriptions]: failed,
  [AUTOMATION_WS_METHODS.automationsConnect]: failed,
  [AUTOMATION_WS_METHODS.automationsDisconnect]: failed,
  [AUTOMATION_WS_METHODS.automationsTaskLifecycle]: failed,
});
