import type {
  WaitingCost,
  WaitingCostAssessment,
  WaitingCostPolicy,
  WaitingCostSignals,
} from "@t3tools/contracts/waitingCost";

const weight = { none: 0, low: 1, high: 2 } as const;

export const DEFAULT_WAITING_COST_POLICY: WaitingCostPolicy = {
  nearDeadlineMs: 24 * 60 * 60 * 1_000,
};

/** Null is the only path that needs semantic classification. An override survives signal changes. */
export function waitingCostFromSignals(
  signals: WaitingCostSignals,
  now: number,
  policy: WaitingCostPolicy = DEFAULT_WAITING_COST_POLICY,
): WaitingCostAssessment | null {
  if (signals.override !== null) return { ...signals.override, source: "override" };

  const facts: WaitingCostAssessment[] = [];
  const fact = (cost: WaitingCost, reason: string) => facts.push({ cost, reason, source: "fact" });
  const near = (at: number) => at - now <= policy.nearDeadlineMs;
  if (signals.waitingDependents > 0)
    fact(
      "high",
      signals.waitingDependents === 1
        ? "1 dependent task is waiting."
        : `${signals.waitingDependents} dependent tasks are waiting.`,
    );
  if (signals.waitingPeople > 0)
    fact(
      "high",
      signals.waitingPeople === 1
        ? "1 person is waiting."
        : `${signals.waitingPeople} people are waiting.`,
    );
  if (signals.branch === "conflicting") fact("high", "The branch has merge conflicts.");
  if (signals.branch === "stale") fact("low", "The branch is stale.");
  if (signals.deadline !== null)
    fact(
      near(signals.deadline) ? "high" : "low",
      signals.deadline <= now
        ? "The deadline has passed."
        : near(signals.deadline)
          ? "The deadline is approaching."
          : "There is a deadline.",
    );
  if (signals.expiry !== null)
    fact(
      signals.expiry <= now ? "none" : near(signals.expiry) ? "high" : "low",
      signals.expiry <= now
        ? "The opportunity has expired."
        : near(signals.expiry)
          ? "The opportunity expires soon."
          : "The opportunity has an expiry.",
    );
  // A weak fact cannot hide a stronger one; equal costs retain a stable reason.
  const strongest = facts.sort((a, b) => weight[b.cost] - weight[a.cost])[0];
  if (strongest !== undefined) return strongest;

  const owner = signals.owner;
  if (owner === null) return null;
  return {
    cost: owner.kind === "urgency" ? owner.cost : near(owner.at) ? "high" : "low",
    reason: owner.reason,
    source: "owner",
  };
}

export const waitingCostPlacement = (assessment: WaitingCostAssessment) =>
  assessment.cost === "none" ? ("shelf" as const) : ("pipeline" as const);

export interface WaitingCostOrderItem {
  readonly id: string;
  readonly createdAt: number;
  readonly signals: WaitingCostSignals;
  readonly assessment: WaitingCostAssessment;
}

const deadlineOf = ({ signals }: WaitingCostOrderItem, now: number) =>
  Math.min(
    signals.deadline ?? Infinity,
    signals.expiry !== null && signals.expiry > now ? signals.expiry : Infinity,
    signals.owner?.kind === "deadline" ? signals.owner.at : Infinity,
  );

/** Callers filter shelf items before ordering the person's pipeline. */
export function compareWaitingCost(
  a: WaitingCostOrderItem,
  b: WaitingCostOrderItem,
  now: number,
): number {
  const deadlines = deadlineOf(a, now) - deadlineOf(b, now);
  if (!Number.isNaN(deadlines) && deadlines !== 0) return deadlines;
  return (
    b.signals.waitingDependents - a.signals.waitingDependents ||
    weight[b.assessment.cost] - weight[a.assessment.cost] ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}
