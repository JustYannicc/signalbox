import * as Schema from "effect/Schema";

import { DRIVE_API_PREFIX } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

/** Learner calls from a thread's machine. The cloud derives the learner's scope from its drive token. */
export const LEARNER_PATHS = {
  tool: `${DRIVE_API_PREFIX}/learner/tool`,
} as const;

export const LEARNER_TOOL_NAMES = [
  "learner_log_event",
  "learner_query",
  "learner_add_statement",
  "learner_lenses",
] as const;

export const LearnerLogEventInput = Schema.Struct({
  /** Stable within the authenticated thread so a retried delivery cannot teach twice. */
  eventId: Schema.String,
  source: Schema.String,
  kind: Schema.Literals(["observation", "draft", "human_action"]),
  content: Schema.String,
  input: Schema.optional(Schema.String),
  objectId: Schema.optional(Schema.String),
  usedLensId: Schema.optional(Schema.String),
});

export const LearnerQueryInput = Schema.Struct({ task: Schema.String });

export const LearnerAddStatementInput = Schema.Struct({
  text: Schema.String,
  reason: Schema.String,
});

export const LearnerLensesInput = Schema.Struct({
  /** Only a descendant folder may be requested; the cloud authorizes it. */
  folderId: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
});

export const LearnerToolRequest = Schema.Struct({
  name: Schema.Literals(LEARNER_TOOL_NAMES),
  input: Schema.Unknown,
});
export type LearnerToolRequest = typeof LearnerToolRequest.Type;

export const LearnerToolResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("ok"), result: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal("failed"), message: Schema.String }),
]);
export type LearnerToolResult = typeof LearnerToolResult.Type;

export const learnerJson = {
  toolRequest: jsonCodec(LearnerToolRequest),
  tool: jsonCodec(LearnerToolResult),
};
