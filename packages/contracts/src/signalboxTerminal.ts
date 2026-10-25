import * as Schema from "effect/Schema";

export class TerminalOperationError extends Schema.TaggedError<TerminalOperationError>()(
  "TerminalOperationError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "unavailable",
      "command_id_required",
      "command_conflict",
      "limit",
      "input_limit",
      "pending_limit",
      "generation_required",
      "stale_generation",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "generation_required":
        return "Terminal input needs the generation from its current snapshot.";
      case "stale_generation":
        return "This input belongs to an older terminal. Read the current snapshot before typing.";
      case "command_id_required":
        return "Terminal input needs a command id. Reuse it when retrying.";
      case "command_conflict":
        return "This terminal command id was already used for different input.";
      case "limit":
        return "This thread has reached its terminal limit.";
      case "input_limit":
        return "This terminal has reached its input limit. Restart it to keep typing.";
      case "pending_limit":
        return "Too much terminal input is waiting. Try again when it has finished.";
      case "unavailable":
        return "The terminal is unavailable right now.";
    }
  }
}
