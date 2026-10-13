/**
 * Asking up, as PLACEHOLDER history. When an agent needs something above its
 * level (or in a sibling branch), it asks the agent of the lowest level that
 * covers both (`askLevel`). That agent represents its own level: if sharing is
 * fine it lends access for that one task, and the loan ends with the task; if
 * not, it does the work itself and hands back only what the asker needs.
 * Ending a loan early is local prototype state.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { prototypeStorage } from "../../lib/prototypeStorage";
import { TOP_LEVEL, type LevelKey } from "./levels";

export type AskOutcome =
  /** Lent for the asking task only; it ends when the task does. */
  | { readonly kind: "lent"; readonly lent: string }
  /** Kept the thing and did the work; only the answer went down. */
  | {
      readonly kind: "answered";
      readonly handedBack: string;
      readonly kept: string;
      readonly why: string;
    };

export interface AskUp {
  readonly id: string;
  /** "Today 10:12". */
  readonly at: string;
  /** The level whose agent asked. */
  readonly from: LevelKey;
  /** The level whose agent answered. */
  readonly to: LevelKey;
  /** The thread that needed it; `threadId` opens it at `/shared/$threadId`. */
  readonly task: { readonly title: string; readonly threadId?: string; readonly done: boolean };
  readonly asked: string;
  readonly outcome: AskOutcome;
}

/** Newest first. */
export const ASK_UPS: readonly AskUp[] = [
  {
    id: "ask-board-deck",
    at: "Today 10:12",
    from: "section:work-northwind",
    to: TOP_LEVEL,
    task: { title: "Q4 roadmap with the team", done: false },
    asked: "The board deck came up. What runway and Q4 target does it assume?",
    outcome: {
      kind: "answered",
      handedBack: "Runway (18 months) and the Q4 revenue target",
      kept: "Board deck · Q4",
      why: "It holds layoff plans, and engineers can read this chat.",
    },
  },
  {
    id: "ask-sentry",
    at: "Today 09:40",
    from: "team-project:merchant-portal",
    to: "section:work-northwind",
    task: { title: "Fix refund webhook retries", threadId: "mp-refund-webhooks", done: false },
    asked: "Read the Sentry events for the refund webhook.",
    outcome: { kind: "lent", lent: "Sentry · Northwind (read)" },
  },
  {
    id: "ask-porto",
    at: "Yesterday",
    from: "section:personal",
    to: TOP_LEVEL,
    task: { title: "Porto long weekend", done: false },
    asked: "Which October weekends are free of work travel?",
    outcome: {
      kind: "answered",
      handedBack: "Free weekends: 17–19 and 24–26 Oct",
      kept: "Work calendar",
      why: "Personal doesn't see Work. Only the free dates cross.",
    },
  },
  {
    id: "ask-release-page",
    at: "Mon",
    from: "team-project:terminal-app",
    to: "section:work",
    task: { title: "Update the release checklist", done: true },
    asked: "Read the release process page in Confluence.",
    outcome: { kind: "lent", lent: "Confluence · Work space (read)" },
  },
];

/** Asks this level's agent made or answered, newest first. */
export function asksFor(level: LevelKey): readonly AskUp[] {
  return ASK_UPS.filter((ask) => ask.from === level || ask.to === level);
}

interface AskUpState {
  /** Loans you ended before their task did. */
  ended: Record<string, true>;
  setEnded: (askId: string, ended: boolean) => void;
}

export const useAskUpStore = create<AskUpState>()(
  persist(
    (set) => ({
      ended: {},
      setEnded: (askId, ended) =>
        set((state) => {
          const { [askId]: _was, ...rest } = state.ended;
          return { ended: ended ? { ...rest, [askId]: true } : rest };
        }),
    }),
    { name: "t3code:levels:ask-up:v1", version: 1, storage: prototypeStorage() },
  ),
);

export type LoanState = "active" | "ended-early" | "expired";

/** A loan lasts while its task runs; you can end it sooner. */
export function loanState(ask: AskUp, endedEarly: boolean): LoanState {
  if (ask.task.done) return "expired";
  return endedEarly ? "ended-early" : "active";
}
