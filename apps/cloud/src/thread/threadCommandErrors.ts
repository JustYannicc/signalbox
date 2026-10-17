import * as Schema from "effect/Schema";

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
