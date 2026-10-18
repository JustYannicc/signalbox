import * as Schema from "effect/Schema";

export class RunnerConnectionError extends Schema.TaggedError<RunnerConnectionError>()(
  "RunnerConnectionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
