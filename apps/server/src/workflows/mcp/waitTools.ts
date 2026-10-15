import { AUTOMATION_TOOLS } from "@signalbox/automations/tools/declarations";

import { tool } from "./tool.ts";

/** Agent tools for waiting on something; handlers.ts runs them through the engine's waits. */

export const WaitForTool = tool("wait_for", AUTOMATION_TOOLS.wait_for);
export const ListWaitsTool = tool("list_waits", AUTOMATION_TOOLS.list_waits);
export const StopWaitingTool = tool("stop_waiting", AUTOMATION_TOOLS.stop_waiting);
