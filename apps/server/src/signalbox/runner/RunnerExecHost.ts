// @effect-diagnostics nodeBuiltinImport:off - native process bytes, exit signals and stdio live at this Runner boundary.
import * as NodeChildProcess from "node:child_process";
import { Buffer } from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeOs from "node:os";
import type { Readable } from "node:stream";

import type {
  ExecCommand,
  ExecCommandErrorCode,
  ExecCommandMessage,
  ExecReport,
  ExecReportMessage,
} from "@signalbox/runner-protocol/ExecProtocol";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makeRunnerExecProcessHost, type RunnerExecProcessHost } from "./RunnerExecProcessHost.ts";
import type { RunnerConnectionError } from "./RunnerConnectionError.ts";

const MAX_OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_RETAINED_OUTPUT_BYTES = 1024 * 1024;
const MAX_RETAINED_OUTPUT_REPORTS = 50_000;
const MAX_CONTROL_RECEIPTS = 65_536;
const MAX_WRITE_RECEIPTS = 65_536;
const MAX_PROCESSES = 4_096;
const MAX_ACTIVE_PROCESSES = 32;
const REPORT_HIGH_WATER = 256;
const REPORT_LOW_WATER = 128;

type SequencedReport = Extract<ExecReport, { readonly type: "output" | "exit" | "closed" }>;
type RunnerGeneration = Extract<ExecCommand, { readonly type: "start" }>["generation"];
type Pipe = Readable & { pause(): Readable; resume(): Readable };
type ProcessHandle = NodeChildProcess.ChildProcessWithoutNullStreams;

/** Per-thread proof that this generation's drive owns the requested canonical cwd. */
export interface RunnerExecWorkspaceAttestation {
  readonly attestCanonicalCwd: (input: {
    readonly threadId: ThreadId;
    readonly generation: RunnerGeneration;
    readonly cwd: string;
  }) => boolean;
}

interface ProcessState {
  readonly processId: string;
  readonly child: ProcessHandle;
  sequence: number;
  stdinClosed: boolean;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  exitReported: boolean;
  closed: boolean;
}

interface Receipt {
  readonly fingerprint: string;
  readonly result: Promise<ExecReport>;
}

/** A bounded in-memory replay of process output and its terminal events. */
class ExecEventLog {
  #events: Array<SequencedReport> = [];
  #bytes = 0;

  append(report: SequencedReport) {
    this.#events.push(report);
    this.#bytes += Buffer.byteLength(JSON.stringify(report));
    while (
      this.#events.length > MAX_RETAINED_OUTPUT_REPORTS ||
      this.#bytes > MAX_RETAINED_OUTPUT_BYTES
    ) {
      const dropped = this.#events.shift();
      if (dropped !== undefined) this.#bytes -= Buffer.byteLength(JSON.stringify(dropped));
    }
  }

  snapshot(): ReadonlyArray<SequencedReport> {
    return [...this.#events];
  }
}

/** Keeps native output bounded when the Runner socket cannot drain it quickly enough. */
class ReportMailbox implements AsyncIterable<ExecReport> {
  #reports: Array<ExecReport> = [];
  #waiters: Array<(result: IteratorResult<ExecReport>) => void> = [];
  #paused = new Set<Pipe>();
  #closed = false;

  offer(report: ExecReport, pipe?: Pipe) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: report });
      return;
    }
    // Acks can be retried by stable ID. Process output is retained separately and replayed.
    if (this.#reports.length >= REPORT_HIGH_WATER && pipe === undefined) return;
    this.#reports.push(report);
    if (pipe !== undefined && this.#reports.length >= REPORT_HIGH_WATER) {
      pipe.pause();
      this.#paused.add(pipe);
    }
  }

  close() {
    this.#closed = true;
    for (const pipe of this.#paused) pipe.resume();
    this.#paused.clear();
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecReport> {
    return {
      next: () => {
        const report = this.#reports.shift();
        if (report !== undefined) {
          if (this.#reports.length <= REPORT_LOW_WATER) {
            for (const pipe of this.#paused) pipe.resume();
            this.#paused.clear();
          }
          return Promise.resolve({ done: false, value: report });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

const fingerprint = (command: ExecCommand) =>
  // Reserve the ID synchronously before another socket frame can reuse it.
  NodeCrypto.createHash("sha256").update(JSON.stringify(command)).digest("hex");

const ERROR_MESSAGES = {
  stale_generation: "This Runner generation is stale.",
  request_id_conflict: "This request ID is already in use.",
  process_id_conflict: "This process ID is already in use.",
  request_receipt_limit: "This Runner generation reached its request receipt limit.",
  process_not_found: "The process does not exist.",
  process_exited: "The process has exited.",
  workspace_not_ready: "The canonical workspace mount is unavailable.",
  invalid_cwd: "The working directory is unavailable.",
  stdin_closed: "Process stdin is closed.",
  write_id_conflict: "This write ID is already in use.",
  write_receipt_limit: "This Runner generation reached its write receipt limit.",
  process_limit: "This Runner generation reached its process limit.",
  invalid_signal: "The requested signal is unavailable.",
  process_error: "The process operation failed.",
} satisfies Record<ExecCommandErrorCode, string>;

const operationOf = (command: ExecCommand) => (command.type === "start" ? "start" : command.type);

/** One Runner lease's non-PTY native process host. */
export interface RunnerExecHost {
  readonly handleCommand: (message: ExecCommandMessage) => Effect.Effect<void>;
  /** Newly produced reports; replayable output is retained separately. */
  readonly reports: Stream.Stream<ExecReport>;
  /** Re-sends bounded output/exit/closed history after a Runner socket reconnects. */
  readonly replayEvents: (
    emit: (message: ExecReportMessage) => Effect.Effect<void, RunnerConnectionError>,
  ) => Effect.Effect<void, RunnerConnectionError>;
}

export const makeRunnerExecHost = Effect.fn("makeRunnerExecHost")(function* (input: {
  readonly threadId: ThreadId;
  readonly generation: RunnerGeneration;
  /** Supplied only by the drive mount boundary; absent until canonical workspace mounts exist. */
  readonly workspace?: RunnerExecWorkspaceAttestation;
  /** Tests inject a fake mount/process adapter; production uses the actual `/workspace` mount. */
  readonly processHost?: RunnerExecProcessHost;
}): Effect.fn.Return<RunnerExecHost, never, Scope.Scope> {
  const processHost = input.processHost ?? makeRunnerExecProcessHost();
  const mailbox = new ReportMailbox();
  const eventLog = new ExecEventLog();
  const processes = new Map<string, ProcessState>();
  const controlReceipts = new Map<string, Receipt>();
  const writeReceipts = new Map<string, Receipt>();
  const stopped = { value: false };
  const knownSignals = new Set(Object.values(NodeOs.constants.signals));

  const nextSequence = (state: ProcessState) => ++state.sequence;
  const appendEvent = (report: SequencedReport) => {
    eventLog.append(report);
    mailbox.offer(report);
  };
  const ack = (
    command: ExecCommand,
    applied: boolean,
    code?: keyof typeof ERROR_MESSAGES,
  ): ExecReport => ({
    type: "ack",
    generation: command.generation,
    processId: command.processId,
    operation: operationOf(command),
    ...(command.type === "stdin.write"
      ? { writeId: command.writeId }
      : { requestId: command.requestId }),
    applied,
    ...(code === undefined ? {} : { error: { code, message: ERROR_MESSAGES[code] } }),
  });
  const failed = (command: ExecCommand, code: keyof typeof ERROR_MESSAGES) =>
    ack(command, false, code);
  const exitReport = (state: ProcessState, code: number | null, signal: NodeJS.Signals | null) => {
    if (state.exitReported) return;
    state.exitReported = true;
    if (code !== null) {
      appendEvent({
        type: "exit",
        generation: input.generation,
        processId: state.processId,
        sequence: nextSequence(state),
        exitCode: code,
      });
      return;
    }
    const signalNumber = signal === null ? undefined : NodeOs.constants.signals[signal];
    if (typeof signalNumber !== "number" || signalNumber <= 0) return;
    // Node exposes the terminating signal but not waitpid's core-dump bit.
    appendEvent({
      type: "exit",
      generation: input.generation,
      processId: state.processId,
      sequence: nextSequence(state),
      signal: signalNumber,
      coreDumped: false,
    });
  };
  const finishIfClosed = (state: ProcessState) => {
    if (!state.exitReported || !state.stdoutEnded || !state.stderrEnded || state.closed) return;
    state.closed = true;
    appendEvent({
      type: "closed",
      generation: input.generation,
      processId: state.processId,
      sequence: nextSequence(state),
    });
  };
  const reportOutput = (
    state: ProcessState,
    stream: "stdout" | "stderr",
    bytes: Buffer,
    pipe: Pipe,
  ) => {
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_OUTPUT_CHUNK_BYTES) {
      const dataBase64 = bytes.subarray(offset, offset + MAX_OUTPUT_CHUNK_BYTES).toString("base64");
      const report: SequencedReport = {
        type: "output",
        generation: input.generation,
        processId: state.processId,
        sequence: nextSequence(state),
        stream,
        dataBase64,
      };
      eventLog.append(report);
      mailbox.offer(report, pipe);
    }
  };

  const apply = async (command: ExecCommand): Promise<ExecReport> => {
    if (command.generation !== input.generation) return failed(command, "stale_generation");
    const state = processes.get(command.processId);
    if (command.type === "start") {
      if (stopped.value) return failed(command, "process_error");
      if (processes.has(command.processId)) return failed(command, "process_id_conflict");
      if (
        processes.size >= MAX_PROCESSES ||
        [...processes.values()].filter((process) => !process.closed).length >= MAX_ACTIVE_PROCESSES
      ) {
        return failed(command, "process_limit");
      }
      if (
        input.workspace?.attestCanonicalCwd({
          threadId: input.threadId,
          generation: input.generation,
          cwd: command.cwd,
        }) !== true
      ) {
        return failed(command, "workspace_not_ready");
      }
      const workingDirectory = processHost.resolveWorkingDirectory(command.cwd);
      if (workingDirectory._tag === "workspace_not_ready") {
        return failed(command, "workspace_not_ready");
      }
      if (workingDirectory._tag === "invalid_cwd") return failed(command, "invalid_cwd");
      let child: ProcessHandle;
      try {
        child = processHost.spawn(command, workingDirectory.cwd);
      } catch {
        return failed(command, "process_error");
      }
      const process: ProcessState = {
        processId: command.processId,
        child,
        sequence: 0,
        stdinClosed: false,
        stdoutEnded: false,
        stderrEnded: false,
        exitReported: false,
        closed: false,
      };
      processes.set(command.processId, process);
      let spawned = false;
      const started = new Promise<ExecReport>((resolve) => {
        child.once("spawn", () => {
          spawned = true;
          resolve(ack(command, true));
        });
        child.on("error", () => {
          if (spawned) return;
          process.closed = true;
          resolve(failed(command, "process_error"));
        });
      });
      child.stdout.on("data", (chunk: Buffer | Uint8Array) =>
        reportOutput(process, "stdout", Buffer.from(chunk), child.stdout),
      );
      child.stderr.on("data", (chunk: Buffer | Uint8Array) =>
        reportOutput(process, "stderr", Buffer.from(chunk), child.stderr),
      );
      child.stdout.once("end", () => {
        process.stdoutEnded = true;
        finishIfClosed(process);
      });
      child.stderr.once("end", () => {
        process.stderrEnded = true;
        finishIfClosed(process);
      });
      child.once("exit", (code, signal) => exitReport(process, code, signal));
      child.once("close", (code, signal) => {
        exitReport(process, code, signal);
        process.stdoutEnded = true;
        process.stderrEnded = true;
        finishIfClosed(process);
      });
      return started;
    }

    if (state === undefined) return failed(command, "process_not_found");
    if (state.closed || state.child.exitCode !== null || state.child.signalCode !== null) {
      return failed(command, "process_exited");
    }
    if (command.type === "stdin.write") {
      if (state.stdinClosed || state.child.stdin.destroyed || state.child.stdin.writableEnded) {
        return failed(command, "stdin_closed");
      }
      const chunk = Buffer.from(command.dataBase64, "base64");
      return new Promise((resolve) => {
        state.child.stdin.write(chunk, (error) =>
          resolve(error == null ? ack(command, true) : failed(command, "process_error")),
        );
      });
    }
    if (command.type === "stdin.close") {
      if (state.stdinClosed || state.child.stdin.destroyed || state.child.stdin.writableEnded) {
        return failed(command, "stdin_closed");
      }
      state.stdinClosed = true;
      return new Promise((resolve) => {
        state.child.stdin.end(() => resolve(ack(command, true)));
        state.child.stdin.once("error", () => resolve(failed(command, "process_error")));
      });
    }
    if (command.type === "signal" && command.signal !== 0 && !knownSignals.has(command.signal)) {
      return failed(command, "invalid_signal");
    }
    try {
      const sent =
        command.type === "cancel" ? state.child.kill("SIGTERM") : state.child.kill(command.signal);
      return sent ? ack(command, true) : failed(command, "process_exited");
    } catch {
      return failed(command, command.type === "signal" ? "invalid_signal" : "process_error");
    }
  };

  const handleCommand = (message: ExecCommandMessage) =>
    Effect.promise(async () => {
      const command = message.command;
      if (command.type === "stdin.write") {
        const inputFingerprint = fingerprint(command);
        const prior = writeReceipts.get(command.writeId);
        if (prior !== undefined) {
          mailbox.offer(
            prior.fingerprint === inputFingerprint
              ? await prior.result
              : failed(command, "write_id_conflict"),
          );
          return;
        }
        if (writeReceipts.size >= MAX_WRITE_RECEIPTS) {
          mailbox.offer(failed(command, "write_receipt_limit"));
          return;
        }
        const result = apply(command);
        writeReceipts.set(command.writeId, { fingerprint: inputFingerprint, result });
        mailbox.offer(await result);
        return;
      }
      const inputFingerprint = fingerprint(command);
      const prior = controlReceipts.get(command.requestId);
      if (prior !== undefined) {
        mailbox.offer(
          prior.fingerprint === inputFingerprint
            ? await prior.result
            : failed(command, "request_id_conflict"),
        );
        return;
      }
      if (controlReceipts.size >= MAX_CONTROL_RECEIPTS) {
        mailbox.offer(failed(command, "request_receipt_limit"));
        return;
      }
      const result = apply(command);
      controlReceipts.set(command.requestId, { fingerprint: inputFingerprint, result });
      mailbox.offer(await result);
    });

  const replayEvents: RunnerExecHost["replayEvents"] = (emit) =>
    Effect.forEach(eventLog.snapshot(), (report) => emit({ type: "exec.report", report })).pipe(
      Effect.asVoid,
    );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopped.value = true;
      const active = [...processes.values()].filter((process) => !process.closed);
      for (const process of active) {
        try {
          process.child.kill("SIGTERM");
        } catch {
          // Exiting children need no second shutdown path.
        }
      }
      yield* Effect.promise(() =>
        Promise.all(
          active.map((process) =>
            process.closed
              ? Promise.resolve()
              : new Promise<void>((resolve) => process.child.once("close", () => resolve())),
          ),
        ),
      ).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.void,
        }),
      );
      for (const process of active) {
        if (!process.closed) {
          try {
            process.child.kill("SIGKILL");
          } catch {
            // The host is already closing; there is no later command to retry.
          }
        }
      }
      mailbox.close();
    }),
  );

  const reports = Stream.fromAsyncIterable(mailbox, (cause): never => {
    throw cause;
  });
  return { handleCommand, reports, replayEvents };
});
