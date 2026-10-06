import {
  AUTOMATION_WS_METHODS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";

/**
 * Watching automations reads; changing or running them operates, like scheduled
 * tasks. Connecting Executor operates too, like saving provider credentials.
 */
export const AUTOMATION_RPC_SCOPES = {
  [AUTOMATION_WS_METHODS.automationsSubscribe]: AuthOrchestrationReadScope,
  [AUTOMATION_WS_METHODS.automationsSubscribeOne]: AuthOrchestrationReadScope,
  [AUTOMATION_WS_METHODS.automationsSubscribeRun]: AuthOrchestrationReadScope,
  [AUTOMATION_WS_METHODS.automationsSubscribeNotices]: AuthOrchestrationReadScope,
  [AUTOMATION_WS_METHODS.automationsSetEnabled]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsDelete]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsRotateWebhook]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsSetWebhookSecret]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsRunNow]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsCustomize]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsStopAttached]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsCancelRun]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsRetryRun]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsPublish]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsDiscardDraft]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsAnswer]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsConnectionStatus]: AuthOrchestrationReadScope,
  [AUTOMATION_WS_METHODS.automationsConnect]: AuthOrchestrationOperateScope,
  [AUTOMATION_WS_METHODS.automationsDisconnect]: AuthOrchestrationOperateScope,
} as const;
