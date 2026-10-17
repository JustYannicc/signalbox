import * as Toolkit from "effect/ai/Toolkit";

import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";
import { tool } from "./tool.ts";
import { ListWaitsTool, MergePullRequestTool, StopWaitingTool, WaitForTool } from "./waitTools.ts";

/**
 * Agent tools for automations, declared in the package
 * (`@signalbox/automations/tools/declarations`). Each handler calls one
 * engine method (see handlers.ts); what they return is in summaries.ts.
 */

const AutomationReferenceTool = tool("automation_reference", AUTOMATION_TOOLS.automation_reference);
const AutomationValidateTool = tool("automation_validate", AUTOMATION_TOOLS.automation_validate);
const AutomationSaveTool = tool("automation_save", AUTOMATION_TOOLS.automation_save);
const AutomationListTool = tool("automation_list", AUTOMATION_TOOLS.automation_list);
const AutomationReadTool = tool("automation_read", AUTOMATION_TOOLS.automation_read);
const AutomationRunTool = tool("automation_run", AUTOMATION_TOOLS.automation_run);
const AutomationRunReadTool = tool("automation_run_read", AUTOMATION_TOOLS.automation_run_read);
const AutomationSetEnabledTool = tool(
  "automation_set_enabled",
  AUTOMATION_TOOLS.automation_set_enabled,
);
const AutomationCancelRunTool = tool(
  "automation_cancel_run",
  AUTOMATION_TOOLS.automation_cancel_run,
);
const AutomationRunRetryTool = tool("automation_run_retry", AUTOMATION_TOOLS.automation_run_retry);
const AutomationPublishTool = tool("automation_publish", AUTOMATION_TOOLS.automation_publish);
const AutomationDiscardDraftTool = tool(
  "automation_discard_draft",
  AUTOMATION_TOOLS.automation_discard_draft,
);
const AutomationDeleteTool = tool("automation_delete", AUTOMATION_TOOLS.automation_delete);
const AutomationEmitTool = tool("automation_emit", AUTOMATION_TOOLS.automation_emit);
const AutomationSetWebhookSecretTool = tool(
  "automation_set_webhook_secret",
  AUTOMATION_TOOLS.automation_set_webhook_secret,
);
const AutomationCustomizeTool = tool("automation_customize", AUTOMATION_TOOLS.automation_customize);
const TaskLifecycleTool = tool("task_lifecycle", AUTOMATION_TOOLS.task_lifecycle);

export const AutomationToolkit = Toolkit.make(
  TaskLifecycleTool,
  AutomationReferenceTool,
  AutomationValidateTool,
  AutomationSaveTool,
  AutomationListTool,
  AutomationReadTool,
  AutomationRunTool,
  AutomationRunReadTool,
  AutomationSetEnabledTool,
  AutomationCancelRunTool,
  AutomationRunRetryTool,
  AutomationPublishTool,
  AutomationDiscardDraftTool,
  AutomationDeleteTool,
  AutomationEmitTool,
  AutomationSetWebhookSecretTool,
  AutomationCustomizeTool,
  WaitForTool,
  ListWaitsTool,
  StopWaitingTool,
  MergePullRequestTool,
);
