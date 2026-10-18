import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { AUTOMATIONS_CLOUD_ONLY_MESSAGE } from "../../signalbox/automationAvailability.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { AutomationToolkit } from "./tools.ts";

const unavailable = () =>
  Effect.fail(
    new OrchestratorMcpFailure({
      code: "provider_unavailable",
      message: AUTOMATIONS_CLOUD_ONLY_MESSAGE,
    }),
  );

export const layer = McpToolAccess.toLayer(AutomationToolkit, {
  task_lifecycle: McpToolAccess.reads(unavailable),
  automation_reference: McpToolAccess.reads(unavailable),
  automation_validate: McpToolAccess.reads(unavailable),
  automation_save: McpToolAccess.reads(unavailable),
  automation_list: McpToolAccess.reads(unavailable),
  automation_read: McpToolAccess.reads(unavailable),
  automation_run: McpToolAccess.reads(unavailable),
  automation_run_read: McpToolAccess.reads(unavailable),
  automation_set_enabled: McpToolAccess.reads(unavailable),
  automation_cancel_run: McpToolAccess.reads(unavailable),
  automation_run_retry: McpToolAccess.reads(unavailable),
  automation_publish: McpToolAccess.reads(unavailable),
  automation_discard_draft: McpToolAccess.reads(unavailable),
  automation_delete: McpToolAccess.reads(unavailable),
  automation_emit: McpToolAccess.reads(unavailable),
  automation_set_webhook_secret: McpToolAccess.reads(unavailable),
  automation_customize: McpToolAccess.reads(unavailable),
  wait_for: McpToolAccess.reads(unavailable),
  list_waits: McpToolAccess.reads(unavailable),
  stop_waiting: McpToolAccess.reads(unavailable),
  merge_pull_request: McpToolAccess.reads(unavailable),
});
