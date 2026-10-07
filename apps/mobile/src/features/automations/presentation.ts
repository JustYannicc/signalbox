import type { AutomationDisplayStatus } from "@t3tools/client-runtime/automations/status";

/** One colour per status, shared by the list, run rows, chat and diagram cards. */

export const STATUS_DOT_CLASS: Record<AutomationDisplayStatus, string> = {
  needsYou: "bg-adaptive-amber-700-400",
  working: "bg-adaptive-sky-600-400",
  waiting: "bg-adaptive-sky-600-400",
  done: "bg-adaptive-emerald-600-400",
  failed: "bg-adaptive-rose-600-400",
  cancelled: "bg-foreground-muted",
};

export const STATUS_TEXT_CLASS: Record<AutomationDisplayStatus, string> = {
  needsYou: "text-adaptive-amber-700-400",
  working: "text-adaptive-sky-600-400",
  waiting: "text-adaptive-sky-600-400",
  done: "text-adaptive-emerald-600-400",
  failed: "text-adaptive-rose-600-400",
  cancelled: "text-foreground-muted",
};
