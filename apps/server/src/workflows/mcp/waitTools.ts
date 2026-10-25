import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";

import { tool } from "./tool.ts";

/** Wait tool declarations shared with cloud runners. */

export const WaitForTool = tool("wait_for", AUTOMATION_TOOLS.wait_for);
export const ListWaitsTool = tool("list_waits", AUTOMATION_TOOLS.list_waits);
export const StopWaitingTool = tool("stop_waiting", AUTOMATION_TOOLS.stop_waiting);
export const MergePullRequestTool = tool("merge_pull_request", AUTOMATION_TOOLS.merge_pull_request);
