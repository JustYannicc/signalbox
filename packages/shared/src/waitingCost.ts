import type { WaitingCostAssessment, WaitingCostSignals } from "@t3tools/contracts/waitingCost";
import * as DateTime from "effect/DateTime";

const weight = { none: 0, low: 1, high: 2 } as const;

/** Null is the only path that needs semantic classification. An override survives signal changes. */
export function waitingCostFromSignals(
  signals: WaitingCostSignals,
  now: number,
): WaitingCostAssessment | null {
  if (signals.override !== null) return { ...signals.override, source: "override" };

  const facts: WaitingCostAssessment[] = [];
  const fact = (cost: "low" | "high", reason: string) =>
    facts.push({ cost, reason, source: "fact" });
  if (signals.waitingDependents > 0)
    fact("high", `${signals.waitingDependents} dependent task(s) waiting.`);
  if (signals.waitingPeople > 0) fact("high", `${signals.waitingPeople} person(s) waiting.`);
  if (signals.branch === "conflicting") fact("high", "The branch has merge conflicts.");
  if (signals.branch === "stale") fact("low", "The branch is stale.");
  for (const [name, at] of [
    ["Deadline", signals.deadline],
    ["Expiry", signals.expiry],
  ] as const) {
    if (at !== null)
      fact(at <= now ? "high" : "low", `${name}: ${DateTime.formatIso(DateTime.makeUnsafe(at))}.`);
  }
  // A weak fact cannot hide a stronger one; equal costs retain a stable reason.
  const strongest = facts.sort((a, b) => weight[b.cost] - weight[a.cost])[0];
  if (strongest !== undefined) return strongest;

  const owner = signals.owner;
  if (owner === null) return null;
  return {
    cost: owner.kind === "urgency" ? owner.cost : owner.at <= now ? "high" : "low",
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

const deadlineOf = ({ signals }: WaitingCostOrderItem) =>
  Math.min(
    signals.deadline ?? Infinity,
    signals.expiry ?? Infinity,
    signals.owner?.kind === "deadline" ? signals.owner.at : Infinity,
  );

/** Callers filter shelf items before ordering the person's pipeline. */
export function compareWaitingCost(a: WaitingCostOrderItem, b: WaitingCostOrderItem): number {
  const deadlines = deadlineOf(a) - deadlineOf(b);
  if (!Number.isNaN(deadlines) && deadlines !== 0) return deadlines;
  return (
    b.signals.waitingDependents - a.signals.waitingDependents ||
    weight[b.assessment.cost] - weight[a.assessment.cost] ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}
