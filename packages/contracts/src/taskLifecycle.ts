import * as Schema from "effect/Schema";

import {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
} from "./orchestrationV2.ts";

const TaskLifecycleText = Schema.String.check(Schema.isMaxLength(2_000));

export const TaskLifecycleAction = Schema.Literals([
  "read",
  "propose",
  "complete",
  "reopen",
  "record-settle",
]);
export const TaskLifecycleSettleReason = Schema.Literals(["dropped", "done-enough"]);

/** The editable condition is an automation input, so this contract stays trigger-agnostic. */
export const TaskLifecycleDoneCondition = Schema.Struct({
  summary: TaskLifecycleText,
  automationId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  runId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  input: Schema.optional(Schema.Unknown),
});

export const TaskLifecycleSettlementHistoryEntry = Schema.Struct({
  outcome: Schema.NullOr(TaskLifecycleText),
  reason: TaskLifecycleSettleReason,
  uncertain: Schema.Boolean,
  settledAt: Schema.String,
  generation: Schema.Int,
  recordedAt: Schema.String,
});

export const TaskLifecycleRecord = Schema.Struct({
  threadId: Schema.String,
  condition: Schema.NullOr(TaskLifecycleDoneCondition),
  outcome: Schema.NullOr(TaskLifecycleText),
  reason: Schema.NullOr(TaskLifecycleSettleReason),
  uncertain: Schema.Boolean,
  settledAt: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  updatedAt: Schema.String,
  settlementHistory: Schema.Array(TaskLifecycleSettlementHistoryEntry),
});

export const TaskLifecycleInput = Schema.Struct({
  threadId: Schema.String,
  action: TaskLifecycleAction,
  summary: Schema.optional(TaskLifecycleText),
  automationId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  runId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  input: Schema.optional(Schema.Unknown),
  outcome: Schema.optional(TaskLifecycleText),
  reason: Schema.optional(Schema.NullOr(TaskLifecycleSettleReason)),
  uncertain: Schema.optional(Schema.Boolean),
  settledAt: Schema.optional(Schema.String),
  expectedGeneration: Schema.optional(Schema.Int),
  expectedUpdatedAt: Schema.optional(Schema.String),
  commandId: Schema.optional(Schema.String),
  includeContext: Schema.optional(Schema.Boolean),
});

export const TaskLifecycleResult = Schema.Struct({
  record: Schema.NullOr(TaskLifecycleRecord),
  applied: Schema.Boolean,
  thread: OrchestrationV2ThreadShell,
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runs: Schema.Array(OrchestrationV2Run),
  kind: Schema.Literals(["chat", "task"]),
  // False where the host can't run model steps yet (#971).
  modelSteps: Schema.optional(Schema.Boolean),
});

export type TaskLifecycleAction = typeof TaskLifecycleAction.Type;
export type TaskLifecycleSettleReason = typeof TaskLifecycleSettleReason.Type;
export type TaskLifecycleDoneCondition = typeof TaskLifecycleDoneCondition.Type;
export type TaskLifecycleSettlementHistoryEntry = typeof TaskLifecycleSettlementHistoryEntry.Type;
export type TaskLifecycleRecord = typeof TaskLifecycleRecord.Type;
export type TaskLifecycleInput = typeof TaskLifecycleInput.Type;
export type TaskLifecycleResult = typeof TaskLifecycleResult.Type;
