import * as Schema from "effect/Schema";

export type HarnessProcessResumeReason =
  | "invalid-input"
  | "driver-failed"
  | "indeterminate"
  | "stale-control"
  | "identity-or-checkpoint-mismatch"
  | "prepared-release-mismatch"
  | "publication-pending"
  | "activation-failed"
  | "cleanup-failed"
  | "recovery-write-failed";

export class HarnessProcessResumeDriverError extends Schema.TaggedError<HarnessProcessResumeDriverError>()(
  "HarnessProcessResumeDriverError",
  {
    operation: Schema.Literals([
      "fence",
      "drain",
      "settlement",
      "checkpoint",
      "fresh-open",
      "fresh-verification",
      "publication",
      "activation",
      "cleanup",
      "recovery",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Harness process resume dependency failed.";
  }
}

export class HarnessProcessResumeError extends Schema.TaggedError<HarnessProcessResumeError>()(
  "HarnessProcessResumeError",
  {
    stage: Schema.Literals([
      "fence",
      "drain",
      "settlement",
      "checkpoint",
      "fresh-open",
      "fresh-verification",
      "publication",
      "activation",
      "cleanup",
      "recovery",
    ]),
    reason: Schema.Literals([
      "invalid-input",
      "driver-failed",
      "indeterminate",
      "stale-control",
      "identity-or-checkpoint-mismatch",
      "prepared-release-mismatch",
      "publication-pending",
      "activation-failed",
      "cleanup-failed",
      "recovery-write-failed",
    ]),
    recoverable: Schema.Literal(true),
    recovery: Schema.Literals(["recorded", "claim-changed", "record-failed", "not-recorded"]),
    failedStage: Schema.optionalKey(
      Schema.Literals([
        "fence",
        "drain",
        "settlement",
        "checkpoint",
        "fresh-open",
        "fresh-verification",
        "publication",
        "activation",
        "cleanup",
        "recovery",
      ]),
    ),
    priorReason: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
    priorCause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Harness process resume stopped in a recoverable lifecycle state.";
  }
}
