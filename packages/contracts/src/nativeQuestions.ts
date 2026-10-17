import * as Schema from "effect/Schema";

export const NativeQuestionMetadata = Schema.Struct({
  isSecret: Schema.optional(Schema.Boolean),
  isBlocking: Schema.optional(Schema.Boolean),
  recommendation: Schema.optional(Schema.String),
});

export const NativeQuestionOptionPreview = Schema.String;
