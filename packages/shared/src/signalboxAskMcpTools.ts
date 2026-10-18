import type { T3McpToolDefinition } from "./t3McpToolTypes.ts";

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolDefinition["summaryAction"],
): T3McpToolDefinition {
  return { displayName: `${labels[0]} ${labels[3]}`, labels, icon: "t3-code", summaryAction };
}

export const SIGNALBOX_ASK_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  t3_ask_raise: tool(["Raise", "Raising", "Raised", "an ask"], "thread-update"),
  t3_ask_list: tool(["List", "Listing", "Listed", "asks"], "question-list"),
  t3_ask_read: tool(["Read", "Reading", "Read", "an ask"], "question-read"),
  t3_ask_answer: tool(["Answer", "Answering", "Answered", "an ask"], "question-respond"),
  t3_ask_withdraw: tool(["Withdraw", "Withdrawing", "Withdrew", "an ask"], "thread-update"),
};
