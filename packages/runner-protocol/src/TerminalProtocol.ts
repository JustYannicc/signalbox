import { PositiveInt, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { DriveAccess } from "./DriveProtocol.ts";
import { jsonCodec } from "./jsonCodec.ts";

const BoundedText = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256));
const TerminalId = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128));
const TerminalCols = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRows = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalEnv = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(Schema.isMaxLength(128)),
  Schema.String.check(Schema.isMaxLength(8_192)),
).check(Schema.isMaxProperties(128));

const CommandFence = {
  threadId: ThreadId,
  terminalId: TerminalId,
  /** The terminal process generation, independent of the Runner lease. */
  generation: PositiveInt,
  /** The Runner lease generation which opened this terminal. */
  leaseGeneration: PositiveInt,
};

/** Commands the thread can replay safely when its Runner socket reconnects. */
export const TerminalCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("open"),
    ...CommandFence,
    drive: DriveAccess,
    cols: TerminalCols,
    rows: TerminalRows,
    env: Schema.optional(TerminalEnv),
  }),
  Schema.Struct({
    type: Schema.Literal("write"),
    ...CommandFence,
    commandId: BoundedText,
    data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    ...CommandFence,
    cols: TerminalCols,
    rows: TerminalRows,
  }),
  Schema.Struct({ type: Schema.Literal("clear"), ...CommandFence }),
  Schema.Struct({ type: Schema.Literal("close"), ...CommandFence }),
]);
export type TerminalCommand = typeof TerminalCommand.Type;

export const TerminalCommandErrorCode = Schema.Literals([
  "thread_mismatch",
  "stale_lease_generation",
  "stale_terminal_generation",
  "terminal_generation_conflict",
  "command_id_conflict",
  "write_receipt_limit",
  "request_id_conflict",
  "terminal_not_open",
  "terminal_error",
]);
export type TerminalCommandErrorCode = typeof TerminalCommandErrorCode.Type;

export const TerminalCommandResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("opened"),
    snapshot: TerminalSessionSnapshot,
  }),
  Schema.Struct({ type: Schema.Literal("written") }),
  Schema.Struct({ type: Schema.Literal("resized") }),
  Schema.Struct({ type: Schema.Literal("cleared") }),
  Schema.Struct({ type: Schema.Literal("closed") }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: TerminalCommandErrorCode,
    message: BoundedText,
  }),
]);
export type TerminalCommandResult = typeof TerminalCommandResult.Type;

/** Ordered events after the snapshot returned by `open`. */
export const TerminalEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    exitCode: Schema.NullOr(Schema.Int),
    exitSignal: Schema.NullOr(Schema.Int),
  }),
  Schema.Struct({ type: Schema.Literal("cleared") }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("activity"),
    hasRunningSubprocess: Schema.Boolean,
    label: Schema.String.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({ type: Schema.Literal("closed") }),
]);
export type TerminalEvent = typeof TerminalEvent.Type;

/** A result answers a request; an event has its own sequence within a terminal generation. */
export const TerminalReport = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    terminalId: TerminalId,
    generation: PositiveInt,
    leaseGeneration: PositiveInt,
    snapshot: TerminalSessionSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    requestId: BoundedText,
    terminalId: TerminalId,
    generation: PositiveInt,
    leaseGeneration: PositiveInt,
    commandId: Schema.optional(BoundedText),
    result: TerminalCommandResult,
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    terminalId: TerminalId,
    generation: PositiveInt,
    leaseGeneration: PositiveInt,
    sequence: PositiveInt,
    event: TerminalEvent,
  }),
]);
export type TerminalReport = typeof TerminalReport.Type;

export const TerminalCommandMessage = Schema.Struct({
  type: Schema.Literal("terminal.command"),
  requestId: BoundedText,
  command: TerminalCommand,
});
export type TerminalCommandMessage = typeof TerminalCommandMessage.Type;

export const TerminalReportMessage = Schema.Struct({
  type: Schema.Literal("terminal.report"),
  report: TerminalReport,
});
export type TerminalReportMessage = typeof TerminalReportMessage.Type;

export const terminalCommandFrame = jsonCodec(TerminalCommandMessage);
export const terminalReportFrame = jsonCodec(TerminalReportMessage);
