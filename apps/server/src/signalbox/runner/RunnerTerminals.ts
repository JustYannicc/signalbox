import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { DriveAccess } from "@signalbox/runner-protocol/DriveProtocol";
import type {
  TerminalCommandMessage,
  TerminalReport,
} from "@signalbox/runner-protocol/TerminalProtocol";
import { TerminalCommand } from "@signalbox/runner-protocol/TerminalProtocol";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import * as TerminalManager from "../../terminal/Manager.ts";
import type { RunnerDrive } from "./RunnerDrive.ts";
import { saveFailureReason } from "./RunnerTurnDrive.ts";
import {
  eventFor,
  publicSnapshot,
  RunnerTerminalReports,
  type TerminalState,
} from "./RunnerTerminalReports.ts";
import { RunnerConnectionError } from "./RunnerConnectionError.ts";

const isRunnerConnectionError = Schema.is(RunnerConnectionError);

/** Terminal commands for one Runner lease, backed by the normal server PTY manager. */
export interface RunnerTerminals {
  readonly handleCommand: (
    message: TerminalCommandMessage,
  ) => Effect.Effect<void, RunnerConnectionError>;
  /** Sends current snapshots before replaying the bounded event backlog after welcome. */
  readonly replayEvents: (
    activate: Effect.Effect<void>,
  ) => Effect.Effect<void, RunnerConnectionError>;
  /** Saves the shared drive before the cloud releases the Runner lease. */
  readonly drain: Effect.Effect<ReadonlyArray<string>>;
}

export interface RunnerTerminalsInput {
  readonly threadId: string;
  readonly leaseGeneration: number;
  /** Runner-controlled workspace root; no terminal command may supply a cwd. */
  readonly cwd: string;
  readonly manager: TerminalManager.TerminalManager["Service"];
  /** Returns the same drive the turn runner uses, preparing it only when this session has not. */
  readonly prepareDrive: (access: DriveAccess) => Effect.Effect<RunnerDrive, RunnerConnectionError>;
  readonly watchDrive: (
    drive: RunnerDrive,
    onSavedAgain?: Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly emit: (report: TerminalReport) => Effect.Effect<void, RunnerConnectionError>;
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const encodeCommandJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(TerminalCommand)),
);

export const makeRunnerTerminals = Effect.fn("makeRunnerTerminals")(function* (
  input: RunnerTerminalsInput,
): Effect.fn.Return<RunnerTerminals, never, Scope.Scope | Crypto.Crypto> {
  const commandLock = yield* Semaphore.make(1);
  const eventLock = yield* Semaphore.make(1);
  const terminals = new Map<string, TerminalState>();
  const reports = new RunnerTerminalReports();
  const crypto = yield* Crypto.Crypto;
  let drive: RunnerDrive | null = null;
  const fingerprint = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(
        () => new RunnerConnectionError({ message: "Could not fingerprint a terminal command." }),
      ),
    );

  const saveDrive = () =>
    drive === null
      ? Effect.void
      : drive.saveNow.pipe(
          Effect.mapError(
            () =>
              new RunnerConnectionError({
                message: "Terminal files could not be saved. The close command will retry.",
              }),
          ),
        );

  const handleManagerEvent = (
    state: TerminalState,
    event: Exclude<TerminalAttachStreamEvent, { readonly type: "snapshot" }>,
  ) =>
    eventLock.withPermits(1)(
      Effect.gen(function* () {
        if (terminals.get(state.terminalId) !== state) return;
        if (event.sequence !== undefined) {
          if (event.sequence <= state.managerSequence) return;
          state.managerSequence = event.sequence;
        }
        const reportEvent = eventFor(event);
        if (event.type === "closed") {
          state.closed = true;
          state.snapshot = {
            ...state.snapshot,
            status: "exited",
            pid: null,
            updatedAt: nowIso(),
          };
        }
        if (reportEvent === null) return;
        if (reportEvent.type === "exit") state.exited = true;
        if (reportEvent.type === "error") state.closed = true;
        const appended = reports.appendEvent(state, reportEvent, terminals.values(), nowIso());
        for (const report of appended) {
          yield* input.emit(report).pipe(Effect.catchCause(() => Effect.void));
        }
      }),
    );

  const openTerminal = (command: Extract<TerminalCommand, { readonly type: "open" }>) =>
    Effect.gen(function* () {
      const current = terminals.get(command.terminalId);
      if (current !== undefined) {
        if (command.generation < current.generation) {
          return {
            type: "error",
            code: "stale_terminal_generation",
            message: "This terminal generation is stale.",
          } as const;
        }
        if (command.generation === current.generation) {
          if (current.closed) {
            return {
              type: "error",
              code: "terminal_generation_conflict",
              message: "This terminal generation is already closed.",
            } as const;
          }
          return { type: "opened", snapshot: current.snapshot } as const;
        }
        yield* input.manager
          .close({
            threadId: input.threadId,
            terminalId: current.terminalId,
            deleteHistory: true,
          })
          .pipe(
            Effect.mapError(
              () =>
                new RunnerConnectionError({
                  message:
                    "The previous terminal process could not be closed. The open command will retry.",
                }),
            ),
          );
        current.unsubscribe?.();
        current.unsubscribe = null;
        current.closed = true;
        yield* saveDrive();
        reports.removeEvents(current.terminalId, current.generation);
        reports.removeWrites(current.terminalId, current.generation);
      }

      drive = yield* input.prepareDrive(command.drive);
      yield* input.watchDrive(drive, reportSnapshots);
      const env = {
        ...command.env,
        T3CODE_PROJECT_ROOT: input.cwd,
        T3CODE_WORKTREE_PATH: input.cwd,
      };
      const opened = yield* input.manager.open({
        threadId: input.threadId,
        terminalId: command.terminalId,
        cwd: input.cwd,
        cols: command.cols,
        rows: command.rows,
        env,
      });
      const state: TerminalState = {
        terminalId: command.terminalId,
        generation: command.generation,
        leaseGeneration: command.leaseGeneration,
        managerSequence: opened.sequence ?? 0,
        reportSequence: 0,
        snapshot: { ...publicSnapshot(opened), sequence: 0 },
        ready: false,
        closed: false,
        exited: false,
        unsubscribe: null,
        pendingReports: [],
        controlReceipts: new Map(),
      };
      terminals.set(command.terminalId, state);
      reports.removeEvents(command.terminalId);

      let observedSnapshot: TerminalSessionSnapshot | null = null;
      state.unsubscribe = yield* input.manager.observeStream(
        { threadId: input.threadId, terminalId: command.terminalId },
        (event) => {
          if (event.type === "snapshot") {
            observedSnapshot = event.snapshot;
            state.managerSequence = event.snapshot.sequence ?? state.managerSequence;
            state.snapshot = {
              ...publicSnapshot(event.snapshot),
              sequence: state.reportSequence,
            };
            return Effect.void;
          }
          return handleManagerEvent(state, event);
        },
      );
      if (observedSnapshot !== null) {
        state.snapshot = {
          ...publicSnapshot(observedSnapshot),
          sequence: state.reportSequence,
        };
      }
      return { type: "opened", snapshot: state.snapshot } as const;
    });

  const closeTerminal = (command: Extract<TerminalCommand, { readonly type: "close" }>) =>
    Effect.gen(function* () {
      const current = terminals.get(command.terminalId);
      if (current === undefined) return { type: "closed" } as const;
      if (command.generation < current.generation) {
        return {
          type: "error",
          code: "stale_terminal_generation",
          message: "This terminal generation is stale.",
        } as const;
      }
      if (command.generation > current.generation) {
        return {
          type: "error",
          code: "stale_terminal_generation",
          message: "This terminal generation has not been opened.",
        } as const;
      }
      yield* input.manager.close({
        threadId: input.threadId,
        terminalId: command.terminalId,
        deleteHistory: true,
      });
      current.unsubscribe?.();
      current.unsubscribe = null;
      if (!current.closed) {
        current.closed = true;
        current.snapshot = {
          ...current.snapshot,
          status: "exited",
          pid: null,
          updatedAt: nowIso(),
        };
      }
      yield* saveDrive();
      return { type: "closed" } as const;
    });

  const runCommand = (command: TerminalCommand) =>
    Effect.gen(function* () {
      if (command.threadId !== input.threadId) {
        return {
          type: "error",
          code: "thread_mismatch",
          message: "This command belongs to another thread.",
        } as const;
      }
      if (command.leaseGeneration !== input.leaseGeneration) {
        return {
          type: "error",
          code: "stale_lease_generation",
          message: "This Runner lease is stale.",
        } as const;
      }

      if (command.type === "open") return yield* openTerminal(command);
      const current = terminals.get(command.terminalId);
      if (current === undefined) {
        if (command.type === "close") return { type: "closed" } as const;
        return {
          type: "error",
          code: "terminal_not_open",
          message: "The terminal is not open.",
        } as const;
      }
      if (command.generation !== current.generation) {
        return {
          type: "error",
          code: "stale_terminal_generation",
          message: "This terminal generation is stale.",
        } as const;
      }
      if (command.type === "close") return yield* closeTerminal(command);
      if (current.closed) {
        return {
          type: "error",
          code: "terminal_not_open",
          message: "The terminal is closed.",
        } as const;
      }

      if (command.type === "clear") {
        yield* input.manager.clear({ threadId: input.threadId, terminalId: command.terminalId });
        return { type: "cleared" } as const;
      }

      if (command.type === "resize") {
        if (current.exited) {
          return {
            type: "error",
            code: "terminal_not_open",
            message: "The terminal process has exited.",
          } as const;
        }
        yield* input.manager.resize({
          threadId: input.threadId,
          terminalId: command.terminalId,
          cols: command.cols,
          rows: command.rows,
        });
        return { type: "resized" } as const;
      }

      if (current.exited) {
        return {
          type: "error",
          code: "terminal_not_open",
          message: "The terminal process has exited.",
        } as const;
      }

      const writeFingerprint = yield* fingerprint(command.data);
      const priorWrite = reports.checkWrite(command, writeFingerprint);
      if (priorWrite === "limit") {
        return {
          type: "error",
          code: "write_receipt_limit",
          message: "This terminal generation has reached its write receipt limit.",
        } as const;
      }
      if (priorWrite !== "new") {
        return priorWrite === "same"
          ? ({ type: "written" } as const)
          : ({
              type: "error",
              code: "command_id_conflict",
              message: "This terminal write ID was already used with different data.",
            } as const);
      }

      yield* input.manager.write({
        threadId: input.threadId,
        terminalId: command.terminalId,
        data: command.data,
      });
      reports.rememberWrite(command, writeFingerprint);
      return { type: "written" } as const;
    });

  const flushPending = (state: TerminalState, throughSequence: number) =>
    eventLock.withPermits(1)(
      Effect.gen(function* () {
        while (state.pendingReports.length > 0) {
          const report = state.pendingReports[0]!;
          if (report.sequence <= throughSequence) {
            state.pendingReports.shift();
            continue;
          }
          yield* input.emit(report);
          state.pendingReports.shift();
        }
        state.ready = true;
      }),
    );

  const reportSnapshots = eventLock.withPermits(1)(
    Effect.gen(function* () {
      for (const report of reports.snapshots(terminals.values())) {
        yield* input.emit(report).pipe(Effect.catchCause(() => Effect.void));
      }
    }),
  );

  const handleCommand: RunnerTerminals["handleCommand"] = (message) =>
    commandLock.withPermits(1)(
      Effect.gen(function* () {
        const state = terminals.get(message.command.terminalId);
        const prior =
          state?.generation === message.command.generation
            ? state.controlReceipts.get(message.requestId)
            : undefined;
        // A pending open can be replayed after a fit; a separate resize carries its new dimensions.
        const fingerprintCommand =
          message.command.type === "open"
            ? { ...message.command, cols: 1, rows: 1 }
            : message.command;
        const requestFingerprint = yield* fingerprint(encodeCommandJson(fingerprintCommand));
        if (prior !== undefined) {
          if (prior.fingerprint === requestFingerprint) {
            yield* input.emit(prior.report);
            if (message.command.type === "open" && prior.report.result.type === "opened") {
              const latest = terminals.get(message.command.terminalId);
              if (latest?.generation === message.command.generation) {
                yield* flushPending(latest, prior.report.result.snapshot.sequence ?? 0);
              }
            }
          } else {
            yield* input.emit({
              type: "result",
              requestId: message.requestId,
              terminalId: message.command.terminalId,
              generation: message.command.generation,
              leaseGeneration: message.command.leaseGeneration,
              ...(message.command.type === "write" ? { commandId: message.command.commandId } : {}),
              result: {
                type: "error",
                code: "request_id_conflict",
                message: "This terminal request ID was already used for another command.",
              },
            });
          }
          return;
        }

        const result = yield* runCommand(message.command).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            const connectionError =
              Option.isSome(error) && isRunnerConnectionError(error.value) ? error.value : null;
            if (connectionError !== null || message.command.type === "close") {
              return Effect.fail(
                connectionError !== null
                  ? connectionError
                  : new RunnerConnectionError({
                      message: "The terminal close could not finish. The close command will retry.",
                    }),
              );
            }
            return Effect.succeed({
              type: "error",
              code: "terminal_error",
              message: "The terminal command failed.",
            } as const);
          }),
        );
        const report: TerminalReport = {
          type: "result",
          requestId: message.requestId,
          terminalId: message.command.terminalId,
          generation: message.command.generation,
          leaseGeneration: message.command.leaseGeneration,
          ...(message.command.type === "write" ? { commandId: message.command.commandId } : {}),
          result,
        };
        const latest = terminals.get(message.command.terminalId);
        if (result.type !== "error" && latest?.generation === message.command.generation) {
          reports.rememberControlReceipt(latest, message.requestId, {
            fingerprint: requestFingerprint,
            report,
          });
        }
        yield* input.emit(report);

        if (message.command.type === "open" && result.type === "opened") {
          const state = terminals.get(message.command.terminalId);
          if (state?.generation === message.command.generation) {
            yield* flushPending(state, result.snapshot.sequence ?? 0);
          }
        } else if (message.command.type === "close" && result.type === "closed") {
          const state = terminals.get(message.command.terminalId);
          if (state?.generation === message.command.generation) yield* flushPending(state, 0);
        }
      }),
    );

  const replayEvents: RunnerTerminals["replayEvents"] = (activate) =>
    commandLock.withPermits(1)(
      eventLock.withPermits(1)(
        Effect.gen(function* () {
          yield* activate;
          for (const report of reports.replay(terminals.values())) yield* input.emit(report);
          for (const state of terminals.values()) {
            state.pendingReports = [];
            state.ready = true;
          }
        }),
      ),
    );

  const drain: RunnerTerminals["drain"] = Effect.gen(function* () {
    if (drive === null) return [];
    const changed = yield* Effect.result(drive.changed);
    if (changed._tag === "Failure") {
      return [`Saving this thread's files failed: ${saveFailureReason(changed.failure)}`];
    }
    if (!changed.success) return [];
    const saved = yield* Effect.result(drive.saveNow);
    return saved._tag === "Success"
      ? []
      : [`Saving this thread's files failed: ${saveFailureReason(saved.failure)}`];
  });

  const close = commandLock.withPermits(1)(
    Effect.gen(function* () {
      for (const state of terminals.values()) {
        state.unsubscribe?.();
        state.unsubscribe = null;
      }
      yield* input.manager
        .close({ threadId: input.threadId, deleteHistory: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to close Runner terminals", Cause.pretty(cause)),
          ),
        );
      const unsaved = yield* drain.pipe(
        Effect.timeoutOrElse({
          duration: "25 seconds",
          orElse: () => Effect.succeed(["Saving terminal files took longer than 25 seconds."]),
        }),
      );
      for (const message of unsaved) yield* Effect.logWarning(message);
    }),
  );
  yield* Effect.addFinalizer(() => close);

  return { handleCommand, replayEvents, drain };
});
