// @effect-diagnostics nodeBuiltinImport:off - Passive tracing uses Node's errorMonitor event.
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";

import type { NodeChildProcess } from "../childProcess/ChildProcess.ts";
import type { NormalizedSpawn } from "../childProcess/arguments.ts";
import { prepareOutputCapture, type OutputResult, type PreparedOutputCapture } from "./output.ts";
import { serializeTraceArgs, serializeTraceValue } from "./serialize.ts";
import type {
  NodeChildProcessTraceChildSnapshot,
  NodeChildProcessTraceOptions,
  NodeChildProcessTraceRecorder,
  NodeChildProcessTraceSnapshot,
  NodeChildProcessTraceNormalizedSpawn,
  TraceChildEventKind,
  TracePresence,
} from "./types.ts";
import {
  createTraceStreamState,
  observeChildStream,
  traceStreamSnapshot,
  type TraceChildStreams,
} from "./streams.ts";
import { ChildProcessTraceWriter } from "./writer.ts";

interface ChildState {
  readonly childId: string;
  spawned: boolean;
  closed: boolean;
  errorEvents: number;
  exitArgs?: readonly Readonly<Record<string, unknown>>[];
  closeArgs?: readonly Readonly<Record<string, unknown>>[];
  admittedHandle?: { readonly id: string; readonly kind: string };
  readonly streams: TraceChildStreams;
  readonly outputs: OutputResult[];
}

export function createNodeChildProcessTrace(
  options: NodeChildProcessTraceOptions,
): NodeChildProcessTraceRecorder {
  if (typeof options.processKey !== "string" || options.processKey.length === 0) {
    throw new TypeError("child process trace requires a stable process key");
  }
  if (
    typeof options.files !== "function" ||
    typeof options.record !== "function" ||
    typeof options.writeOutputChunk !== "function" ||
    typeof options.finishOutput !== "function"
  ) {
    throw new TypeError("child process trace requires filesystem and durable writer callbacks");
  }

  const children = new Map<string, ChildState>();
  const writer = new ChildProcessTraceWriter(options);
  const instanceId = NodeCrypto.randomUUID();
  let childSequence = 0;

  const observeChildProcess = (child: NodeChildProcess, spawn: NormalizedSpawn): void => {
    const childId = `${options.processKey}:${instanceId}:${++childSequence}`;
    const state: ChildState = {
      childId,
      spawned: false,
      closed: false,
      errorEvents: 0,
      streams: {
        stdin: createTraceStreamState(child.stdin !== null),
        stdout: createTraceStreamState(child.stdout !== null),
        stderr: createTraceStreamState(child.stderr !== null),
      },
      outputs: [],
    };
    children.set(childId, state);

    observe(childId, "spawn-request", () => ({
      normalizedSpawn: normalizedSpawnRecord(spawn),
      admission: {
        pid: presentValue(child.pid),
        handle: presentHandle(child.processHandle),
      },
    }));

    let outputCapture: PreparedOutputCapture = {
      captureAfterClose: async () => [],
      releaseWithoutCapture: async () => [],
    };
    try {
      outputCapture = prepareOutputCapture({
        processKey: options.processKey,
        childId,
        spawn,
        files: options.files,
        emit: (fields) => {
          const {
            eventKind: _eventKind,
            processKey: _processKey,
            childId: _childId,
            ...body
          } = fields;
          observe(childId, "output", () => body);
        },
        remember: (output) => state.outputs.push(output),
        track: (job) => writer.track(job, childId),
        onFailure: (operation, outputId, error) =>
          writer.addError({
            operation,
            childId,
            outputId,
            error,
          }),
        writeOutputChunk: options.writeOutputChunk,
        finishOutput: options.finishOutput,
      });
    } catch (error) {
      writer.addError({ operation: "capture-output", childId, error });
      observe(childId, "output", () => ({ status: "gap", reason: "capture-setup-failed" }));
    }

    try {
      child.on(NodeEvents.errorMonitor, (...args: unknown[]) => {
        state.errorEvents += 1;
        observe(childId, "error", () => ({ args: serializeTraceArgs(args) }));
      });
      child.once("spawn", () => {
        state.spawned = true;
        const handle = child.processHandle;
        if (handle !== undefined) state.admittedHandle = { id: handle.id, kind: handle.kind };
        observe(childId, "spawn", () => ({
          pid: presentValue(child.pid),
          handle: presentHandle(handle),
        }));
      });
      child.on("exit", (...args: unknown[]) => {
        state.exitArgs = serializeTraceArgs(args);
        observe(childId, "exit", () => ({
          args: state.exitArgs,
          exitCode: serializeTraceValue(child.exitCode),
          signalCode: serializeTraceValue(child.signalCode),
        }));
      });
      observeChildStream(child, childId, "stdin", state.streams.stdin, observe);
      observeChildStream(child, childId, "stdout", state.streams.stdout, observe);
      observeChildStream(child, childId, "stderr", state.streams.stderr, observe);
      child.once("close", (...args: unknown[]) => {
        state.closed = true;
        state.closeArgs = serializeTraceArgs(args);
        observe(childId, "close", () => ({
          args: state.closeArgs,
          processHandleAtClose: presentHandle(child.processHandle),
          pid: presentValue(child.pid),
        }));
        writer.track(
          (async () => {
            let outputResults: readonly OutputResult[] = [];
            try {
              outputResults = state.spawned
                ? await outputCapture.captureAfterClose()
                : await outputCapture.releaseWithoutCapture("child-never-emitted-spawn");
            } catch (error) {
              writer.addError({ operation: "capture-output", childId, error });
            }
            observe(childId, "terminal-summary", () => ({
              status: {
                pid: presentValue(child.pid),
                processHandle:
                  state.admittedHandle === undefined
                    ? { present: false, value: serializeTraceValue(undefined) }
                    : { present: true, value: state.admittedHandle },
                processHandleAtClose: presentHandle(child.processHandle),
                exitCode: serializeTraceValue(child.exitCode),
                signalCode: serializeTraceValue(child.signalCode),
                timedOut: child.timedOut,
              },
              events: {
                spawn: state.spawned,
                exit: state.exitArgs !== undefined,
                close: state.closeArgs !== undefined,
                errorEvents: state.errorEvents,
                errorEventObserved: state.errorEvents > 0,
              },
              streams: traceStreamSnapshot(state.streams),
              outputResults,
            }));
          })(),
          childId,
        );
      });
    } catch (error) {
      writer.addError({ operation: "record", childId, error });
    }
  };

  const onChildProcess = (child: NodeChildProcess, spawn: NormalizedSpawn): void => {
    try {
      observeChildProcess(child, spawn);
    } catch (error) {
      try {
        writer.addError({ operation: "record", childId: "observer-initialization", error });
      } catch {
        // Observer failures stay local and never alter child-process results.
      }
    }
  };

  return Object.freeze({
    onChildProcess,
    drain: () => writer.drain(),
    snapshot: () => snapshot(options.processKey, children, writer.writerErrors),
  });

  function observe(
    childId: string,
    eventKind: TraceChildEventKind,
    fields: () => Readonly<Record<string, unknown>>,
  ): void {
    writer.observe(options.processKey, childId, eventKind, fields);
  }
}

function normalizedSpawnRecord(spawn: NormalizedSpawn): NodeChildProcessTraceNormalizedSpawn {
  const signal = spawn.signal;
  return {
    spawnfile: spawn.spawnfile,
    executable: spawn.executable,
    argv: [...spawn.argv],
    cwd: spawn.cwd,
    env: { ...spawn.env },
    stdio: [...spawn.stdio],
    signal:
      signal === undefined
        ? { present: false }
        : {
            present: true,
            aborted: signal.aborted,
            reason: serializeTraceValue(signal.reason),
          },
    timeout: spawn.timeout,
    killSignal: spawn.killSignal,
  };
}

function presentValue(value: unknown): TracePresence<Readonly<Record<string, unknown>>> {
  return value === undefined
    ? { present: false, value: serializeTraceValue(undefined) }
    : { present: true, value: serializeTraceValue(value) };
}

function presentHandle(
  handle: { readonly id: string; readonly kind: string } | undefined,
): TracePresence<{ readonly id: string; readonly kind: string }> {
  return handle === undefined
    ? { present: false, value: serializeTraceValue(undefined) }
    : { present: true, value: { id: handle.id, kind: handle.kind } };
}

function snapshot(
  processKey: string,
  children: ReadonlyMap<string, ChildState>,
  writerErrors: NodeChildProcessTraceSnapshot["writerErrors"],
): NodeChildProcessTraceSnapshot {
  const childSnapshots: NodeChildProcessTraceChildSnapshot[] = [...children.values()].map(
    (child) => ({
      childId: child.childId,
      spawned: child.spawned,
      closed: child.closed,
      errorEvents: child.errorEvents,
      outputs: child.outputs.map((output) => ({ ...output })),
    }),
  );
  return {
    processKey,
    children: childSnapshots,
    writerErrors: writerErrors.map((error) => ({ ...error })),
  };
}
