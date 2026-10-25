import type { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Schema from "effect/Schema";

/** Context membership is resolved for the acting person at execution, never from a thread projection. */
export interface Actor {
  readonly userId: string;
  readonly contextIds: ReadonlyArray<SignalboxContextId>;
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  {},
) {
  override get message(): string {
    return "Thread not found.";
  }
}

export class ThreadCommandRejectedError extends Schema.TaggedError<ThreadCommandRejectedError>()(
  "ThreadCommandRejectedError",
  { commandId: Schema.String, commandType: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }

  static forCommand(
    command: { readonly id: string; readonly type: string },
    reason: string,
  ): ThreadCommandRejectedError {
    return new ThreadCommandRejectedError({
      commandId: command.id,
      commandType: command.type,
      reason,
    });
  }
}

export class ThreadObjectError extends Schema.TaggedError<ThreadObjectError>()(
  "ThreadObjectError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Thread object call failed (${this.operation}).`;
  }
}
