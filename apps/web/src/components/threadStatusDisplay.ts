/**
 * The one status vocabulary for thread rows, shared by the Pipeline and Home:
 * label, icon, color, and priority per state. States come from
 * `resolveSidebarThreadStatus`, then (for otherwise ready threads) Plan ready,
 * Woke, and unread Done. "Waiting" (on someone else) only comes from
 * multiplayer data; a single-user thread never produces it.
 *
 * Status hues follow the system-wide convention set by sidebar v1 and the
 * mobile Live Activity/widgets (amber approval, indigo input, sky working) so a
 * thread reads the same color everywhere it surfaces. Nothing here animates.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EyeIcon,
  HourglassIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { isLatestTurnSettled } from "../session-logic";
import { shouldRecedeSidebarThread, type SidebarThreadStatus } from "./Sidebar.logic";

export type ThreadDisplayStatus =
  | "approval"
  | "input"
  | "failed"
  | "plan"
  | "woke"
  | "waiting"
  | "working"
  | "monitoring"
  | "done";

export interface ThreadStatusDisplay {
  /** Short label shown in the row. */
  readonly label: string;
  /** Tooltip text. */
  readonly description: string;
  readonly icon: LucideIcon;
  readonly className: string;
  /** Counts toward "N need you" rollups. */
  readonly needsYou: boolean;
  /** Higher wins when several statuses compete for one slot. */
  readonly priority: number;
}

export const THREAD_STATUS_DISPLAY: Record<ThreadDisplayStatus, ThreadStatusDisplay> = {
  approval: {
    label: "Approval",
    description: "Needs your approval",
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
    needsYou: true,
    priority: 9,
  },
  input: {
    label: "Input",
    description: "Needs your input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
    needsYou: true,
    priority: 8,
  },
  failed: {
    label: "Failed",
    description: "Failed",
    icon: CircleAlertIcon,
    className: "text-red-700 dark:text-red-300",
    needsYou: true,
    priority: 7,
  },
  plan: {
    label: "Plan ready",
    description: "A plan is ready for your review",
    icon: ListChecksIcon,
    className: "text-violet-600 dark:text-violet-300",
    needsYou: true,
    priority: 6,
  },
  woke: {
    label: "Back",
    description: "Back from Later",
    icon: AlarmClockIcon,
    className: "text-warning-foreground",
    needsYou: true,
    priority: 5,
  },
  waiting: {
    label: "Waiting",
    description: "Waiting on someone else",
    icon: HourglassIcon,
    className: "text-muted-foreground",
    needsYou: false,
    priority: 4,
  },
  working: {
    label: "Working",
    description: "Working",
    icon: CircleDashedIcon,
    className: "text-sky-600 dark:text-sky-400",
    needsYou: false,
    priority: 3,
  },
  monitoring: {
    // Calm background presence, not active progress, so the label stays at full strength.
    label: "Monitoring",
    description: "Monitoring in the background",
    icon: EyeIcon,
    className: "text-foreground dark:text-white",
    needsYou: false,
    priority: 2,
  },
  done: {
    label: "Done",
    description: "Finished · unread",
    icon: CircleCheckIcon,
    className: "text-emerald-700 dark:text-emerald-300",
    needsYou: false,
    priority: 1,
  },
};

type PlanInput = Pick<
  EnvironmentThreadShell,
  "hasPendingUserInput" | "interactionMode" | "latestTurn" | "session" | "hasActionableProposedPlan"
>;

/** An actionable plan prompt on a settled turn. */
export function threadHasPlanReady(thread: PlanInput): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  );
}

export function resolveThreadDisplayStatus(input: {
  status: SidebarThreadStatus;
  planReady: boolean;
  isWoke: boolean;
  isUnread: boolean;
}): ThreadDisplayStatus | null {
  if (input.status !== "ready") return input.status;
  if (input.planReady) return "plan";
  if (input.isWoke) return "woke";
  return input.isUnread ? "done" : null;
}

const RECEDE_STATUS: Record<ThreadDisplayStatus, SidebarThreadStatus> = {
  approval: "approval",
  input: "input",
  failed: "failed",
  // A plan waits on you like input does, so it never recedes.
  plan: "input",
  woke: "ready",
  waiting: "working",
  working: "working",
  monitoring: "monitoring",
  done: "ready",
};

/** Row weight from attention, with the Pipeline's rules. */
export function threadRowRecedes(status: ThreadDisplayStatus | null, isActive: boolean): boolean {
  return shouldRecedeSidebarThread({
    status: status ? RECEDE_STATUS[status] : "ready",
    isUnread: status === "done",
    isWoke: status === "woke",
    isActive,
    isSelected: false,
  });
}
