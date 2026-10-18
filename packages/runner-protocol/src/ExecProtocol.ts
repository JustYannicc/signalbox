import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128));
const Text = Schema.String.check(Schema.isMaxLength(16_384));
const Environment = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(8_192)),
).check(Schema.isMaxProperties(256));
const Base64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
);
const InputBytes = Base64.check(Schema.isMaxLength(87_384));
const OutputBytes = Base64.check(Schema.isMaxLength(21_848));

const Generation = Schema.Int.check(Schema.isGreaterThan(0));
const Process = {
  generation: Generation,
  processId: Id,
};

/** One non-PTY operating-system process owned by a Runner lease. */
export const ExecCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("start"),
    ...Process,
    requestId: Id,
    executable: Text.check(Schema.isNonEmpty()),
    argv: Schema.Array(Text).check(Schema.isMinLength(1)).check(Schema.isMaxLength(4_096)),
    cwd: Text.check(Schema.isNonEmpty()),
    env: Environment,
  }),
  Schema.Struct({
    type: Schema.Literal("stdin.write"),
    ...Process,
    writeId: Id,
    dataBase64: InputBytes,
  }),
  Schema.Struct({ type: Schema.Literal("stdin.close"), ...Process, requestId: Id }),
  Schema.Struct({
    type: Schema.Literal("signal"),
    ...Process,
    requestId: Id,
    signal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), ...Process, requestId: Id }),
]);
export type ExecCommand = typeof ExecCommand.Type;

export const ExecOperation = Schema.Literals([
  "start",
  "stdin.write",
  "stdin.close",
  "signal",
  "cancel",
]);
export type ExecOperation = typeof ExecOperation.Type;

export const ExecCommandErrorCode = Schema.Literals([
  "stale_generation",
  "request_id_conflict",
  "process_id_conflict",
  "request_receipt_limit",
  "process_not_found",
  "process_exited",
  "workspace_not_ready",
  "invalid_cwd",
  "stdin_closed",
  "write_id_conflict",
  "write_receipt_limit",
  "process_limit",
  "invalid_signal",
  "process_error",
]);
export type ExecCommandErrorCode = typeof ExecCommandErrorCode.Type;

/** The server acknowledges only after the native operation was applied. */
export const ExecReport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ack"),
    ...Process,
    operation: ExecOperation,
    requestId: Schema.optional(Id),
    writeId: Schema.optional(Id),
    applied: Schema.Boolean,
    error: Schema.optional(
      Schema.Struct({
        code: ExecCommandErrorCode,
        message: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256)),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("output"),
    ...Process,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    stream: Schema.Literals(["stdout", "stderr"]),
    dataBase64: OutputBytes,
  }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    ...Process,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    exitCode: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    ...Process,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    signal: Schema.Int.check(Schema.isGreaterThan(0)),
    coreDumped: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    ...Process,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type ExecReport = typeof ExecReport.Type;

export const ExecCommandMessage = Schema.Struct({
  type: Schema.Literal("exec.command"),
  command: ExecCommand,
});
export type ExecCommandMessage = typeof ExecCommandMessage.Type;

export const ExecReportMessage = Schema.Struct({
  type: Schema.Literal("exec.report"),
  report: ExecReport,
});
export type ExecReportMessage = typeof ExecReportMessage.Type;
