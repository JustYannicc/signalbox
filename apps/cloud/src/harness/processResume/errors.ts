import * as Schema from "effect/Schema";

export type HarnessProcessResumeReason =
  | "cancelled"
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

export class HarnessProcessResumeRunStoreError extends Schema.TaggedError<HarnessProcessResumeRunStoreError>()(
  "HarnessProcessResumeRunStoreError",
  {
    stage: Schema.Literals(["input", "preflight", "drain", "replacement"]),
    reason: Schema.Literals([
      "invalid-input",
      "authority-changed",
      "publisher-changed",
      "request-changed",
      "checkpoint-changed",
      "unknown",
    ]),
  },
) {
  override get message(): string {
    return "RunStore resume authority or request state could not be confirmed.";
  }
}

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
      "cancelled",
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
