import type { T3McpToolDefinition } from "./t3McpToolPresentation.ts";

function tool(labels: T3McpToolDefinition["labels"]): T3McpToolDefinition {
  return {
    displayName: `${labels[0]} ${labels[3]}`,
    labels,
    icon: "t3-code",
    summaryAction: "automation",
  };
}

/** Presentation for the automation MCP tools, spread into the T3 tool inventory. */
export const AUTOMATION_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  automation_reference: tool(["Read", "Reading", "Read", "the automation guide"]),
  automation_validate: tool(["Check", "Checking", "Checked", "an automation"]),
  automation_save: tool(["Save", "Saving", "Saved", "an automation"]),
  automation_list: tool(["List", "Listing", "Listed", "automations"]),
  automation_read: tool(["Read", "Reading", "Read", "an automation"]),
  automation_run: tool(["Run", "Starting", "Started", "an automation"]),
  automation_run_read: tool(["Check", "Checking", "Checked", "an automation run"]),
  automation_set_enabled: tool(["Toggle", "Toggling", "Toggled", "an automation"]),
  automation_cancel_run: tool(["Cancel", "Cancelling", "Cancelled", "an automation run"]),
  automation_run_retry: tool(["Retry", "Retrying", "Retried", "an automation run"]),
  automation_publish: tool(["Publish", "Publishing", "Published", "an automation draft"]),
  automation_discard_draft: tool(["Discard", "Discarding", "Discarded", "an automation draft"]),
  automation_delete: tool(["Delete", "Deleting", "Deleted", "an automation"]),
  automation_emit: tool(["Send", "Sending", "Sent", "an automation event"]),
};
