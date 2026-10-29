import type { NodeChildProcess } from "../childProcess/ChildProcess.ts";
import type { NormalizedSpawn } from "../childProcess/arguments.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import type { SerializedTraceValue } from "./serialize.ts";

export type TraceChildEventKind =
  | "spawn-request"
  | "spawn"
  | "error"
  | "exit"
  | "close"
  | "stream"
  | "output"
  | "terminal-summary";

export interface TraceTiming {
  readonly observedAtWallTimeMs: number;
  readonly observedAtMonotonicMs: number;
  readonly captureStartedAtWallTimeMs: number;
  readonly captureCompletedAtWallTimeMs: number;
  readonly captureDurationMs: number;
}

interface NodeChildProcessTraceEventBase {
  readonly processKey: string;
  readonly childId: string;
  readonly sequence: number;
  readonly timing: TraceTiming;
}

export interface NodeChildProcessTraceNormalizedSpawn {
  readonly spawnfile: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: readonly ("pipe" | "ignore" | number)[];
  readonly signal:
    | { readonly present: false }
    | { readonly present: true; readonly aborted: boolean; readonly reason: SerializedTraceValue };
  readonly timeout: number;
  readonly killSignal: number;
}

export type TracePresence<T> =
  | { readonly present: false; readonly value: SerializedTraceValue }
  | { readonly present: true; readonly value: T };

export type NodeChildProcessTraceEvent = NodeChildProcessTraceEventBase &
  (
    | {
        readonly eventKind: "spawn-request";
        readonly normalizedSpawn: NodeChildProcessTraceNormalizedSpawn;
        readonly admission: {
          readonly pid: TracePresence<SerializedTraceValue>;
          readonly handle: TracePresence<{ readonly id: string; readonly kind: string }>;
        };
      }
    | {
        readonly eventKind: "spawn";
        readonly pid: TracePresence<SerializedTraceValue>;
        readonly handle: TracePresence<{ readonly id: string; readonly kind: string }>;
      }
    | { readonly eventKind: "error"; readonly args: readonly SerializedTraceValue[] }
    | {
        readonly eventKind: "exit";
        readonly args: readonly SerializedTraceValue[];
        readonly exitCode: SerializedTraceValue;
        readonly signalCode: SerializedTraceValue;
      }
    | {
        readonly eventKind: "close";
        readonly args: readonly SerializedTraceValue[];
        readonly processHandleAtClose: TracePresence<{
          readonly id: string;
          readonly kind: string;
        }>;
        readonly pid: TracePresence<SerializedTraceValue>;
      }
    | {
        readonly eventKind: "stream";
        readonly stream: "stdin" | "stdout" | "stderr";
        readonly eventName: "end" | "finish" | "close" | "error";
        readonly args: readonly SerializedTraceValue[];
      }
    | ({ readonly eventKind: "output" } & Readonly<Record<string, unknown>>)
    | {
        readonly eventKind: "terminal-summary";
        readonly status: Readonly<Record<string, unknown>>;
        readonly events: Readonly<Record<string, unknown>>;
        readonly streams: Readonly<Record<string, unknown>>;
        readonly outputResults: readonly Readonly<Record<string, unknown>>[];
      }
  );

export interface NodeChildProcessTraceOutputMetadata {
  readonly outputId: string;
  readonly processKey: string;
  readonly childId: string;
  readonly streams: readonly ("stdout" | "stderr")[];
  readonly streamLabel: "stdout" | "stderr" | "combined";
  readonly mountId: number;
  readonly mountPath: string;
  readonly inode: string;
  readonly paths: readonly {
    readonly fd: number;
    readonly pathComponents: readonly string[] | null;
  }[];
  readonly originalSize: string;
  readonly bytesCaptured: number;
  readonly fullHash: boolean;
  readonly stable: boolean;
  readonly sha256?: string;
}

export type NodeChildProcessTraceLocator = string | { readonly locator: string };

export interface NodeChildProcessTraceSink {
  readonly record: (event: NodeChildProcessTraceEvent) => void | Promise<void>;
  readonly writeOutputChunk: (outputId: string, bytes: Uint8Array) => void | Promise<void>;
  readonly finishOutput: (
    metadata: NodeChildProcessTraceOutputMetadata,
  ) => NodeChildProcessTraceLocator | Promise<NodeChildProcessTraceLocator>;
}

export interface NodeChildProcessTraceOptions extends NodeChildProcessTraceSink {
  readonly processKey: string;
  /** Resolved only when a child uses a numeric stdout or stderr descriptor. */
  readonly files: () => KernelFileSystem;
}

export interface NodeChildProcessTraceWriterError {
  readonly operation: "record" | "write-output-chunk" | "finish-output" | "capture-output";
  readonly childId: string;
  readonly eventKind?: TraceChildEventKind;
  readonly outputId?: string;
  readonly error: unknown;
}

export interface NodeChildProcessTraceSnapshot {
  readonly processKey: string;
  readonly children: readonly NodeChildProcessTraceChildSnapshot[];
  readonly writerErrors: readonly NodeChildProcessTraceWriterError[];
}

export interface NodeChildProcessTraceChildSnapshot {
  readonly childId: string;
  readonly spawned: boolean;
  readonly closed: boolean;
  readonly errorEvents: number;
  readonly outputs: readonly Readonly<Record<string, unknown>>[];
}

export interface NodeChildProcessTraceRecorder {
  readonly onChildProcess: (child: NodeChildProcess, spawn: NormalizedSpawn) => void;
  readonly drain: () => Promise<void>;
  readonly snapshot: () => NodeChildProcessTraceSnapshot;
}
