import * as Schema from "effect/Schema";

export class ThreadObjectError extends Schema.TaggedError<ThreadObjectError>()(
  "ThreadObjectError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread object call failed (${this.operation}).`;
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  {},
) {
  override get message(): string {
    return "Thread not found.";
  }
}
