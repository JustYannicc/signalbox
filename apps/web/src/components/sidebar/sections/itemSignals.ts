/**
 * PLACEHOLDER status signals for fixture team threads: their Pipeline status,
 * whether someone else is the one needed ("waiting on Samir"), and @mentions of
 * you. Real threads derive status from the Pipeline resolver instead.
 */
import type { HomeItemStatus } from "./homeStatus";

export interface ItemSignals {
  readonly status?: HomeItemStatus;
  /** Someone other than you has to act next. */
  readonly waitingOnId?: string;
  /** Who @mentioned you in the thread. */
  readonly mentionedById?: string;
}

const TEAM_THREAD_SIGNALS: Readonly<Record<string, ItemSignals>> = {
  "mp-refund-webhooks": { status: "working", mentionedById: "flo" },
  "mp-payout-copy": { waitingOnId: "sam" },
  "mp-settlement-pagination": { status: "plan" },
  "ta-printer-fix": { status: "approval" },
  "ta-neptune-questions": { status: "failed" },
  "ta-offline-mode": { status: "done" },
};

export function signalsForTeamThread(threadId: string): ItemSignals {
  return TEAM_THREAD_SIGNALS[threadId] ?? {};
}
