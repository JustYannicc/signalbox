import * as Schema from "effect/Schema";

export const NativeQuestionMetadata = Schema.Struct({
  isSecret: Schema.optional(Schema.Boolean),
  isBlocking: Schema.optional(Schema.Boolean),
});

export const NativeQuestionOptionPreview = Schema.String;
