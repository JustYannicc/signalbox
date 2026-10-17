import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class CollaborationError extends Schema.TaggedError<CollaborationError>()(
  "CollaborationError",
  {
    code: OrchestratorMcpFailure.fields.code,
    message: Schema.String,
    operation: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  static unavailable(operation: string, cause: unknown): CollaborationError {
    return new CollaborationError({
      code: "orchestration_error",
      message: "Cloud threads are unavailable right now. Try again.",
      operation,
      cause,
    });
  }

  static fromInbox(operation: string, cause: { readonly code: string }): CollaborationError {
    return new CollaborationError({
      code: cause.code === "not_found" ? "thread_not_found" : "orchestration_error",
      message:
        cause.code === "not_found"
          ? "Thread not found."
          : "Cloud threads are unavailable right now. Try again.",
      operation,
      cause,
    });
  }
}
