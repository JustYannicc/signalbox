import type { WaitingCostSignals } from "@t3tools/contracts/waitingCost";
import {
  compareWaitingCost,
  waitingCostFromSignals,
  waitingCostPlacement,
} from "@t3tools/shared/waitingCost";
import { describe, expect, it } from "@effect/vitest";

const now = Date.parse("2026-10-18T12:00:00Z");
const empty: WaitingCostSignals = {
  waitingDependents: 0,
  waitingPeople: 0,
  branch: "current",
  deadline: null,
  expiry: null,
  owner: null,
  override: null,
};
const evaluate = (changes: Partial<WaitingCostSignals>) =>
  waitingCostFromSignals({ ...empty, ...changes }, now);

describe("Ready waiting cost", () => {
  it("leaves unknown costs for classification rather than inventing urgency", () => {
    expect(evaluate({})).toBeNull();
    expect(evaluate({ owner: { kind: "urgency", cost: "none", reason: "No rush." } })).toEqual({
      cost: "none",
      reason: "No rush.",
      source: "owner",
    });
  });

  it("gives facts precedence over owner intent and keeps the strongest fact", () => {
    expect(
      evaluate({
        branch: "stale",
        deadline: now - 1,
        owner: { kind: "urgency", cost: "none", reason: "No rush." },
      }),
    ).toEqual({ cost: "high", reason: "Deadline: 2026-10-18T11:59:59.999Z.", source: "fact" });
    expect(evaluate({ branch: "conflicting" })?.cost).toBe("high");
    expect(evaluate({ waitingDependents: 1 })?.source).toBe("fact");
    expect(evaluate({ waitingPeople: 1 })?.cost).toBe("high");
  });

  it("recomputes as deadlines pass and facts disappear", () => {
    const signals = { ...empty, deadline: now + 1 };
    expect(waitingCostFromSignals(signals, now)?.cost).toBe("low");
    expect(waitingCostFromSignals(signals, now + 1)?.cost).toBe("high");
    expect(evaluate({ expiry: now })?.cost).toBe("high");
    expect(evaluate({ branch: "stale" })?.cost).toBe("low");
    expect(evaluate({ branch: "current" })).toBeNull();
    expect(evaluate({ owner: { kind: "deadline", at: now, reason: "By Sunday." } })).toEqual({
      cost: "high",
      reason: "By Sunday.",
      source: "owner",
    });
  });

  it("holds an override through changed facts until explicitly cleared", () => {
    const override = { cost: "none", reason: "I can leave this until later." } as const;
    const signals = { ...empty, override, waitingDependents: 5, branch: "conflicting" as const };
    expect(waitingCostFromSignals(signals, now)).toEqual({ ...override, source: "override" });
    expect(waitingCostFromSignals({ ...signals, override: null }, now)?.cost).toBe("high");
    expect(waitingCostPlacement({ ...override, source: "override" })).toBe("shelf");
    expect(waitingCostPlacement({ cost: "low", reason: "Waiting.", source: "fact" })).toBe(
      "pipeline",
    );
  });

  it("orders by deadline, dependents, cost and age without model judgments", () => {
    const item = (id: string, changes: Partial<WaitingCostSignals>, createdAt = now) => ({
      id,
      signals: { ...empty, ...changes },
      createdAt,
      assessment: { cost: "low" as const, source: "fact" as const, reason: "Waiting." },
    });
    const items = [
      item("old", {}, now - 1),
      item("new", {}),
      item("dependent", { waitingDependents: 1 }),
      item("deadline", { deadline: now + 1 }),
    ];
    expect(items.toSorted(compareWaitingCost).map(({ id }) => id)).toEqual([
      "deadline",
      "dependent",
      "old",
      "new",
    ]);
    expect(compareWaitingCost(items[0]!, items[0]!)).toBe(0);
  });
});
