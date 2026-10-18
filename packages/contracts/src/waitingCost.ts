import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WaitingCost = Schema.Literals(["none", "low", "high"]);
export type WaitingCost = typeof WaitingCost.Type;

export const WaitingCostPolicy = Schema.Struct({ nearDeadlineMs: NonNegativeInt });
export type WaitingCostPolicy = typeof WaitingCostPolicy.Type;

const Reason = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));
const Deadline = Schema.Number.check(
  Schema.isBetween({ minimum: -8_640_000_000_000_000, maximum: 8_640_000_000_000_000 }),
);

export const WaitingCostAssessment = Schema.Struct({
  cost: WaitingCost,
  reason: Reason,
  source: Schema.Literals(["fact", "owner", "jev", "override"]),
});
export type WaitingCostAssessment = typeof WaitingCostAssessment.Type;

export const WaitingCostOverride = Schema.Struct({ cost: WaitingCost, reason: Reason });
export type WaitingCostOverride = typeof WaitingCostOverride.Type;

export const WaitingCostOwnerIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("urgency"), ...WaitingCostOverride.fields }),
  Schema.Struct({ kind: Schema.Literal("deadline"), at: Deadline, reason: Reason }),
]);
export type WaitingCostOwnerIntent = typeof WaitingCostOwnerIntent.Type;

/** Millisecond timestamps keep evaluation independent of the host clock and time zone. */
export const WaitingCostSignals = Schema.Struct({
  waitingDependents: NonNegativeInt,
  waitingPeople: NonNegativeInt,
  branch: Schema.Literals(["current", "stale", "conflicting"]),
  deadline: Schema.NullOr(Deadline),
  expiry: Schema.NullOr(Deadline),
  owner: Schema.NullOr(WaitingCostOwnerIntent),
  override: Schema.NullOr(WaitingCostOverride),
});
export type WaitingCostSignals = typeof WaitingCostSignals.Type;
